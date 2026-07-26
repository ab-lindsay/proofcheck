import { NextResponse } from "next/server";
import sharp from "sharp";
import { ApplicationDataSchema, ExtractedLabelSchema } from "@/lib/schema";
import { BatchResponseSchema, type BatchRowResult } from "@/lib/batch-schema";
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
/**
 * Whole-request ceiling, and it has to be a number the platform can actually exceed to be worth
 * anything. This was `MAX_BYTES + 1 MB` multiplied by MAX_BATCH_SIZE at the call site — about
 * 450 MB — which no request can reach: Vercel rejects bodies over 100 MB before a function starts,
 * so the guard could never fire, it just let an oversized body reach memory anywhere else.
 *
 * A maximal batch (50 images x 8 MB = 400 MB) therefore cannot be sent as one request at all.
 * That is a real constraint, not an oversight: clients batching large images must chunk into
 * several requests. Documented on the 413 in openapi.yaml.
 */
const MAX_REQUEST_BYTES = 40 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const EXTRACT_TIMEOUT_MS = 8_000;
const CONCURRENCY = 5;
const MAX_BATCH_SIZE = 50;
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
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

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

function tierFor(providerName: string): string {
  if (providerName === "mock" || providerName === "local-ocr" || providerName === "local-llm") return providerName;
  return "cloud";
}

async function selectProviderForBatch(
  sampleName: string | undefined,
  devTier: string | undefined,
  devBedrockModel: string | undefined,
): Promise<VisionProvider> {
  // devTier/devBedrockModel are already the POST handler's gated values (D8c) — this function
  // doesn't re-check DEV_CONTROLS_ENABLED.
  let provider: VisionProvider;
  if (devTier === "local-ocr") {
    provider = providerByName("local-ocr");
  } else if (devTier === "local-llm") {
    provider = providerByName("local-llm");
  } else if (devTier === "cloud") {
    const cloud = selectCloudProvider();
    if (!cloud) {
      throw new Error("Cloud tier requires an API key configured on the server.");
    }
    provider = cloud;
  } else {
    provider = selectProvider(sampleName);
  }

  if (provider?.name === "bedrock" && devBedrockModel) {
    const originalExtract = provider.extract.bind(provider);
    const modelId = BEDROCK_MODEL_MAP[devBedrockModel];
    provider = {
      ...provider,
      extract: (image, meta) => originalExtract(image, meta, { modelOverride: modelId }),
    };
  }

  return provider;
}

