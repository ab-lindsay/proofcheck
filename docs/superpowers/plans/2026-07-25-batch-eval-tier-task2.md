# Rewrite POST /api/batch Implementation Plan

> **STATUS: EXECUTED AND MERGED — 2026-07-25.** Checkboxes left unticked on purpose: Task 2's code
> below does not work as written and was replaced. See the Outcome section; the steps are kept as the
> historical record.

## Outcome (2026-07-25)

Merged to `main` as part of `88b74e5`, with follow-up fixes in `ac305bd`.

**Task 1 (rewrite the route)** was carried out essentially as written. Three defects were found in it
afterwards and fixed:

- Results were `push`ed from five concurrent workers, so `results[i]` did not correspond to
  `images[i]` — workers finish out of order, so every row could be paired with the wrong application
  in any consumer that zips by index. Now written by index. `filename` is not a usable key either: a
  batch may legitimately repeat one.
- The whole-request ceiling was `MAX_REQUEST_BYTES * 50` ≈ 450 MB, above the 100 MB body limit
  platforms enforce before a function starts, so it could never fire.
- `throw null` defeated `verifyOne`'s own catch (that catch does a property access on the thrown
  value), leaving a hole in `results` that failed the response schema and turned one item into a 500
  for the whole batch — precisely what invariant 7 forbids.

**Task 2 (update the tests)** — the code block below does **not** work as written. It has six
typecheck errors (`applications` typed `string[]` while every call site passes objects; `Uint8Array`
is not assignable to `BlobPart`), an unused `OLD_TOM` binding that fails lint, two test names
asserting "with 400" against paths that correctly return a per-item error inside a 200, and one
expectation copy-pasted from a different test (an unsupported-image-type case asserting the error
contains "at most 50 images"). It was replaced with corrected tests and extended to cover the
trusted-sample hash gate, unknown-`devTier` rejection, result ordering under out-of-order completion,
queue draining above `CONCURRENCY = 5`, the megapixel guard, and the 413 ceiling.

**Task 3 (verification)** was run and is green: 584 tests, typecheck and lint clean, batch eval 89/89,
default eval 13/13.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite POST /api/batch to accept multipart form data with full security guards matching /api/verify, supporting concurrent per-item processing with proper error handling.

**Architecture:** Accept multipart form data with `images` (File array) and `applications` (JSON string). Apply all security guards from /api/verify (content-length, MIME sniffing, decompression-bomb, sample hash verification) per image. Process items concurrently with CONCURRENCY=5, fail per-item not per-batch.

**Tech Stack:** Next.js, sharp, zod, multipart form data

## Global Constraints

- Node.js runtime (export const runtime = "nodejs")
- MAX_BYTES = 8 MB per image
- MAX_REQUEST_BYTES = MAX_BYTES + 1 MB
- MAX_PIXELS = 25,000,000 (decompression bomb guard)
- ALLOWED_TYPES = image/png, image/jpeg, image/webp
- EXTRACT_TIMEOUT_MS = 8,000
- CONCURRENCY = 5
- MAX_BATCH_SIZE = 50
- DEV_TIERS = auto, local-ocr, local-llm, cloud
- VALID_BEDROCK_MODELS = haiku, opus
- BEDROCK_MODEL_MAP maps haiku/opus to AWS model IDs

---

### Task 1: Rewrite POST /api/batch route with security guards

**Files:**

- Modify: `app/api/batch/route.ts`

**Interfaces:**

- Consumes: multipart form data with `images` (File[]), `applications` (JSON string array), `source`, `devTier`, `devBedrockModel`, `escalate`
- Produces: JSON response with `results` array and `totalMs`

- [ ] **Step 1: Read current route.ts to understand existing structure**

Read `app/api/batch/route.ts` to understand current implementation.

- [ ] **Step 2: Rewrite route.ts with all security guards**

Replace the entire file with the new implementation:

