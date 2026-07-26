# local-ocr image preprocessing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply greyscale + contrast normalization + mild sharpening to every image before local-OCR
recognition, replacing the current "skip everything if already small" fast path, and measure the
real per-item eval impact (not just aggregate) rather than assuming it helps.

**Architecture:** `lib/vision/local-ocr.ts`'s `prepareForOcr` collapses its two paths (resize-needed /
already-small) into one `sharp` pipeline: decode → resize (if needed) → greyscale → normalize →
sharpen → encode once. No other file changes — `ocr-parser.ts`'s interface, cloud tiers, and the
mock tier are untouched.

**Tech Stack:** TypeScript, `sharp` 0.35.3, `tesseract.js` 7, Vitest.

## Global Constraints

- Invariant 7 (`CLAUDE.md`): fail closed, per item — any preprocessing failure must degrade to the
  original untouched buffer + zero dimensions (the existing catch-all), never throw, never disable
  the keyless default tier.
- Latency budget: single-label verify < 5s end-to-end (`CLAUDE.md`) — the new steps must not add a
  second Tesseract recognition pass; exactly one `recognize()` call per request, as today.
- Deskew is explicitly out of scope for this plan (per the spec) — do not attempt rotation-angle
  detection/correction.
- No changes to `lib/vision/ocr-parser.ts`, its `OcrLine`/`parseOcrText` signature, cloud tier files,
  or `lib/vision/mock.ts` — this plan is scoped entirely to `prepareForOcr` in `local-ocr.ts`.
- `pnpm eval` (mock tier) must stay at 100% throughout — mock never reaches `local-ocr.ts`.

---

### Task 1: Restructure `prepareForOcr` with always-on preprocessing

**Files:**

- Modify: `lib/vision/local-ocr.ts`
- Create: `lib/vision/local-ocr-preprocessing.test.ts`

**Interfaces:**

- No signature change — `prepareForOcr` still returns `Promise<{ buffer: Buffer; width: number; height: number }>`; `localOcrProvider.extract()` is unchanged.

- [ ] **Step 1: Write the failing tests in a new file**

Create `lib/vision/local-ocr-preprocessing.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const mockRecognize = vi.fn();
vi.mock("tesseract.js", () => ({
  createWorker: async () => ({ recognize: mockRecognize, setParameters: vi.fn().mockResolvedValue(undefined) }),
  PSM: { SINGLE_COLUMN: "4" },
}));

import { localOcrProvider } from "@/lib/vision/local-ocr";

const meta = { filename: "x.png", mimeType: "image/png" };

// A deliberately narrow pixel-value range (108-148, far short of 0-255) as a controlled stand-in
// for a real photo's uneven lighting/faded print — not a guess, a fixed, checkable input.
function lowContrastImage(width: number, height: number): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    const v = i % 2 === 0 ? 108 : 148;
    raw[i * channels] = v;
    raw[i * channels + 1] = v;
    raw[i * channels + 2] = v;
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

function captureRecognizedImage(): { get: () => Buffer | undefined } {
  let received: Buffer | undefined;
  mockRecognize.mockImplementation((img: Buffer) => {
    received = img;
    return { data: { text: "HELLO 750 mL", confidence: 88 } };
  });
  return { get: () => received };
}

afterEach(() => vi.clearAllMocks());

describe("localOcrProvider — image preprocessing before OCR", () => {
  it("widens a low-contrast image's luminance range and converts to greyscale", async () => {
    const input = lowContrastImage(100, 100);
    const before = await sharp(await input).stats();
    const beforeRange = before.channels[0].max - before.channels[0].min;
    expect(beforeRange).toBeLessThan(60); // confirm the fixture is genuinely low-contrast

    const cap = captureRecognizedImage();
    await localOcrProvider.extract(await input, meta);
    const captured = cap.get()!;

    const after = await sharp(captured).stats();
    const afterRange = after.channels[0].max - after.channels[0].min;
    expect(afterRange).toBeGreaterThan(beforeRange);

    const afterMeta = await sharp(captured).metadata();
    expect(afterMeta.channels).toBe(1);
  });

  it("still preprocesses an already-small image (the old fast path skipped this entirely)", async () => {
    const input = await sharp({
      create: { width: 300, height: 200, channels: 3, background: { r: 220, g: 220, b: 220 } },
    })
      .png()
      .toBuffer();
    const cap = captureRecognizedImage();
    await localOcrProvider.extract(input, meta);
    const captured = cap.get()!;
    const capturedMeta = await sharp(captured).metadata();
    expect(capturedMeta.channels).toBe(1); // greyscale now applies even without a resize
    expect(capturedMeta.width).toBe(300); // dimensions unaffected by greyscale/normalize/sharpen
    expect(capturedMeta.height).toBe(200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run lib/vision/local-ocr-preprocessing.test.ts`