async function verifyOne(
  // The already-parsed entry from the request's `applications` array. It was previously
  // re-stringified by the caller and re-parsed here, which made the JSON-error branch that used to
  // live below unreachable — dead code that read as a live guard.
  image: File,
  application: unknown,
  opts: {
    sourceIsSample?: boolean;
    devTier?: string;
    devBedrockModel?: string;
    escalate?: boolean;
    requestStart: number;
  },
): Promise<BatchRowResult> {
  const start = Date.now();
  try {
    const parsed = ApplicationDataSchema.safeParse(application);
    if (!parsed.success) {
      return {
        filename: image.name,
        overall: "NEEDS_CORRECTION",
        fields: [],
        warnings: [],
        processingMs: Date.now() - start,
        tier: "unknown",
        provider: "unknown",
        beverageType: "unknown",
        error: `Application data is incomplete: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }

    if (!ALLOWED_TYPES.has(image.type)) {
      return {
        filename: image.name,
        overall: "NEEDS_CORRECTION",
        fields: [],
        warnings: [],
        processingMs: Date.now() - start,
        tier: "unknown",
        provider: "unknown",
        beverageType: parsed.data.beverageType,
        error: `Unsupported format (${image.type || "unknown"}). Please upload a PNG, JPEG, or WebP image.`,
      };
    }
    if (image.size === 0 || image.size > MAX_BYTES) {
      return {
        filename: image.name,
        overall: "NEEDS_CORRECTION",
        fields: [],
        warnings: [],
        processingMs: Date.now() - start,
        tier: "unknown",
        provider: "unknown",
        beverageType: parsed.data.beverageType,
        error: "Image must be non-empty and at most 8 MB.",
      };
    }

    const buffer = Buffer.from(await image.arrayBuffer());
    const sampleName = opts.sourceIsSample && isGenuineSample(image.name, buffer) ? image.name : undefined;
    if (sniffMime(buffer) !== image.type) {
      return {
        filename: image.name,
        overall: "NEEDS_CORRECTION",
        fields: [],
        warnings: [],
        processingMs: Date.now() - start,
        tier: "unknown",
        provider: "unknown",
        beverageType: parsed.data.beverageType,
        error: "The file's content does not match its declared image type — upload a real PNG, JPEG, or WebP.",
      };
    }

    let width = 0;
    let height = 0;
    try {
      ({ width = 0, height = 0 } = await sharp(buffer).metadata());
    } catch {
      return {
        filename: image.name,
        overall: "NEEDS_CORRECTION",
        fields: [],
        warnings: [],
        processingMs: Date.now() - start,
        tier: "unknown",
        provider: "unknown",
        beverageType: parsed.data.beverageType,
        error: "Could not read this image — please upload a valid PNG, JPEG, or WebP.",
      };
    }
    const pixels = width * height;
    if (pixels <= 0 || pixels > MAX_PIXELS) {
      return {
        filename: image.name,
        overall: "NEEDS_CORRECTION",
        fields: [],
        warnings: [],
        processingMs: Date.now() - start,
        tier: "unknown",
        provider: "unknown",
        beverageType: parsed.data.beverageType,
        error: `This image is too large to process — its dimensions exceed ${MAX_PIXELS / 1_000_000} megapixels. Downscale it and try again.`,
      };
    }

    const provider = await selectProviderForBatch(sampleName, opts.devTier, opts.devBedrockModel);
    let fellBackToLocalOcr = false;

    // opts.devTier/opts.devBedrockModel/opts.escalate are already the POST handler's gated,
    // validated values (undefined/false when DEV_CONTROLS_ENABLED disallows them) — no second gate
    // here. A prior version re-derived devControlsEnabled from DEV_CONTROLS_ENABLED alone (without
    // the NODE_ENV clause the POST gate uses), which silently discarded a legitimately-enabled
    // dev override in any non-production environment that hadn't also set the env var.
    const escalationOn = process.env.ESCALATION_ENABLED === "1" || opts.escalate === true;
    const ladderOpts = {
      maxAttempts: escalationOn ? undefined : 0,
      budgetMs: Math.max(0, LADDER_BUDGET_MS - (Date.now() - opts.requestStart)),
    };
    let escalating = withEscalation(provider, ladderOpts);
    if (tierFor(provider.name) === "cloud") {
      // Same composition-site timeout as app/api/verify/route.ts (D3, 2026-07-25 hardening) — a hung
      // cloud primary must reject at CLOUD_PRIMARY_TIMEOUT_MS so withFallback degrades the ROW to
      // local-ocr instead of the row erroring at the outer EXTRACT_TIMEOUT_MS. An explicit dev model
      // override is exempt (the user chose a slower model); D8c gates that field in production.
      const primary = opts.devBedrockModel ? escalating : withProviderTimeout(escalating, CLOUD_PRIMARY_TIMEOUT_MS);
      escalating = withFallback(primary, withEscalation(providerByName("local-ocr"), ladderOpts), () => {
        fellBackToLocalOcr = true;
      });
    }
    const { label, trace } = await withTimeout(
      escalating.extractWithTrace(buffer, { filename: image.name, mimeType: image.type }),
      EXTRACT_TIMEOUT_MS,
    );
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
    return {
      filename: image.name,
      ...result,
      processingMs: Date.now() - start,
      tier,
      provider: ranProvider,
      beverageType: parsed.data.beverageType,
    };
  } catch (e) {
    if (e instanceof TimeoutError) {
      return {
        filename: image.name,
        overall: "NEEDS_CORRECTION",
        fields: [],
        warnings: [],
        processingMs: Date.now() - start,
        tier: "unknown",
        provider: "unknown",
        beverageType: "unknown",
        error: "Verification took too long — try a smaller or clearer image, or try again.",
      };
    }
    // A thrown value may not be an object (throw null, throw "string"), so hoist the property read to
    // where it's null-safe — matches app/api/verify/route.ts's identical guard.
    const errStatus = typeof e === "object" && e !== null ? (e as { status?: number }).status : undefined;
    if (errStatus === 429) {
      return {
        filename: image.name,
        overall: "NEEDS_CORRECTION",
        fields: [],
        warnings: [],
        processingMs: Date.now() - start,
        tier: "unknown",
        provider: "unknown",
        beverageType: "unknown",
        error: "The extraction service is rate-limited right now — try again in a few seconds.",
      };
    }
    return {
      filename: image.name,
      overall: "NEEDS_CORRECTION",
      fields: [],
      warnings: [],
      processingMs: Date.now() - start,
      tier: "unknown",
      provider: "unknown",
      beverageType: "unknown",
      error: "Verification failed — try a clearer image.",
    };
  }
}

export async function POST(req: Request) {
  const requestStart = Date.now();

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  const rawLength = req.headers.get("content-length");
  if (rawLength === null) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "Request too large — the batch must be at most 50 images." }, { status: 413 });
    }
  } else {
    const declaredLength = Number(rawLength);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return NextResponse.json(
        {
          error: `Request too large — the whole batch must be at most ${MAX_REQUEST_BYTES / 1024 / 1024} MB. Send fewer images per request.`,
        },
        { status: 413 },
      );
    }
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("Expected multipart form data with images and applications fields.");
  }

  const imagesRaw = form.getAll("images");
  const applicationsRaw = form.get("applications");
  if (!Array.isArray(imagesRaw) || imagesRaw.length === 0 || !(imagesRaw[0] instanceof File)) {
    return bad("Missing the label images field — provide at least one image.");
  }
  if (typeof applicationsRaw !== "string") {
    return bad("Missing the applications data field — provide a JSON array of application objects.");
  }

  const images = imagesRaw.filter((x): x is File => x instanceof File);
  if (images.length === 0) {
    return bad("No valid images found in the batch.");
  }
  if (images.length > MAX_BATCH_SIZE) {
    return bad(`Batch size exceeds limit — at most ${MAX_BATCH_SIZE} images allowed.`);
  }

  // Cost is images.length, not 1: each image is an independent extraction, so a 50-image request
  // must consume as much budget as 50 single-image /api/verify calls would — otherwise one rate-limit
  // token buys up to MAX_BATCH_SIZE times the extraction budget of a single verify request.
  const limit = rateLimit(ip, {}, images.length);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  let applications: unknown[];
  try {
    applications = JSON.parse(applicationsRaw);
  } catch {
    return bad("Applications data is not valid JSON.");
  }
  if (!Array.isArray(applications) || applications.length !== images.length) {
    return bad("Applications must be a JSON array with one entry per image.");
  }

  const sourceIsSample = form.get("source") === "sample";
  const devTierRaw = form.get("devTier");
  const devBedrockModelRaw = form.get("devBedrockModel");
  const escalateRaw = form.get("escalate");
  // Same gate as app/api/verify/route.ts (D8c, 2026-07-25 hardening) — an ungated batch endpoint
  // would trivially bypass the verify route's gate, multiplied by up to MAX_BATCH_SIZE rows.
  const devControlsEnabled = process.env.NODE_ENV !== "production" || process.env.DEV_CONTROLS_ENABLED === "1";
  if (!devControlsEnabled && (devTierRaw !== null || devBedrockModelRaw !== null || escalateRaw !== null)) {
    return bad("Developer controls (tier override, model override, escalation) are disabled in this deployment.");
  }
  const devTier = typeof devTierRaw === "string" && DEV_TIERS.has(devTierRaw) ? devTierRaw : undefined;
  const devBedrockModel =
    typeof devBedrockModelRaw === "string" && VALID_BEDROCK_MODELS.has(devBedrockModelRaw)
      ? devBedrockModelRaw
      : undefined;
  const escalate = escalateRaw === "1";

  const items = images.map((image, index) => ({ image, index, application: applications[index] }));

  // Results are written by index, not pushed. Workers finish out of order (a rejected image returns
  // in microseconds, a real extraction in seconds), so pushing would return rows in completion
  // order — silently mispairing every row with its application in any consumer that zips by index.
  // `filename` is no substitute for the index: a batch may legitimately contain the same filename
  // twice (see eval/fixtures/batch/duplicate-filenames.csv).
  const results: BatchRowResult[] = new Array(items.length);
  const queue = [...items];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        results[item.index] = await verifyOne(item.image, item.application, {
          sourceIsSample,
          devTier,
          devBedrockModel,
          escalate,
          requestStart,
        });
      } catch (e) {
        // verifyOne wraps its whole body, so reaching here means something threw that it could not
        // catch — e.g. `throw null`, which makes its own `catch` blow up on a property access.
        // Without this, the worker's promise rejects, `results` keeps a hole, the response schema
        // rejects it, and one unlucky item turns into a 500 for the entire batch. Invariant 7 says
        // one bad label never aborts a batch, so fail closed for this row only.
        results[item.index] = {
          filename: item.image.name,
          overall: "NEEDS_CORRECTION",
          fields: [],
          warnings: [],
          processingMs: 0,
          tier: "unknown",
          provider: "unknown",
          beverageType: "unknown",
          error: e instanceof Error ? e.message : "Verification failed unexpectedly.",
        };
      }
    }
  });
  await Promise.all(workers);

  // Validate our own response shape. Every data-dependent outcome is already handled per item
  // above, so a failure here means the route's contract drifted from lib/batch-schema — a coding
  // error we want loud (a 500) rather than a malformed batch a consumer has to guess about. The
  // schema is strict, so an ADDED key fails here too instead of being silently stripped out of the
  // response; a dropped item shows up as a hole in `results` and fails the same way.
  const payload = BatchResponseSchema.parse({ results, totalMs: Date.now() - requestStart });
  return NextResponse.json(payload);
}