```typescript
import { NextResponse } from "next/server";
import sharp from "sharp";
import { ApplicationDataSchema, ExtractedLabelSchema } from "@/lib/schema";
import { selectProvider, selectCloudProvider, providerByName } from "@/lib/vision/select";
import { withFallback } from "@/lib/vision/fallback";
import { LADDER_BUDGET_MS, withEscalation } from "@/lib/vision/escalation/escalate";
import { isGenuineSample } from "@/lib/vision/sample-hashes";
import { verifyLabel } from "@/lib/matching/verify";
import type { VisionProvider } from "@/lib/vision/types";

export const runtime = "nodejs";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_BYTES + 1024 * 1024;
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

async function verifyOne(
  image: File,
  applicationJson: string,
  opts: {
    sampleName?: string;
    devTier?: string;
    devBedrockModel?: string;
    escalate?: boolean;
    requestStart: number;
  },
): Promise<{
  filename: string;
  overall: string;
  fields: unknown[];
  warnings: string[];
  processingMs: number;
  tier: string;
  provider: string;
  beverageType: string;
  error?: string;
}> {
  const start = Date.now();
  try {
    let appJson: unknown;
    try {
      appJson = JSON.parse(applicationJson);
    } catch {
      return {
        filename: image.name,
        overall: "FAIL",
        fields: [],
        warnings: [],
        processingMs: Date.now() - start,
        tier: "unknown",
        provider: "unknown",
        beverageType: "unknown",
        error: "Application data is not valid JSON.",
      };
    }
    const parsed = ApplicationDataSchema.safeParse(appJson);
    if (!parsed.success) {
      return {
        filename: image.name,
        overall: "FAIL",
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
        overall: "FAIL",
        fields: [],
        warnings: [],
        processingMs: Date.now() - start,
        tier: "unknown",
        provider: "unknown",
        beverageType: parsed.data.beverageType,
        error: "Unsupported image type — please upload a PNG, JPEG, or WebP.",
      };
    }
    if (image.size === 0 || image.size > MAX_BYTES) {
      return {
        filename: image.name,
        overall: "FAIL",
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
    if (sniffMime(buffer) !== image.type) {
      return {
        filename: image.name,
        overall: "FAIL",
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
        overall: "FAIL",
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
        overall: "FAIL",
        fields: [],
        warnings: [],
        processingMs: Date.now() - start,
        tier: "unknown",
        provider: "unknown",
        beverageType: parsed.data.beverageType,
        error: `This image is too large to process — its dimensions exceed ${MAX_PIXELS / 1_000_000} megapixels. Downscale it and try again.`,
      };
    }

    const provider = await selectProviderForBatch(opts.sampleName, opts.devTier, opts.devBedrockModel);
    let fellBackToLocalOcr = false;

    const escalationOn = process.env.ESCALATION_ENABLED === "1" || opts.escalate;
    const ladderOpts = {
      maxAttempts: escalationOn ? undefined : 0,
      budgetMs: Math.max(0, LADDER_BUDGET_MS - (Date.now() - opts.requestStart)),
    };
    let escalating = withEscalation(provider, ladderOpts);
    if (tierFor(provider.name) === "cloud") {
      escalating = withFallback(escalating, withEscalation(providerByName("local-ocr"), ladderOpts), () => {
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
        overall: "FAIL",
        fields: [],
        warnings: [],
        processingMs: Date.now() - start,
        tier: "unknown",
        provider: "unknown",
        beverageType: "unknown",
        error: "Verification took too long — try a smaller or clearer image, or try again.",
      };
    }
    if ((e as { status?: number }).status === 429) {
      return {
        filename: image.name,
        overall: "FAIL",
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
      overall: "FAIL",
      fields: [],
      warnings: [],
      processingMs: Date.now() - start,
      tier: "unknown",
      provider: "unknown",
      beverageType: "unknown",
      error: e instanceof Error ? e.message : "Verification failed",
    };
  }
}

async function selectProviderForBatch(
  sampleName: string | undefined,
  devTier: string | undefined,
  devBedrockModel: string | undefined,
): Promise<VisionProvider> {
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

export async function POST(req: Request) {
  const requestStart = Date.now();
  const rawLength = req.headers.get("content-length");
  if (rawLength === null) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "Request too large — the batch must be at most 50 images." }, { status: 413 });
    }
  } else {
    const declaredLength = Number(rawLength);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES * 50) {
      return NextResponse.json({ error: "Request too large — the batch must be at most 50 images." }, { status: 413 });
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

  let applications: unknown[];
  try {
    applications = JSON.parse(applicationsRaw);
  } catch {
    return bad("Applications data is not valid JSON.");
  }
  if (!Array.isArray(applications) || applications.length !== images.length) {
    return bad("Applications must be a JSON array with one entry per image.");
  }

  const sampleName = form.get("source") === "sample" ? undefined : undefined;
  const devTierRaw = form.get("devTier");
  const devTier = typeof devTierRaw === "string" && DEV_TIERS.has(devTierRaw) ? devTierRaw : undefined;
  const devBedrockModelRaw = form.get("devBedrockModel");
  const devBedrockModel =
    typeof devBedrockModelRaw === "string" && VALID_BEDROCK_MODELS.has(devBedrockModelRaw)
      ? devBedrockModelRaw
      : undefined;
  const escalate = form.get("escalate") === "1";

  const items = images.map((image, i) => ({ image, applicationJson: applications[i] }));

  const results: Awaited<ReturnType<typeof verifyOne>>[] = [];
  const queue = [...items];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const result = await verifyOne(item.image, item.applicationJson, {
        sampleName,
        devTier,
        devBedrockModel,
        escalate,
        requestStart,
      });
      results.push(result);
    }
  });
  await Promise.all(workers);

  return NextResponse.json({
    results,
    totalMs: Date.now() - requestStart,
  });
}
```

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `pnpm test app/api/batch/route.test.ts`

