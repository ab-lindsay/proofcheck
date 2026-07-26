import { NextResponse } from "next/server";
import sharp from "sharp";
import { ApplicationDataSchema, ExtractedLabelSchema } from "@/lib/schema";
import { selectProvider, selectCloudProvider, providerByName } from "@/lib/vision/select";
import { withFallback, withProviderTimeout } from "@/lib/vision/fallback";
import { CLOUD_PRIMARY_TIMEOUT_MS } from "@/lib/vision/model-extraction";
import { LADDER_BUDGET_MS, withEscalation } from "@/lib/vision/escalation/escalate";
import { isGenuineSample } from "@/lib/vision/sample-hashes";
import { verifyLabel } from "@/lib/matching/verify";
import { rateLimit } from "@/lib/rate-limit";
import type { VisionProvider } from "@/lib/vision/types";

export const runtime = "nodejs";

const MAX_BYTES = 8 * 1024 * 1024;
// Cap the whole request from its declared Content-Length before req.formData() buffers it. Vercel's
// ~4.5 MB platform cap fires first in production, but off-Vercel (self-hosted / pnpm dev) nothing bounds
// the body — so reject early rather than buffer a huge multipart payload into memory. Headroom over
// MAX_BYTES covers the application JSON field and multipart boundaries.
const MAX_REQUEST_BYTES = MAX_BYTES + 1024 * 1024;
// Bound the DECODED raster, not just the compressed bytes: a ~1 MB uniform PNG can declare a
// multi-gigabyte raster (decompression bomb) that OOM-kills the instance or pegs the shared OCR worker.
// 25 MP comfortably covers a 300-dpi US-letter scan (~8.4 MP); anything larger is rejected before any tier.
const MAX_PIXELS = 25_000_000;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const EXTRACT_TIMEOUT_MS = 8_000; // hard deadline (threat model LLM10); under Vercel Hobby's ~10 s cap
// "auto" is accepted but intentionally has no branch below: it falls through to the same
// selectProvider() path a request with no devTier takes, so bundled samples still resolve to their
// mock fixtures and toggling dev mode never changes a verdict.
const DEV_TIERS = new Set(["auto", "local-ocr", "local-llm", "cloud"]);
const VALID_BEDROCK_MODELS = new Set(["haiku", "opus"]);
const BEDROCK_MODEL_MAP: Record<string, string> = {
  haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  opus: "us.anthropic.claude-opus-4-5-20251101-v1:0",
};

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  // clearTimeout in finally so a fast success/failure doesn't leave the deadline timer holding the event
  // loop open (matters on serverless, where a dangling timer can delay/complicate teardown).
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Magic-byte sniff (threat model A05): declared MIME must match actual content. */
function sniffMime(b: Buffer): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  return null;
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** mock/local-ocr/local-llm report their own name as the tier; every other provider is "cloud". */
function tierFor(providerName: string): string {
  if (providerName === "mock" || providerName === "local-ocr" || providerName === "local-llm") return providerName;
  return "cloud";
}

/** Lets the dev-mode tier switcher know whether "Cloud" is actually usable, without exposing which provider or any key material. */
export async function GET() {
  return NextResponse.json({ cloudAvailable: selectCloudProvider() !== null });
}