Expected: FAIL — the current `prepareForOcr` doesn't apply greyscale/normalize, so `afterRange` won't
exceed `beforeRange` in the first test, and `capturedMeta.channels` will be `3` (RGB, unconverted) in
the second.

- [ ] **Step 3: Restructure `prepareForOcr`**

In `lib/vision/local-ocr.ts`, replace:

```ts
async function prepareForOcr(image: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
  try {
    const { width = 0, height = 0 } = await sharp(image).metadata();
    if (Math.max(width, height) <= MAX_OCR_DIMENSION) return { buffer: image, width, height };
    const { data, info } = await sharp(image)
      .resize(MAX_OCR_DIMENSION, MAX_OCR_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  } catch {
    // Best effort: a decode/resize failure must not disable the keyless default tier. Hand the
    // original bytes to tesseract, which will surface any genuine decode error itself. Zero
    // dimensions degrade safely — toBoundingBox in ocr-parser.ts already returns a zero-size box
    // rather than dividing by zero.
    return { buffer: image, width: 0, height: 0 };
  }
}
```

with:

```ts
async function prepareForOcr(image: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
  try {
    const { width = 0, height = 0 } = await sharp(image).metadata();
    let pipeline = sharp(image);
    if (Math.max(width, height) > MAX_OCR_DIMENSION) {
      pipeline = pipeline.resize(MAX_OCR_DIMENSION, MAX_OCR_DIMENSION, { fit: "inside", withoutEnlargement: true });
    }
    // Grayscale + contrast normalize + mild sharpen: the classic OCR preprocessing recipe, applied
    // unconditionally (Approach A, per docs/superpowers/specs/2026-07-24-local-ocr-image-
    // preprocessing-design.md) rather than only on images heuristically judged to need it.
    pipeline = pipeline.greyscale().normalize().sharpen();
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  } catch {
    // Best effort: a decode/resize/preprocessing failure must not disable the keyless default tier.
    // Hand the original bytes to tesseract, which will surface any genuine decode error itself. Zero
    // dimensions degrade safely — toBoundingBox in ocr-parser.ts already returns a zero-size box
    // rather than dividing by zero.
    return { buffer: image, width: 0, height: 0 };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/vision/local-ocr-preprocessing.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Run the existing local-ocr test files to confirm no regression**

Run: `pnpm vitest run lib/vision/local-ocr.test.ts lib/vision/local-ocr-downscale.test.ts`
Expected: all pass unchanged. `local-ocr-downscale.test.ts`'s "passes an already-small image through
without enlarging it" test only asserts dimensions (unaffected by greyscale/normalize/sharpen), and
its solid-flat-color fixture has been confirmed empirically to pass through `.normalize()` without
error (min=max, no-op, no throw).

- [ ] **Step 6: Run the full suite, typecheck, and lint**

Run: `pnpm vitest run && pnpm exec tsc --noEmit && pnpm lint`
Expected: all pass, no type errors, no lint issues.

- [ ] **Step 7: Commit**

```bash
git add lib/vision/local-ocr.ts lib/vision/local-ocr-preprocessing.test.ts
git commit -m "Apply greyscale/contrast/sharpen preprocessing before local-OCR recognition