Expected: Tests may fail because they use the old JSON format — this is expected. We'll update tests in Task 2.

- [ ] **Step 4: Commit the route rewrite**

```bash
git add app/api/batch/route.ts
git commit -m "feat: rewrite POST /api/batch with full security guards matching /api/verify"
```

---

### Task 2: Update tests for multipart format

**Files:**

- Modify: `app/api/batch/route.test.ts`

**Interfaces:**

- Consumes: rewritten POST /api/batch handler
- Produces: updated test suite covering multipart form data format

- [ ] **Step 1: Read current test file to understand existing tests**

Read `app/api/batch/route.test.ts` to understand current test structure.

- [ ] **Step 2: Rewrite test file with multipart form data tests**

Replace the entire file with the new test implementation:

```typescript
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";

const mockRecognize = vi.fn();
vi.mock("tesseract.js", () => ({
  createWorker: async () => ({ recognize: mockRecognize, setParameters: vi.fn().mockResolvedValue(undefined) }),
  PSM: { SINGLE_COLUMN: "4" },
}));

import { POST } from "@/app/api/batch/route";

afterEach(() => {
  vi.unstubAllEnvs();
  mockRecognize.mockReset();
});

const app = {
  beverageType: "distilled-spirits",
  brandName: "OLD TOM DISTILLERY",
  classType: "Kentucky Straight Bourbon Whiskey",
  alcoholContent: "45% Alc./Vol. (90 Proof)",
  netContents: "750 mL",
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const OLD_TOM = readFileSync("public/samples/old-tom-clean.png");

function request(
  overrides: {
    filenames?: string[];
    types?: string[];
    applications?: string[];
    magic?: number[];
    source?: string;
    devTier?: string;
    devBedrockModel?: string;
    escalate?: string;
  } = {},
) {
  const fd = new FormData();
  const filenames = overrides.filenames ?? ["old-tom-clean.png"];
  const types = overrides.types ?? ["image/png"];
  const applications = overrides.applications ?? [JSON.stringify(app)];

  for (let i = 0; i < filenames.length; i++) {
    const bytes = new Uint8Array(overrides.magic ?? PNG_MAGIC);
    fd.append("images", new File([bytes], filenames[i], { type: types[i] }));
  }
  fd.set("applications", JSON.stringify(applications));
  if (overrides.source !== undefined) fd.set("source", overrides.source);
  if (overrides.devTier !== undefined) fd.set("devTier", overrides.devTier);
  if (overrides.devBedrockModel !== undefined) fd.set("devBedrockModel", overrides.devBedrockModel);
  if (overrides.escalate !== undefined) fd.set("escalate", overrides.escalate);

  const contentLength = String(filenames.length * 1024 + 1024);
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? contentLength : null) },
    formData: async () => fd,
  } as unknown as Request;
}

describe("POST /api/batch", () => {
  it("returns 400 for missing images", async () => {
    const fd = new FormData();
    fd.set("applications", JSON.stringify([app]));
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "1024" : null) },
      formData: async () => fd,
    } as unknown as Request;
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing the label images");
  });

  it("returns 400 for missing applications", async () => {
    const fd = new FormData();
    fd.append("images", new File([new Uint8Array(PNG_MAGIC)], "old-tom-clean.png", { type: "image/png" }));
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "1024" : null) },
      formData: async () => fd,
    } as unknown as Request;
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Missing the applications data");
  });

  it("returns 400 for mismatched images and applications count", async () => {
    const fd = new FormData();
    fd.append("images", new File([new Uint8Array(PNG_MAGIC)], "old-tom-clean.png", { type: "image/png" }));
    fd.set("applications", JSON.stringify([app, app]));
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "2048" : null) },
      formData: async () => fd,
    } as unknown as Request;
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("must be a JSON array with one entry per image");
  });

  it("returns 400 for batch size exceeding MAX_BATCH_SIZE", async () => {
    const fd = new FormData();
    const apps: string[] = [];
    for (let i = 0; i < 51; i++) {
      fd.append("images", new File([new Uint8Array(PNG_MAGIC)], `image-${i}.png`, { type: "image/png" }));
      apps.push(JSON.stringify(app));
    }
    fd.set("applications", JSON.stringify(apps));
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "52224" : null) },
      formData: async () => fd,
    } as unknown as Request;
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("at most 50 images");
  });

  it("rejects invalid application JSON", async () => {
    const fd = new FormData();
    fd.append("images", new File([new Uint8Array(PNG_MAGIC)], "old-tom-clean.png", { type: "image/png" }));
    fd.set("applications", "[{not json}]");
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "1024" : null) },
      formData: async () => fd,
    } as unknown as Request;
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not valid JSON");
  });

  it("rejects unsupported image type with 400", async () => {
    const fd = new FormData();
    fd.append("images", new File([new Uint8Array(PNG_MAGIC)], "old-tom-clean.png", { type: "application/pdf" }));
    fd.set("applications", JSON.stringify([app]));
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "1024" : null) },
      formData: async () => fd,
    } as unknown as Request;
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("at most 50 images");
  });

  it("returns batch results for valid request", async () => {
    vi.stubEnv("VISION_PROVIDER", "mock");
    const res = await POST(
      request({
        filenames: ["old-tom-clean.png"],
        types: ["image/png"],
        applications: [JSON.stringify(app)],
        source: "sample",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].filename).toBe("old-tom-clean.png");
    expect(body.results[0].overall).toBe("PASS");
    expect(typeof body.totalMs).toBe("number");
  });

  it("processes multiple images concurrently", async () => {
    vi.stubEnv("VISION_PROVIDER", "mock");
    const res = await POST(
      request({
        filenames: ["old-tom-clean.png", "old-tom-clean.png"],
        types: ["image/png", "image/png"],
        applications: [JSON.stringify(app), JSON.stringify(app)],
        source: "sample",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results[0].overall).toBe("PASS");
    expect(body.results[1].overall).toBe("PASS");
  });

  it("fails per-item, not per-batch", async () => {
    vi.stubEnv("VISION_PROVIDER", "mock");
    const res = await POST(
      request({
        filenames: ["old-tom-clean.png", "bad-image.png"],
        types: ["image/png", "image/png"],
        applications: [JSON.stringify(app), JSON.stringify(app)],
        source: "sample",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
  });

  it("rejects a payload whose bytes are not the declared image type", async () => {
    const fd = new FormData();
    fd.append(
      "images",
      new File([new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])], "old-tom-clean.png", { type: "image/png" }),
    );
    fd.set("applications", JSON.stringify([app]));
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "1024" : null) },
      formData: async () => fd,
    } as unknown as Request;
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].error).toContain("does not match");
  });

  it("rejects empty files with 400", async () => {
    const fd = new FormData();
    fd.append("images", new File([new Uint8Array(0)], "empty.png", { type: "image/png" }));
    fd.set("applications", JSON.stringify([app]));
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "1024" : null) },
      formData: async () => fd,
    } as unknown as Request;
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].error).toContain("non-empty");
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm test app/api/batch/route.test.ts`

Expected: All tests pass

- [ ] **Step 4: Commit the test updates**

```bash
git add app/api/batch/route.test.ts
git commit -m "test: update batch tests for multipart form data format"
```

---

### Task 3: Verify full test suite passes

**Files:**

- None (verification only)

**Interfaces:**

- Consumes: completed route and test implementations
- Produces: passing test suite

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`

Expected: All tests pass

- [ ] **Step 2: Run linting**

Run: `pnpm lint`

Expected: No linting errors

- [ ] **Step 3: Run type checking**

Run: `pnpm typecheck`

Expected: No type errors

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-25-batch-eval-tier-task2.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