export async function POST(req: Request) {
  // The brief's 5 s budget is end-to-end, so the escalation ladder's clock starts here — where the
  // request did — not at `started` below (which begins after validation). Must stay the first
  // Date.now() call in the handler (route.escalation.test.ts pins the budget arithmetic to it).
  const requestStart = Date.now();

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const limit = rateLimit(ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const rawLength = req.headers.get("content-length");
  if (rawLength === null) {
    // Missing Content-Length: a client using chunked encoding can send an arbitrarily large body
    // that bypasses the pre-check. Reject in production; allow in dev/test for tooling convenience.
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "Request too large — the image must be at most 8 MB." }, { status: 413 });
    }
  } else {
    const declaredLength = Number(rawLength);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: "Request too large — the image must be at most 8 MB." }, { status: 413 });
    }
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("Expected multipart form data with an image and application fields.");
  }

  const image = form.get("image");
  const appRaw = form.get("application");
  if (!(image instanceof File) || typeof appRaw !== "string") {
    return bad("Missing the label image or the application data.");
  }
  if (!ALLOWED_TYPES.has(image.type)) {
    return bad(`Unsupported format (${image.type ?? "unknown"}). Please upload a PNG, JPEG, or WebP image.`);
  }
  if (image.size === 0 || image.size > MAX_BYTES) {
    return bad("Image must be non-empty and at most 8 MB.");
  }

  let appJson: unknown;
  try {
    appJson = JSON.parse(appRaw);
  } catch {
    return bad("Application data is not valid JSON.");
  }
  const parsed = ApplicationDataSchema.safeParse(appJson);
  if (!parsed.success) {
    return bad(`Application data is incomplete: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }

  const buffer = Buffer.from(await image.arrayBuffer());
  if (sniffMime(buffer) !== image.type) {
    return bad("The file's content does not match its declared image type — upload a real PNG, JPEG, or WebP.");
  }

  // Decompression-bomb guard (threat model DoS): read the header only (no full decode) and reject before
  // any tier touches the raster. metadata() parses dimensions without allocating width×height×channels.
  let width = 0;
  let height = 0;
  try {
    ({ width = 0, height = 0 } = await sharp(buffer).metadata());
  } catch {
    return bad("Could not read this image — please upload a valid PNG, JPEG, or WebP.");
  }
  const pixels = width * height;
  if (pixels <= 0 || pixels > MAX_PIXELS) {
    return bad(
      `This image is too large to process — its dimensions exceed ${MAX_PIXELS / 1_000_000} megapixels. Downscale it and try again.`,
    );
  }

  // Trusted-sample gate (security sweep): the mock tier may be reached ONLY when the client says
  // source=sample AND the uploaded bytes ARE a genuine bundled sample (content hash). `source` and the
  // filename are both client-controlled, so checking them alone let a caller force a fabricated mock
  // APPROVED for arbitrary artwork; the byte-hash makes that impossible — a spoofed upload hashes to
  // nothing known and falls through to real extraction (local-ocr / cloud), never mock.
  const sampleName = form.get("source") === "sample" && isGenuineSample(image.name, buffer) ? image.name : undefined;
  const devTierRaw = form.get("devTier");
  const devBedrockModelRaw = form.get("devBedrockModel");
  const escalateRaw = form.get("escalate");
  // Dev-only cost multipliers (D8c, 2026-07-25 hardening): devTier/devBedrockModel bypass normal
  // tier selection and escalate=1 triggers the (costlier) escalation ladder, all three previously
  // honored anonymously and for free. DEV_CONTROLS_ENABLED must be explicitly set in production for
  // any of them to do anything; a production deploy that forgets it fails closed (400) instead of
  // silently accepting an anonymous cost-multiplying request. Always on outside production so local
  // dev and the dev-mode tier switcher keep working with no extra setup.
  const devControlsEnabled = process.env.NODE_ENV !== "production" || process.env.DEV_CONTROLS_ENABLED === "1";
  if (!devControlsEnabled && (devTierRaw !== null || devBedrockModelRaw !== null || escalateRaw !== null)) {
    return NextResponse.json(
      { error: "Developer controls (tier override, model override, escalation) are disabled in this deployment." },
      { status: 400 },
    );
  }
  const devTier = typeof devTierRaw === "string" && DEV_TIERS.has(devTierRaw) ? devTierRaw : undefined;
  const devBedrockModel =
    devControlsEnabled && typeof devBedrockModelRaw === "string" && VALID_BEDROCK_MODELS.has(devBedrockModelRaw)
      ? devBedrockModelRaw
      : undefined;

  const started = Date.now();
  let provider: VisionProvider | undefined;
  let fellBackToLocalOcr = false;
  try {
    if (devTier === "local-ocr") {
      provider = providerByName("local-ocr");
    } else if (devTier === "local-llm") {
      provider = providerByName("local-llm");
    } else if (devTier === "cloud") {
      const cloud = selectCloudProvider();
      if (!cloud) {
        return NextResponse.json(
          { error: "Cloud tier requires an API key configured on the server." },
          { status: 400 },
        );
      }
      provider = cloud;
    } else {
      // Provider selection can throw (e.g. VISION_PROVIDER=mock in production) — keep it inside the try so
      // a misconfiguration fails closed with a friendly 5xx, never a raw 500 or a fabricated verdict.
      provider = selectProvider(sampleName);
    }

    // If bedrock is selected and devBedrockModel is present, wrap the provider to pass the model override.
    if (provider?.name === "bedrock" && devBedrockModel) {
      const originalExtract = provider.extract.bind(provider);
      const modelId = BEDROCK_MODEL_MAP[devBedrockModel];
      provider = {
        ...provider,
        extract: (image, meta) => originalExtract(image, meta, { modelOverride: modelId }),
      };
    }

    // The escalation ladder re-reads only weakly-extracted fields. It is a VisionProvider itself,
    // so every tier's output still crosses exactly one validated boundary here (architecture rule 2).
    // Composition: withFallback(withEscalation(cloud), withEscalation(localOcr)) — fallback OVER
    // escalation (review 2026-07-25) — so a repair always re-reads on the tier that produced its
    // baseline (a cross-tier merge would arbitrate values with incomparable confidence scales),
    // the fallback warning fires only when the BASELINE itself fell back (a failed repair fails
    // closed to its baseline inside the ladder), and trace.tier names the tier that actually ran.
    //
    // OFF by default — an evidence-based decision, not an oversight. Measured 2026-07-25 with the
    // ladder genuinely in the path: it costs ~75% more latency and ~55% more model calls, and pushes
    // BOTH the cloud tier (real photos p95 4771 ms, max 5089 ms) and the keyless default tier (real
    // photos p95 4539 ms, max 6615 ms) past the brief's 5 s requirement — while delivering a
    // measured NULL accuracy gain (bedrock median 33/46 vs 34/46 baseline, inside run-to-run noise;
    // local-ocr 23/46 either way with zero labels improved). A cost with no demonstrated benefit
    // does not belong in the default path.
    //
    // Kept and still exercised (tests, `pnpm eval`, dev mode) because the subsystem and its null
    // result are the useful artifacts. Two opt-ins, neither of which can weaken a verdict — the
    // ladder only ever produces more extractions, and matching stays the sole judge:
    //   - ESCALATION_ENABLED=1 (server env) turns it on for every request;
    //   - the dev-mode "Re-read weak fields" switch sends escalate=1 per request, so a reviewer can watch the
    //     agentic loop work on the deployed URL without a redeploy.
    // See docs/superpowers/plans/2026-07-24-escalation-eval-results.md.
    // escalateRaw is only ever "1" here when devControlsEnabled was true above (otherwise the
    // early 400 already fired), so this needs no further gating.
    const escalationOn = process.env.ESCALATION_ENABLED === "1" || escalateRaw === "1";
    const ladderOpts = {
      maxAttempts: escalationOn ? undefined : 0,
      budgetMs: Math.max(0, LADDER_BUDGET_MS - (Date.now() - requestStart)),
    };
    let escalating = withEscalation(provider, ladderOpts);
    if (tierFor(provider.name) === "cloud") {
      // Composition-site timeout (review finding W1, D3 2026-07-25 hardening): the outer
      // EXTRACT_TIMEOUT_MS below wraps the WHOLE composition, so before this fix a primary that
      // hung never let withFallback's catch fire — it rode straight to the 8s 504. Racing the
      // primary against its own shorter deadline means a hang REJECTS at 6s, withFallback catches
      // it like any other failure, and local-ocr still has ~2s of the outer budget (warm ~372ms,
      // cold ~1409ms). EXEMPTION: an explicit dev model override means the user deliberately chose
      // a slower model (Opus p95 ~7.6s would never fit the cap) — honor that and let the outer
      // timeout backstop it. Production access to devBedrockModel is gated above (D8c).
      const primary = devBedrockModel ? escalating : withProviderTimeout(escalating, CLOUD_PRIMARY_TIMEOUT_MS);
      escalating = withFallback(primary, withEscalation(providerByName("local-ocr"), ladderOpts), () => {
        fellBackToLocalOcr = true;
      });
    }
    const { label, trace } = await withTimeout(
      escalating.extractWithTrace(buffer, { filename: image.name, mimeType: image.type }),
      EXTRACT_TIMEOUT_MS,
    );
    // trace.tier is the tier that actually produced the extraction (the fallback ladder's name
    // when the baseline fell back) — the static provider name would misattribute a fallen-back run.
    const ranProvider = trace.tier;
    const tier = tierFor(ranProvider);
    const extracted = ExtractedLabelSchema.parse(label);
    const result = verifyLabel(parsed.data, extracted);
    if (ranProvider === "local-ocr" && !fellBackToLocalOcr) {
      result.warnings.push(
        "Extracted with local OCR (no cloud model) — lower accuracy; low-confidence fields are flagged for review.",
      );
    }
    if (fellBackToLocalOcr) {
      result.warnings.push("Cloud extraction failed — fell back to local OCR.");
    }
    return NextResponse.json({
      ...result,
      processingMs: Date.now() - started,
      tier,
      provider: ranProvider,
      beverageType: parsed.data.beverageType,
      extraction: trace,
    });
  } catch (e) {
    if (e instanceof TimeoutError) {
      return NextResponse.json(
        { error: "Verification took too long — try a smaller or clearer image, or try again." },
        { status: 504 },
      );
    }
    // A thrown value may not be an object (throw null, throw "string"), so hoist the property read to
    // where it's null-safe. The app/api/batch route has the identical guard and the batch tests
    // exercise the throw-null path; this route has not yet received the same test coverage.
    const errStatus = typeof e === "object" && e !== null ? (e as { status?: number }).status : undefined;
    if (errStatus === 429) {
      return NextResponse.json(
        { error: "The extraction service is rate-limited right now — try again in a few seconds." },
        { status: 429 },
      );
    }
    if (provider?.name === "local-llm") {
      console.error("local-llm verify failed:", e instanceof Error ? e.message : e);
      return NextResponse.json(
        { error: "Local LLM extraction failed — is Ollama running and reachable?" },
        { status: 502 },
      );
    }
    console.error("verify failed:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: "Could not analyze this label image. Try a clearer image, or try again in a moment." },
      { status: 502 },
    );
  }
}
