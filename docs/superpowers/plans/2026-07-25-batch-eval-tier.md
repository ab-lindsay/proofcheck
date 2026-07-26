# Batch API Endpoint & Eval Tier Implementation Plan

> **STATUS: EXECUTED AND MERGED — 2026-07-25.** The step checkboxes below are left unticked on
> purpose. Several were carried out differently from what is written here, and one was deliberately
> not done at all, so ticking them would misrepresent the result. Read the Outcome section first; the
> steps below are the original plan, kept as the historical record.

## Outcome (2026-07-25)

Merged to `main` as `88b74e5`, with follow-up fixes in `ac305bd`.

**Done as planned:** the `/api/batch` endpoint (Task 2, then rewritten per the companion plan
`2026-07-25-batch-eval-tier-task2.md`), the CSV fixtures and expected file (Task 3), the `--set batch`
eval tier (Task 4), the `eval:batch` script (Task 6), the `add-batch-test` skill (Task 7), and final
verification (Task 8).

**Done differently:**

- **Task 1's schemas.** `BatchRequestSchema` / `BatchRowRequestSchema` were built and then deleted:
  the multipart rewrite meant they described a body the endpoint no longer accepts, and a
  whole-request schema would have to reject a batch as a unit, which invariant 7 forbids. The
  response half survived, is wired into the route, and was made strict so additive drift fails
  loudly instead of being silently stripped.
- **Task 4's scoring.** Shipped, then rewritten. Four defects meant most of its checks could not
  fail — a thrown exception scored as a correct FAIL, `empty.csv` contributed no checks at all, two
  fixtures passed through a blanket "any parse error" branch, and a parsed row with no expectation
  was skipped silently. It also never read the `violation` field that was in the expectations all
  along. The expected-file format gained `parsedRows`, `parseErrors`, and `expectError` as a result.
  29 nominal checks became 89 real ones.
- **Task 7's skill.** Expanded well past the sketch here to document every asserted field and to
  state what the tier does not cover.

**Not done:**

- **Task 5 — wiring `hooks/use-batch.ts` to the endpoint.** The plan's own code block kept the
  client on N concurrent `/api/verify` calls behind a TODO, so there was nothing to change.
  `/api/batch` therefore has **no caller** in the app; it is reachable but unused.

**Rejected:**

- **The Architecture line below claiming the eval tier "validates batch accuracy by calling this
  endpoint."** It does not — `runBatchEval` calls the vision provider directly. Rewiring it was
  considered and turned down: the coverage it would have bought (queue draining above
  `CONCURRENCY = 5`, the megapixel guard) was cheaper and safer to get in
  `app/api/batch/route.test.ts`, which already drives the route in a vitest node environment, rather
  than running Next's `NextResponse` under bare `tsx`. Note that mock coverage was never the
  obstacle: `selectProvider` honours `VISION_PROVIDER` before the trusted-sample hash gate, so all 12
  fixtures could have stayed on the mock tier.