Collapses prepareForOcr's resize-needed and already-small fast paths
into one pipeline that always applies the classic OCR preprocessing
recipe (greyscale, contrast normalize, mild sharpen), replacing the
prior behavior of skipping preprocessing entirely for small images.
No interface change -- ocr-parser.ts, cloud tiers, and the mock tier
are untouched."
```

---

### Task 2: Validate the real per-item impact

**Files:**

- Modify: `docs/deferred-items-and-tradeoffs-2026-07-23.md` (append)

**Interfaces:** none — validation and record-keeping only, no code changes.

- [ ] **Step 1: Confirm the mock-tier gate is unaffected**

Run: `pnpm eval`
Expected: 13/13 (100%) — mock never reaches `local-ocr.ts`. If it's not 13/13, STOP — that would mean
something in Task 1 broke the mock tier unexpectedly, which must not happen.

- [ ] **Step 2: Run the real-world eval and save its per-item detail**

Run: `pnpm eval:real-world`
Record the overall accuracy, per-field accuracy, and planted-violation catch rate.
Copy `eval/.results/real-world-local-ocr.json` to a scratch location (e.g. your session's scratchpad
directory) as `new-real-world-local-ocr.json` — the per-item comparison in Step 4 needs both this and
the pre-change baseline.

- [ ] **Step 3: Capture the pre-change baseline in a temporary worktree**

```bash
git worktree add /tmp/preprocessing-baseline <commit-before-Task-1's-first-commit>
cd /tmp/preprocessing-baseline
pnpm install --frozen-lockfile
pnpm exec tsx eval/run.ts --set real-world --provider local-ocr
```

Copy that worktree's `eval/.results/real-world-local-ocr.json` to your scratchpad as
`old-real-world-local-ocr.json`. Then clean up:

```bash
cd -
git worktree remove /tmp/preprocessing-baseline --force
git worktree prune
```

- [ ] **Step 4: Diff per-item, not just aggregate**

Write a small script (Python or Node, scratch-only, not committed) that loads both JSON files, indexes
by `(file, field)`, and reports every entry where `extractedValue` or `actual` (verdict) differs
between old and new. For any entry where a field flips from `ok: true` to `ok: false` (a regression —
Approach A's real, not-yet-measured risk), call it out explicitly and by name; don't average it away
into an aggregate delta.

- [ ] **Step 5: Append the real numbers and per-item findings to the status doc**

Add a new section to `docs/deferred-items-and-tradeoffs-2026-07-23.md`, following the existing
`## Update 2026-07-24 — ...` sections' style: the aggregate delta, how many images had at least one
changed extraction, and — most importantly — whether any image _regressed_ (a field that was correct
before and is now wrong) versus only _changed without flipping_ versus genuinely _improved_ (a field
that was wrong before and is now correct). Name specific files for each category the way today's
prominence-work diagnosis did, not just counts.

- [ ] **Step 6: Commit**

```bash
git add docs/deferred-items-and-tradeoffs-2026-07-23.md
git commit -m "Record the local-ocr preprocessing eval delta, per-item"
```

## Self-Review

**Spec coverage:**

- Pipeline order (resize → greyscale → normalize → sharpen), always-on (no fast-path skip) — Task 1, Step 3. ✓
- Error handling unchanged (same try/catch, now covering more steps) — Task 1, Step 3. ✓
- No changes to `ocr-parser.ts`/cloud tiers/mock tier — enforced by Global Constraints; no task touches them. ✓
- Testing: real pixel-statistics assertions, not mock-and-assert-called — Task 1, Steps 1-2. ✓
- Deskew out of scope — no task attempts it. ✓
- Eval-delta validation with explicit regression check, not just aggregate — Task 2. ✓

**Placeholder scan:** Task 2, Step 3's `<commit-before-Task-1's-first-commit>` is a real instruction
to substitute the actual SHA at execution time (Task 1's first commit will exist by then), not a gap.

**Type consistency:** `prepareForOcr`'s return shape (`{ buffer, width, height }`) is unchanged from
the pre-existing code and matches what `localOcrProvider.extract()` already destructures — no new
type introduced.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-24-local-ocr-image-preprocessing.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