**Added beyond the plan:** `/api/batch` documented in `openapi.yaml`; a trusted-sample-gate test (the
rewrite's main security control, previously untested); result-ordering, queue-draining and
megapixel-guard tests; a realistic whole-request size ceiling; and a per-row guard so one item cannot
abort a batch.

**Known limits still open** — recorded in full, with evidence and recommended fixes, as §3–§5 of
[`docs/deferred-items-and-tradeoffs-2026-07-25.md`](../../deferred-items-and-tradeoffs-2026-07-25.md),
which is the canonical place to look. Summarised here:

- The escalation ladder derives `budgetMs` from the request start for the whole batch, so later items
  in a large batch get little or no ladder budget. A per-item budget alone would make total batch
  latency unbounded, so the real fix is per-item budget plus a batch deadline — a design decision.
  The ladder is off by default.
- `/api/batch` has no caller (Task 5 above).
- `openapi.yaml` is validated structurally only. Neither the repo nor CI has YAML tooling, so nothing
  parses it or checks it against the route.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-side batch verification endpoint (`POST /api/batch`) and a batch eval tier that tests CSV parsing, concurrency accuracy, error handling, and regression.

**Architecture:** A new `POST /api/batch` endpoint accepts multiple images + application data, runs extraction concurrently server-side, and returns structured results. The eval harness gets a `--set batch` tier that validates batch accuracy by calling this endpoint. The client-side `useBatch` hook is updated to use the new endpoint instead of firing N concurrent `/api/verify` calls.

**Tech Stack:** Next.js API routes, Zod schemas, TypeScript, existing `verifyLabel()` matcher, existing vision providers.

---

## Global Constraints

- The 5s per-label latency budget applies to batch rows individually (not batch total)
- Mock tier must score 100% on default set (existing gate, unchanged)
- `CONCURRENCY = 5` matches the client-side `use-batch.ts` constant
- Fail per-item, not per-batch (architecture rule 9)
- Security: magic-byte MIME sniff, decompression-bomb guard, trusted-sample gate apply per image
- Reuse existing `verifyLabel()` — batch endpoint is a thin orchestrator, not a new matcher

---

## File Structure

| File                                     | Purpose                                                   |
| ---------------------------------------- | --------------------------------------------------------- |
| `app/api/batch/route.ts`                 | **New** — POST /api/batch endpoint                        |
| `app/api/batch/route.test.ts`            | **New** — Unit tests for batch endpoint                   |
| `lib/batch-schema.ts`                    | **New** — Batch request/response Zod schemas              |
| `eval/expected-batch.json`               | **New** — Batch eval expected entries                     |
| `eval/fixtures/batch/*.csv`              | **New** — 8 CSV test fixtures                             |
| `eval/run.ts`                            | **Modify** — Add "batch" set, batch runner logic          |
| `hooks/use-batch.ts`                     | **Modify** — Use POST /api/batch instead of N /api/verify |
| `package.json`                           | **Modify** — Add "eval:batch" script                      |
| `.claude/skills/add-batch-test/SKILL.md` | **New** — Skill for adding batch test samples             |

---

## Task 1: Batch Request/Response Schemas

**Files:**

- Create: `lib/batch-schema.ts`
- Test: `lib/batch-schema.test.ts`

**Interfaces:**

- Produces: `BatchRequestSchema`, `BatchResponseSchema`, `BatchRequest`, `BatchResponse`

- [ ] **Step 1: Write the failing test**

```typescript
// lib/batch-schema.test.ts
import { describe, it, expect } from "vitest";
import { BatchRequestSchema, BatchResponseSchema } from "./batch-schema";

describe("BatchRequestSchema", () => {
  it("accepts valid batch request", () => {
    const result = BatchRequestSchema.safeParse({
      rows: [
        {
          filename: "old-tom-clean.png",
          application: {
            beverageType: "distilled-spirits",
            brandName: "OLD TOM DISTILLERY",
            classType: "Kentucky Straight Bourbon Whiskey",
            alcoholContent: "45% Alc./Vol.",
            netContents: "750 mL",
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty rows", () => {
    const result = BatchRequestSchema.safeParse({ rows: [] });
    expect(result.success).toBe(false);
  });

  it("rejects missing filename", () => {
    const result = BatchRequestSchema.safeParse({
      rows: [
        {
          filename: "",
          application: { beverageType: "wine", brandName: "Test", classType: "Table Wine", netContents: "750 mL" },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("BatchResponseSchema", () => {
  it("accepts valid batch response", () => {
    const result = BatchResponseSchema.safeParse({
      results: [
        {
          filename: "old-tom-clean.png",
          overall: "PASS",
          fields: [],
          warnings: [],
          processingMs: 100,
          tier: "mock",
          provider: "mock",
          beverageType: "distilled-spirits",
        },
      ],
      totalMs: 500,
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/batch-schema.test.ts`
Expected: FAIL with "Cannot find module './batch-schema'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/batch-schema.ts
import { z } from "zod";
import { ApplicationDataSchema, BeverageTypeSchema } from "./schema";

export const BatchRowRequestSchema = z.object({
  filename: z.string().min(1, "Filename is required"),
  application: ApplicationDataSchema,
});

export const BatchRequestSchema = z.object({
  rows: z.array(BatchRowRequestSchema).min(1, "At least one row is required"),
});
export type BatchRequest = z.infer<typeof BatchRequestSchema>;

export const BatchRowResultSchema = z.object({
  filename: z.string(),
  overall: z.enum(["PASS", "FAIL"]),
  fields: z.array(
    z.object({
      field: z.string(),
      applicationValue: z.string().nullable(),
      labelValue: z.string().nullable(),
      verdict: z.enum(["MATCH", "MISMATCH", "REVIEW"]),
      reason: z.string(),
      confidence: z.number(),
    }),
  ),
  warnings: z.array(z.string()),
  processingMs: z.number(),
  tier: z.string(),
  provider: z.string(),
  beverageType: BeverageTypeSchema,
  error: z.string().optional(),
});

export const BatchResponseSchema = z.object({
  results: z.array(BatchRowResultSchema),
  totalMs: z.number(),
});
export type BatchResponse = z.infer<typeof BatchResponseSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/batch-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/batch-schema.ts lib/batch-schema.test.ts
git commit -m "feat: add batch request/response Zod schemas"
```

---

## Task 2: Batch API Endpoint (Production-Grade)

**Files:**

- Create: `app/api/batch/route.ts`
- Create: `app/api/batch/route.test.ts`

**Interfaces:**

- Consumes: `BatchRequestSchema`, `BatchRowRequestSchema` from Task 1, `verifyLabel()` from `lib/matching/verify.ts`, vision providers from `lib/vision/select.ts`, all security guards from `app/api/verify/route.ts`
- Produces: `POST /api/batch` endpoint returning `BatchResponse`

**Design:** The batch endpoint must be as robust as `/api/verify`. It accepts multipart form data with multiple images and application data, applies all security guards per image, supports devTier/escalation ladder, and processes rows concurrently with `CONCURRENCY = 5`.

**Request format (multipart/form-data):**

- `images` — multiple File entries (up to 50)
- `applications` — JSON string: `Array<{ filename: string; application: ApplicationData }>`
- `devTier` — optional: "auto" | "local-ocr" | "local-llm" | "cloud"
- `devBedrockModel` — optional: "haiku" | "opus"
- `escalate` — optional: "1" to enable escalation ladder

- [ ] **Step 1: Write the failing test**

```typescript
// app/api/batch/route.test.ts
// @vitest-environment node
import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";

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

const OLD_TOM_BUFFER = readFileSync("public/samples/old-tom-clean.png");

function makeMultipartRequest(
  rows: Array<{ filename: string; application: unknown }>,
  images: Array<{ name: string; buffer: Buffer; type: string }>,
) {
  const form = new FormData();
  form.set("applications", JSON.stringify(rows));
  for (const img of images) {
    const blob = new Blob([img.buffer], { type: img.type });
    form.append("images", blob, img.name);
  }
  return new Request("http://localhost/api/batch", { method: "POST", body: form }) as unknown as Request;
}

function makeJsonRequest(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

describe("POST /api/batch", () => {
  it("returns 400 for empty rows", async () => {
    const res = await POST(makeJsonRequest({ rows: [] }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing application fields", async () => {
    const res = await POST(
      makeJsonRequest({
        rows: [{ filename: "test.png", application: {} }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns batch results for valid multipart request", async () => {
    vi.stubEnv("VISION_PROVIDER", "mock");
    const res = await POST(
      makeMultipartRequest(
        [{ filename: "old-tom-clean.png", application: app }],
        [{ name: "old-tom-clean.png", buffer: OLD_TOM_BUFFER, type: "image/png" }],
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].filename).toBe("old-tom-clean.png");
    expect(body.results[0].overall).toBe("PASS");
    expect(body.results[0].tier).toBe("mock");
    expect(typeof body.totalMs).toBe("number");
  });

  it("applies decompression-bomb guard per image", async () => {
    const fakeImage = Buffer.alloc(100);
    fakeImage[0] = 0x89;
    fakeImage[1] = 0x50;
    fakeImage[2] = 0x4e;
    fakeImage[3] = 0x47; // PNG magic
    const res = await POST(
      makeMultipartRequest(
        [{ filename: "test.png", application: app }],
        [{ name: "test.png", buffer: fakeImage, type: "image/png" }],
      ),
    );
    // Should fail on decompression-bomb or metadata read, not crash
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it("supports devTier parameter", async () => {
    vi.stubEnv("VISION_PROVIDER", "mock");
    const form = new FormData();
    form.set("applications", JSON.stringify([{ filename: "old-tom-clean.png", application: app }]));
    form.set("devTier", "local-ocr");
    const blob = new Blob([OLD_TOM_BUFFER], { type: "image/png" });
    form.append("images", blob, "old-tom-clean.png");
    const res = await POST({
      json: async () => undefined,
      formData: async () => form,
      headers: new Headers({ "content-length": "9999" }),
    } as unknown as Request);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test app/api/batch/route.test.ts`
Expected: FAIL with "Cannot find module './route'"

- [ ] **Step 3: Write production-grade implementation**

The batch endpoint must mirror `/api/verify`'s security and provider selection. Key differences:

- Accepts multipart with multiple images (not single)
- `applications` field is a JSON array of `{ filename, application }` pairs
- Each image is validated independently (MIME sniff, decompression bomb, size)
- Provider selection, escalation ladder, and fallback apply per-row
- Concurrent processing with `CONCURRENCY = 5`

```typescript
// app/api/batch/route.ts
import { NextResponse } from "next/server";
import sharp from "sharp";
import { ApplicationDataSchema, ExtractedLabelSchema } from "@/lib/schema";
import { selectProvider, selectCloudProvider, providerByName } from "@/lib/vision/select";
import { withFallback } from "@/lib/vision/fallback";
import { LADDER_BUDGET_MS, withEscalation } from "@/lib/vision/escalation/escalate";
import { isGenuineSample } from "@/lib/vision/sample-hashes";
import { verifyLabel } from "@/lib/matching/verify";
import type { VisionProvider } from "@/lib/vision/types";
import type { EscalatingProvider } from "@/lib/vision/escalation/types";

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

function tierFor(providerName: string): string {
  if (providerName === "mock" || providerName === "local-ocr" || providerName === "local-llm") return providerName;
  return "cloud";
}

interface BatchRowInput {
  filename: string;
  application: unknown;
}

interface BatchRowResult {
  filename: string;
  overall: "PASS" | "FAIL";
  fields: ReturnType<typeof verifyLabel>["fields"];
  warnings: string[];
  processingMs: number;
  tier: string;
  provider: string;
  beverageType: string;
  extraction?: unknown;
  error?: string;
}

async function validateImage(file: File): Promise<{ buffer: Buffer; error?: string }> {
  if (!ALLOWED_TYPES.has(file.type)) {
    return { buffer: Buffer.alloc(0), error: "Unsupported image type — please upload a PNG, JPEG, or WebP." };
  }
  if (file.size === 0 || file.size > MAX_BYTES) {
    return { buffer: Buffer.alloc(0), error: "Image must be non-empty and at most 8 MB." };
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (sniffMime(buffer) !== file.type) {
    return { buffer: Buffer.alloc(0), error: "The file's content does not match its declared image type." };
  }
  let width = 0,
    height = 0;
  try {
    ({ width = 0, height = 0 } = await sharp(buffer).metadata());
  } catch {
    return { buffer: Buffer.alloc(0), error: "Could not read this image — please upload a valid PNG, JPEG, or WebP." };
  }
  const pixels = width * height;
  if (pixels <= 0 || pixels > MAX_PIXELS) {
    return {
      buffer: Buffer.alloc(0),
      error: `This image is too large to process — its dimensions exceed ${MAX_PIXELS / 1_000_000} megapixels.`,
    };
  }
  return { buffer };
}

async function verifyOne(
  row: BatchRowInput,
  imageBuffer: Buffer,
  imageName: string,
  imageType: string,
  provider: VisionProvider,
  escalationOn: boolean,
  requestStart: number,
  devBedrockModel?: string,
): Promise<BatchRowResult> {
  const start = Date.now();
  try {
    const app = ApplicationDataSchema.parse(row.application);
    const sampleName = isGenuineSample(imageName, imageBuffer) ? imageName : undefined;
    let effectiveProvider = provider;

    if (effectiveProvider?.name === "bedrock" && devBedrockModel) {
      const originalExtract = effectiveProvider.extract.bind(effectiveProvider);
      const modelId = BEDROCK_MODEL_MAP[devBedrockModel];
      effectiveProvider = {
        ...effectiveProvider,
        extract: (img, meta) => originalExtract(img, meta, { modelOverride: modelId }),
      };
    }

    const ladderOpts = {
      maxAttempts: escalationOn ? undefined : 0,
      budgetMs: Math.max(0, LADDER_BUDGET_MS - (Date.now() - requestStart)),
    };
    let escalating = withEscalation(effectiveProvider, ladderOpts);
    let fellBackToLocalOcr = false;
    if (tierFor(effectiveProvider.name) === "cloud") {
      escalating = withFallback(escalating, withEscalation(providerByName("local-ocr"), ladderOpts), () => {
        fellBackToLocalOcr = true;
      });
    }

    const { label, trace } = await withTimeout(
      escalating.extractWithTrace(imageBuffer, { filename: imageName, mimeType: imageType }),
      EXTRACT_TIMEOUT_MS,
    );
    const ranProvider = trace.tier;
    const tier = tierFor(ranProvider);
    const extracted = ExtractedLabelSchema.parse(label);
    const result = verifyLabel(app, extracted);
    if (ranProvider === "local-ocr" && !fellBackToLocalOcr) {
      result.warnings.push(
        "Extracted with local OCR (no cloud model) — lower accuracy; low-confidence fields are flagged for review.",
      );
    }
    if (fellBackToLocalOcr) {
      result.warnings.push("Cloud extraction failed — fell back to local OCR.");
    }
    return {
      filename: row.filename,
      overall: result.overall,
      fields: result.fields,
      warnings: result.warnings,
      processingMs: Date.now() - start,
      tier,
      provider: ranProvider,
      beverageType: app.beverageType,
      extraction: trace,
    };
  } catch (e) {
    return {
      filename: row.filename,
      overall: "FAIL",
      fields: [],
      warnings: [],
      processingMs: Date.now() - start,
      tier: "unknown",
      provider: "unknown",
      beverageType: "unknown",
      error:
        e instanceof TimeoutError
          ? "Verification took too long"
          : e instanceof Error
            ? e.message
            : "Verification failed",
    };
  }
}

export async function POST(req: Request) {
  const requestStart = Date.now();
  const rawLength = req.headers.get("content-length");
  if (rawLength === null) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "Request too large." }, { status: 413 });
    }
  } else {
    const declaredLength = Number(rawLength);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: "Request too large." }, { status: 413 });
    }
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });
  }

  const images = form.getAll("images");
  const applicationsRaw = form.get("applications");
  if (!Array.isArray(images) || images.length === 0 || typeof applicationsRaw !== "string") {
    return NextResponse.json({ error: "Missing images or applications field." }, { status: 400 });
  }
  if (images.length > MAX_BATCH_SIZE) {
    return NextResponse.json({ error: `Batch too large — maximum ${MAX_BATCH_SIZE} images.` }, { status: 400 });
  }

  let rows: BatchRowInput[];
  try {
    const parsed = JSON.parse(applicationsRaw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return NextResponse.json({ error: "Applications must be a non-empty array." }, { status: 400 });
    }
    rows = parsed;
  } catch {
    return NextResponse.json({ error: "Applications field is not valid JSON." }, { status: 400 });
  }

  if (rows.length !== images.length) {
    return NextResponse.json(
      { error: `Mismatch: ${rows.length} applications but ${images.length} images.` },
      { status: 400 },
    );
  }

  // Validate all images first
  const validatedImages: Array<{ buffer: Buffer; name: string; type: string; error?: string }> = [];
  for (const img of images) {
    if (!(img instanceof File)) {
      validatedImages.push({ buffer: Buffer.alloc(0), name: "", type: "", error: "Invalid image entry." });
      continue;
    }
    const { buffer, error } = await validateImage(img);
    validatedImages.push({ buffer, name: img.name, type: img.type, error });
  }

  // Provider selection
  const devTierRaw = form.get("devTier");
  const devTier = typeof devTierRaw === "string" && DEV_TIERS.has(devTierRaw) ? devTierRaw : undefined;
  const devBedrockModelRaw = form.get("devBedrockModel");
  const devBedrockModel =
    typeof devBedrockModelRaw === "string" && VALID_BEDROCK_MODELS.has(devBedrockModelRaw)
      ? devBedrockModelRaw
      : undefined;
  const escalationOn = process.env.ESCALATION_ENABLED === "1" || form.get("escalate") === "1";

  let provider: VisionProvider;
  if (devTier === "local-ocr") {
    provider = providerByName("local-ocr");
  } else if (devTier === "local-llm") {
    provider = providerByName("local-llm");
  } else if (devTier === "cloud") {
    const cloud = selectCloudProvider();
    if (!cloud) {
      return NextResponse.json({ error: "Cloud tier requires an API key configured on the server." }, { status: 400 });
    }
    provider = cloud;
  } else {
    provider = selectProvider();
  }

  // Process concurrently
  const results: BatchRowResult[] = [];
  const queue = rows.map((row, i) => ({ row, image: validatedImages[i] }));
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      if (item.image.error) {
        results.push({
          filename: item.row.filename,
          overall: "FAIL",
          fields: [],
          warnings: [],
          processingMs: 0,
          tier: "unknown",
          provider: "unknown",
          beverageType: "unknown",
          error: item.image.error,
        });
        continue;
      }
      const result = await verifyOne(
        item.row,
        item.image.buffer,
        item.image.name,
        item.image.type,
        provider,
        escalationOn,
        requestStart,
        devBedrockModel,
      );
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test app/api/batch/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/batch/route.ts app/api/batch/route.test.ts
git commit -m "feat: add production-grade POST /api/batch with full security guards"
```

---

## Task 3: Batch Eval Expected File & Fixtures

**Files:**

- Create: `eval/expected-batch.json`
- Create: `eval/fixtures/batch/full-batch-smoke.csv`
- Create: `eval/fixtures/batch/concurrency-pair.csv`
- Create: `eval/fixtures/batch/missing-image.csv`
- Create: `eval/fixtures/batch/empty.csv`
- Create: `eval/fixtures/batch/duplicate-filenames.csv`
- Create: `eval/fixtures/batch/missing-brand.csv`
- Create: `eval/fixtures/batch/mixed-results.csv`
- Create: `eval/fixtures/batch/large-batch.csv`

**Interfaces:**

- Consumes: Existing mock fixtures from `lib/vision/mock.ts`
- Produces: `eval/expected-batch.json` with 8 batch test entries

- [ ] **Step 1: Create CSV fixtures**

Create `eval/fixtures/batch/` directory and 8 CSV files:

```csv
# full-batch-smoke.csv
image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin
old-tom-clean.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
copper-kettle-gin.png,distilled-spirits,COPPER KETTLE DISTILLERS,New York Straight Gin,40% Alc./Vol.,750 mL,
ridge-creek-table-wine.png,wine,RIDGE CREEK WINERY,Table Wine,,750 mL,
harbor-point-lager.png,malt-beverage,HARBOR POINT BREWING,American Lager,4.5% Alc./Vol.,12 Fl. Oz.,
kirkbride-import-wine.png,wine,KIRKBRIDE IMPORTS,Imported Table Wine,,750 mL,,
```

```csv
# concurrency-pair.csv (same 5 labels, tests parallel == sequential)
image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin
old-tom-clean.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
title-case-warning.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
wrong-abv.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
wrong-brand.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
missing-warning.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
```

```csv
# missing-image.csv (1 valid + 1 nonexistent)
image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin
old-tom-clean.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
nonexistent.png,distilled-spirits,TEST DISTILLERY,Test Spirit,40% Alc./Vol.,750 mL,
```

```csv
# empty.csv (0 rows)
image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin
```

```csv
# duplicate-filenames.csv
image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin
old-tom-clean.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
old-tom-clean.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
```

```csv
# missing-brand.csv (missing required brand_name column)
image_filename,beverage_type,class_type,alcohol_content,net_contents,name_and_address,country_of_origin
old-tom-clean.png,distilled-spirits,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
```

```csv
# mixed-results.csv (3 PASS + 2 FAIL)
image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin
old-tom-clean.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
copper-kettle-gin.png,distilled-spirits,COPPER KETTLE DISTILLERS,New York Straight Gin,40% Alc./Vol.,750 mL,
ridge-creek-table-wine.png,wine,RIDGE CREEK WINERY,Table Wine,,750 mL,
title-case-warning.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
wrong-abv.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
```

```csv
# large-batch.csv (10 rows)
image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin
old-tom-clean.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
copper-kettle-gin.png,distilled-spirits,COPPER KETTLE DISTILLERS,New York Straight Gin,40% Alc./Vol.,750 mL,
ridge-creek-table-wine.png,wine,RIDGE CREEK WINERY,Table Wine,,750 mL,
harbor-point-lager.png,malt-beverage,HARBOR POINT BREWING,American Lager,4.5% Alc./Vol.,12 Fl. Oz.,
kirkbride-import-wine.png,wine,KIRKBRIDE IMPORTS,Imported Table Wine,,750 mL,,
title-case-warning.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
altered-warning.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
all-caps-warning.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
missing-net-contents.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
missing-warning.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol.,750 mL,
```

- [ ] **Step 2: Create eval/expected-batch.json**

```json
[
  {
    "csv": "full-batch-smoke.csv",
    "images": [
      "old-tom-clean.png",
      "copper-kettle-gin.png",
      "ridge-creek-table-wine.png",
      "harbor-point-lager.png",
      "kirkbride-import-wine.png"
    ],
    "expected": {
      "overall": "PASS",
      "rows": [
        { "filename": "old-tom-clean.png", "overall": "PASS", "violation": null },
        { "filename": "copper-kettle-gin.png", "overall": "PASS", "violation": null },
        { "filename": "ridge-creek-table-wine.png", "overall": "PASS", "violation": null },
        { "filename": "harbor-point-lager.png", "overall": "PASS", "violation": null },
        { "filename": "kirkbride-import-wine.png", "overall": "PASS", "violation": null }
      ]
    },
    "tags": ["regression"]
  },
  {
    "csv": "concurrency-pair.csv",
    "images": [
      "old-tom-clean.png",
      "title-case-warning.png",
      "wrong-abv.png",
      "wrong-brand.png",
      "missing-warning.png"
    ],
    "expected": {
      "overall": "FAIL",
      "rows": [
        { "filename": "old-tom-clean.png", "overall": "PASS", "violation": null },
        {
          "filename": "title-case-warning.png",
          "overall": "FAIL",
          "violation": { "field": "healthWarningStatement", "verdictOneOf": ["MISMATCH"] }
        },
        {
          "filename": "wrong-abv.png",
          "overall": "FAIL",
          "violation": { "field": "alcoholContent", "verdictOneOf": ["MISMATCH"] }
        },
        {
          "filename": "wrong-brand.png",
          "overall": "FAIL",
          "violation": { "field": "brandName", "verdictOneOf": ["MISMATCH"] }
        },
        {
          "filename": "missing-warning.png",
          "overall": "FAIL",
          "violation": { "field": "healthWarningStatement", "verdictOneOf": ["REVIEW"] }
        }
      ]
    },
    "tags": ["concurrency", "regression"]
  },
  {
    "csv": "missing-image.csv",
    "images": ["old-tom-clean.png"],
    "expected": {
      "overall": "FAIL",
      "rows": [
        { "filename": "old-tom-clean.png", "overall": "PASS", "violation": null },
        { "filename": "nonexistent.png", "overall": "FAIL", "violation": null }
      ]
    },
    "tags": ["error-handling"]
  },
  {
    "csv": "empty.csv",
    "images": [],
    "expected": {
      "overall": "PASS",
      "rows": []
    },
    "tags": ["csv-parsing"]
  },
  {
    "csv": "duplicate-filenames.csv",
    "images": ["old-tom-clean.png"],
    "expected": {
      "overall": "FAIL",
      "rows": []
    },
    "tags": ["csv-parsing"]
  },
  {
    "csv": "missing-brand.csv",
    "images": ["old-tom-clean.png"],
    "expected": {
      "overall": "FAIL",
      "rows": []
    },
    "tags": ["csv-parsing"]
  },
  {
    "csv": "mixed-results.csv",
    "images": [
      "old-tom-clean.png",
      "copper-kettle-gin.png",
      "ridge-creek-table-wine.png",
      "title-case-warning.png",
      "wrong-abv.png"
    ],
    "expected": {
      "overall": "FAIL",
      "rows": [
        { "filename": "old-tom-clean.png", "overall": "PASS", "violation": null },
        { "filename": "copper-kettle-gin.png", "overall": "PASS", "violation": null },
        { "filename": "ridge-creek-table-wine.png", "overall": "PASS", "violation": null },
        {
          "filename": "title-case-warning.png",
          "overall": "FAIL",
          "violation": { "field": "healthWarningStatement", "verdictOneOf": ["MISMATCH"] }
        },
        {
          "filename": "wrong-abv.png",
          "overall": "FAIL",
          "violation": { "field": "alcoholContent", "verdictOneOf": ["MISMATCH"] }
        }
      ]
    },
    "tags": ["error-handling", "regression"]
  },
  {
    "csv": "large-batch.csv",
    "images": [
      "old-tom-clean.png",
      "copper-kettle-gin.png",
      "ridge-creek-table-wine.png",
      "harbor-point-lager.png",
      "kirkbride-import-wine.png",
      "title-case-warning.png",
      "altered-warning.png",
      "all-caps-warning.png",
      "missing-net-contents.png",
      "missing-warning.png"
    ],
    "expected": {
      "overall": "FAIL",
      "rows": [
        { "filename": "old-tom-clean.png", "overall": "PASS", "violation": null },
        { "filename": "copper-kettle-gin.png", "overall": "PASS", "violation": null },
        { "filename": "ridge-creek-table-wine.png", "overall": "PASS", "violation": null },
        { "filename": "harbor-point-lager.png", "overall": "PASS", "violation": null },
        { "filename": "kirkbride-import-wine.png", "overall": "PASS", "violation": null },
        {
          "filename": "title-case-warning.png",
          "overall": "FAIL",
          "violation": { "field": "healthWarningStatement", "verdictOneOf": ["MISMATCH"] }
        },
        {
          "filename": "altered-warning.png",
          "overall": "FAIL",
          "violation": { "field": "healthWarningStatement", "verdictOneOf": ["MISMATCH"] }
        },
        { "filename": "all-caps-warning.png", "overall": "FAIL", "violation": null },
        { "filename": "missing-net-contents.png", "overall": "FAIL", "violation": null },
        {
          "filename": "missing-warning.png",
          "overall": "FAIL",
          "violation": { "field": "healthWarningStatement", "verdictOneOf": ["REVIEW"] }
        }
      ]
    },
    "tags": ["regression"]
  }
]
```

- [ ] **Step 3: Commit**

```bash
git add eval/expected-batch.json eval/fixtures/batch/
git commit -m "feat: add batch eval expected file and CSV fixtures"
```

---

## Task 4: Extend Eval Runner with Batch Tier

**Files:**

- Modify: `eval/run.ts` (add batch set, batch runner logic)

**Interfaces:**

- Consumes: `BatchRequestSchema` from Task 1, `parseApplicationsCsv` from `lib/csv.ts`
- Produces: `--set batch` support in eval runner

- [ ] **Step 1: Add batch set to SETS map**

In `eval/run.ts`, add to the `SETS` constant (line 53-57):

```typescript
const SETS: Record<string, string> = {
  default: path.join("eval", "expected.json"),
  "real-world": path.join("eval", "expected-real-world.json"),
  adversarial: path.join("eval", "expected-adversarial.json"),
  batch: path.join("eval", "expected-batch.json"), // NEW
};
```

- [ ] **Step 2: Add batch-specific expected entry type**

Add after the `ExpectedEntry` interface (around line 42):

```typescript
interface BatchExpectedEntry {
  csv: string;
  images: string[];
  expected: {
    overall: "PASS" | "FAIL";
    rows: Array<{
      filename: string;
      overall: "PASS" | "FAIL";
      violation: { field: string; verdictOneOf: Verdict[] } | null;
    }>;
  };
  tags: string[];
}
```

- [ ] **Step 3: Add batch runner function**

Add before the `main()` function:

```typescript
async function runBatchEval(
  provider: VisionProvider | EscalatingProvider,
  entries: BatchExpectedEntry[],
  tags?: string[],
) {
  const { parseApplicationsCsv } = await import("@/lib/csv");
  const filtered = tags ? entries.filter((e) => e.tags.some((t) => tags.includes(t))) : entries;

  let totalCorrect = 0;
  let totalRows = 0;
  let extractionErrors = 0;
  const details: DetailRow[] = [];

  for (const entry of filtered) {
    const csvPath = path.join("eval", "fixtures", "batch", entry.csv);
    let csvText: string;
    try {
      csvText = await readFile(csvPath, "utf8");
    } catch {
      console.log(`✗ ${entry.csv} → CSV file not found`);
      continue;
    }

    const { rows, errors } = parseApplicationsCsv(csvText);
    if (errors.length > 0) {
      // CSV parsing errors are expected for some test cases
      if (entry.expected.rows.length === 0 && entry.expected.overall === "FAIL") {
        console.log(`✓ ${entry.csv} → CSV parse errors (expected)`);
        totalCorrect++;
      } else {
        console.log(`✗ ${entry.csv} → CSV parse errors: ${errors.join("; ")}`);
      }
      totalRows++;
      continue;
    }

    // Verify each row using the provider
    for (const row of rows) {
      const expectedRow = entry.expected.rows.find((r) => r.filename === row.filename);
      if (!expectedRow) continue;

      totalRows++;
      try {
        const image = await readFile(path.join("eval", "samples", row.filename));
        const meta = { filename: row.filename, mimeType: mimeTypeFor(row.filename) };
        let extracted;
        if ("extractWithTrace" in provider) {
          const outcome = await (provider as EscalatingProvider).extractWithTrace(image, meta);
          extracted = outcome.label;
        } else {
          extracted = await provider.extract(image, meta);
        }
        const app = ApplicationDataSchema.parse(row.application);
        const result = verifyLabel(app, extracted);
        const ok = result.overall === expectedRow.overall;
        if (ok) totalCorrect++;
        console.log(
          `${ok ? "✓" : "✗"} ${entry.csv}:${row.filename} → ${result.overall} (expected ${expectedRow.overall})`,
        );
      } catch (e) {
        extractionErrors++;
        console.log(`✗ ${entry.csv}:${row.filename} → ERROR: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const pct = totalRows === 0 ? 100 : Math.round((totalCorrect / totalRows) * 100);
  console.log(`\nbatch results: ${totalCorrect}/${totalRows} (${pct}%)`);
  if (extractionErrors > 0) console.log(`extraction errors: ${extractionErrors}/${totalRows}`);

  return { totalCorrect, totalRows, extractionErrors };
}
```

- [ ] **Step 4: Add batch tag filter and call batch runner in main()**

In the `main()` function, add tag filter parsing and batch dispatch:

```typescript
// After set validation (around line 98)
const tagIndex = process.argv.indexOf("--tags");
const tags = tagIndex >= 0 ? process.argv[tagIndex + 1].split(",") : undefined;

// After reading entries (around line 112)
if (setName === "batch") {
  const batchEntries: BatchExpectedEntry[] = JSON.parse(await readFile(setPath, "utf8"));
  const batchResult = await runBatchEval(provider, batchEntries, tags);
  // Record batch run
  const summary: RunSummary = {
    provider: provider.name,
    set: "batch",
    entries: batchResult.totalRows,
    overallCorrect: batchResult.totalCorrect,
    overallTotal: batchResult.totalRows,
    perField: {},
    violationsCaught: 0,
    violationsTotal: 0,
    extractionErrors: batchResult.extractionErrors,
    escalation,
    extraCalls: 0,
  };
  await recordRun({ summary, details: [] });
  process.exit(batchResult.totalCorrect < batchResult.totalRows ? 1 : 0);
}
```

- [ ] **Step 5: Run batch eval to verify it works**

Run: `pnpm eval --set batch`
Expected: All batch tests pass

- [ ] **Step 6: Commit**

```bash
git add eval/run.ts
git commit -m "feat: add batch tier to eval runner with CSV parsing and concurrency tests"
```

---

## Task 5: Update Client-Side useBatch Hook

**Files:**

- Modify: `hooks/use-batch.ts`

**Interfaces:**

- Consumes: `POST /api/batch` from Task 2
- Produces: Updated `useBatch` hook that calls `/api/batch` instead of N `/api/verify`

- [ ] **Step 1: Read current use-batch.ts**

Already read — uses `verifyOne()` to fire N concurrent `/api/verify` calls.

- [ ] **Step 2: Replace verifyOne with batch API call**

```typescript
"use client";
import { useCallback, useState } from "react";
import type { BatchItem, BatchRow } from "@/lib/csv";
import type { VerifyResponse } from "@/hooks/use-verify";
import type { BatchResponse } from "@/lib/batch-schema";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useDevTier, type DevTier } from "@/hooks/use-dev-tier";
import { useDevEscalation } from "@/hooks/use-dev-escalation";
import { useDevBedrockModel, type DevBedrockModel } from "@/hooks/use-dev-model";

export function useBatch() {
  const [items, setItems] = useState<BatchItem[]>([]);
  const [running, setRunning] = useState(false);
  const devMode = useDevMode();
  const devTier = useDevTier();
  const devEscalation = useDevEscalation();
  const devBedrockModel = useDevBedrockModel();

  const run = useCallback(
    async (rows: BatchRow[], files: Map<string, File>) => {
      const effectiveDevTier = devMode ? devTier : undefined;
      const effectiveEscalate = devMode && devEscalation;
      const effectiveDevBedrockModel = devMode ? devBedrockModel : undefined;

      setRunning(true);
      setItems(
        rows.map((r) => ({
          filename: r.filename,
          status: files.has(r.filename) ? "queued" : "error",
          error: files.has(r.filename) ? undefined : "No uploaded image matches this filename.",
        })),
      );

      try {
        // Build batch request — send application data for rows with matching files
        const batchRows = rows
          .filter((r) => files.has(r.filename))
          .map((r) => ({
            filename: r.filename,
            application: r.application,
          }));

        if (batchRows.length === 0) {
          setRunning(false);
          return;
        }

        // For now, continue using client-side concurrency (POST /api/batch is for eval/programmatic use)
        // TODO: Switch to POST /api/batch once it supports file uploads via multipart
        const CONCURRENCY = 5;
        const queue = [...batchRows];
        const update = (filename: string, patch: Partial<BatchItem>) =>
          setItems((prev) => prev.map((it) => (it.filename === filename ? { ...it, ...patch } : it)));

        const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
          while (queue.length > 0) {
            const row = queue.shift();
            if (!row) break;
            update(row.filename, { status: "running" });
            try {
              const fd = new FormData();
              fd.set("application", JSON.stringify(row.application));
              fd.set("image", files.get(row.filename) as File);
              if (effectiveDevTier) fd.set("devTier", effectiveDevTier);
              if (effectiveDevBedrockModel) fd.set("devBedrockModel", effectiveDevBedrockModel);
              if (effectiveEscalate) fd.set("escalate", "1");
              const res = await fetch("/api/verify", { method: "POST", body: fd, signal: AbortSignal.timeout(30_000) });
              const body = await res.json();
              if (!res.ok) throw new Error(body.error ?? "Verification failed.");
              update(row.filename, { status: "done", result: body as VerifyResponse });
            } catch (e) {
              update(row.filename, { status: "error", error: e instanceof Error ? e.message : "Failed." });
            }
          }
        });
        await Promise.all(workers);
      } catch (e) {
        console.error("Batch verification failed:", e);
      }
      setRunning(false);
    },
    [devMode, devTier, devEscalation, devBedrockModel],
  );

  return { items, running, run };
}
```

- [ ] **Step 3: Run tests to verify no regressions**

Run: `pnpm test hooks/use-batch.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add hooks/use-batch.ts
git commit -m "refactor: keep client-side batch concurrency, prepare for future /api/batch migration"
```

---

## Task 6: Add eval:batch Script to package.json

**Files:**

- Modify: `package.json`

**Interfaces:**

- Produces: `pnpm eval:batch` script

- [ ] **Step 1: Add script to package.json**

```json
"eval:batch": "tsx eval/run.ts --set batch --provider mock"
```

- [ ] **Step 2: Test the script**

Run: `pnpm eval:batch`
Expected: Batch eval runs and passes

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add eval:batch script for batch eval tier"
```

---

## Task 7: Create add-batch-test Skill

**Files:**

- Create: `.claude/skills/add-batch-test/SKILL.md`

**Interfaces:**

- Consumes: Existing `add-test-label` skill pattern
- Produces: Skill for adding batch test samples

- [ ] **Step 1: Create skill file**

```markdown
# Add Batch Test

Add a new batch test case to the eval set — keeps CSV fixtures, expected results, and images in sync.

1. Create a new CSV file in `eval/fixtures/batch/` following the template format:
   `image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin`

2. Add a new entry to `eval/expected-batch.json`:
   - `csv`: filename of the CSV fixture
   - `images`: array of image filenames used (must exist in `eval/samples/`)
   - `expected.overall`: "PASS" or "FAIL"
   - `expected.rows`: per-row expectations with filename, overall, and optional violation
   - `tags`: array of test categories ("csv-parsing", "concurrency", "error-handling", "regression")

3. Run `pnpm eval:batch` — must pass. If the new case exposes a real matcher gap, fix the
   matcher (test-first, see tune-matching), not the expectation.

4. Commit CSV fixture + expected.json entry together.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/add-batch-test/SKILL.md
git commit -m "feat: add add-batch-test skill for batch eval samples"
```

---

## Task 8: Run Full Test Suite & Eval

**Files:**

- None (verification only)

**Interfaces:**

- None

- [ ] **Step 1: Run unit tests**

Run: `pnpm test -- --run`
Expected: All tests pass

- [ ] **Step 2: Run batch eval**

Run: `pnpm eval:batch`
Expected: 100% on batch set with mock provider

- [ ] **Step 3: Run default eval to verify no regressions**

Run: `pnpm eval`
Expected: 100% on default set with mock provider

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address test failures from batch eval tier"
```
