# local-ocr image preprocessing — design (2026-07-24)

## Motivation

`docs/deferred-items-and-tradeoffs-2026-07-23.md`'s latest update records a concrete, per-image
diagnosis of why the line-level prominence/confidence work (this same day) landed flat on
`pnpm eval:real-world`: on the images where a fix would have mattered, the true brand text was
never recognized by Tesseract as usable text at all — not a selection problem, a recognition
problem. Image preprocessing (contrast normalization, deskew) was explicitly named and deferred as
a non-goal in the original Phase 1 spec ("no image preprocessing... noted here because it's a
known lever, not because it's out of scope forever"). This spec picks that up.

Deskew (true rotation-angle correction) turns out to need a real detection algorithm — a Hough
transform or projection-profile analysis over text baselines — that neither `sharp` nor
`tesseract.js` provides out of the box; Tesseract's own "OSD" only detects gross 90°/180°/270°
orientation, not the 6–12° skew the eval's degraded fixtures use. Per-user decision: **deskew is
out of scope for this spec**, deferred to a separate, later investigation if the simpler techniques
prove insufficient.

## Non-goals

- Deskew / rotation-angle detection and correction (see above).
- Real super-resolution for low-resolution images — `sharp` has no ML-based upscaling; naive
  interpolation adds no real information.
- Any change to `ocr-parser.ts`, its `OcrLine`/`parseOcrText` interface, or field-selection logic —
  this is purely an image-preparation change, upstream of everything built earlier today.
- Any change to the mock tier or cloud tiers (Gemini/Claude/OpenAI/Groq) — this is specifically
  about helping Tesseract's character-recognition step; vision-LLM tiers already see the full image
  and don't need (and could plausibly be hurt by) classical greyscale/contrast preprocessing.
- Adaptive/conditional preprocessing (Approach C) or dual-pass-pick-better (Approach B) — see
  "Approaches considered" below. Both are explicitly deferred until Approach A's measured delta
  shows they're actually warranted.

## Approaches considered

1. **Always-on single pass (chosen).** Apply greyscale → contrast-normalize → mild sharpen
   unconditionally, replacing today's "already small enough, skip everything" fast path. Simplest:
   no added latency beyond one small always-on encode step, no new heuristics to tune or get wrong.
   Risk: could regress some already-clean images (over-processing sometimes hurts contrast/sharpness
   that was already fine) — this is what Task 2 of the plan measures directly, not assumes away.
2. **Dual-pass, pick the better result.** Run OCR on both the original and the preprocessed version,
   keep whichever scores better. Hedges against regression risk but roughly doubles Tesseract
   recognition time per request — a real concern against the `< 5s single-label verify` latency
   budget (`CLAUDE.md`) — and needs a result-scoring heuristic. Deferred: build only if Approach A's
   measured delta shows real regressions worth hedging against.
3. **Adaptive single pass.** Cheaply inspect the image first (e.g. `sharp`'s `.stats()` as a fast
   contrast proxy) to decide whether to preprocess at all. Avoids (2)'s latency cost but trades it
   for a new "does this image need help" heuristic that can be wrong in either direction. Same
   deferral as (2).

## Design

### `prepareForOcr` restructure

`lib/vision/local-ocr.ts`'s `prepareForOcr` currently has a fast path that skips `sharp` entirely
for images already under `MAX_OCR_DIMENSION`, and a slow path that resizes. Since preprocessing must
now run unconditionally (Approach A), both paths collapse into one pipeline:

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

Order matters: resize (if needed) happens before greyscale/normalize/sharpen, since sharpening is
resolution-dependent — sharpening before a resize would either double-work or interact oddly with
the resize's own interpolation. `.greyscale()` converts to single-channel (fine for OCR — Tesseract
works on greyscale/binarized data internally regardless); `.normalize()` stretches the luminance
histogram to use the full 0–255 range (the actual contrast fix); `.sharpen()` uses `sharp`'s default
unsharp-mask parameters — no custom tuning, avoiding premature optimization of parameters nothing
has justified yet.

**As-built correction:** `.greyscale()` alone does not actually produce a true single-channel image
— it keeps 3 identical (R=G=B) channels. The shipped code adds `.extractChannel(0)` after `.sharpen()`
to force one, confirmed (not assumed) to be byte-for-byte equivalent to a genuinely single-channel
pipeline since sharpening three identical channels with the same convolution keeps them identical.

The existing try/catch is unchanged in shape — it already falls back to the untouched original
buffer + zero dimensions on any decode failure, and now covers the new steps too (they're inside the
same pipeline, so a failure anywhere degrades exactly the same way as today's resize failure does).

`localOcrProvider.extract()` itself is unchanged — it already just destructures `{buffer, width,
height}` from `prepareForOcr` and passes them through; this spec doesn't touch it.

## Testing

- New test file `lib/vision/local-ocr-preprocessing.test.ts`, mirroring the existing
  `local-ocr-downscale.test.ts`'s pattern (mock `tesseract.js`, capture the buffer actually handed to
  `recognize()`):
  - Construct a synthetic low-contrast image via `sharp(rawBuffer, { raw: { width, height, channels
} })` with a deliberately narrow pixel-value range (e.g. 108–148, well short of 0–255) — a
    controlled stand-in for a real photo's uneven lighting/faded print, not a guess.
  - Assert the captured buffer's actual pixel statistics improved: `sharp(captured).stats()`'s
    channel range is wider than the input's narrow range (contrast genuinely increased, not just
    "a normalize call was made"), and `sharp(captured).metadata().channels === 1` (greyscale
    conversion happened).
  - Assert an already-small image (previously the "skip everything" fast path) now also comes out
    greyscale/normalized, confirming the fast-path removal.
- Existing `local-ocr-downscale.test.ts` tests (resize behavior) must keep passing unchanged — they
  assert the resized buffer's _dimensions_, which preprocessing doesn't affect.
- Existing `local-ocr.test.ts` tests (worker singleton, blocks flattening, `Buffer.alloc(0)` decode
  failure) must keep passing unchanged — none of them assert on pixel content, only on
  presence/confidence/dimensions, so greyscale conversion doesn't affect their assertions.
- Validation: same eval-delta methodology used earlier today, not assumed —
  1. `pnpm eval` (mock tier) must stay at 100% — mock never reaches `local-ocr.ts`.
  2. `pnpm eval:real-world` — record overall + per-field accuracy.
  3. Per-item diff (not just aggregate) against the pre-preprocessing baseline (`git worktree add` at
     the commit before this plan, same technique used to diagnose today's flat result), specifically
     checking for **regressions** (a previously-correct field becoming wrong) as well as
     improvements — Approach A's real, not-yet-measured risk.

## Known limitations (carried forward)

- Deskew remains unaddressed — a photo skewed by more than a few degrees is unaffected by this pass.
- Glare (a genuinely blown-out/clipped highlight, as the `-glare` and `-combo` degraded fixtures
  simulate) has lost real information at the clipped pixels; contrast normalization can help the
  surrounding unaffected area but cannot recover data that was never captured.
- A brand rendered as a stylized logo/wordmark rather than printed text (the Chateau Ste Michelle
  case from today's diagnosis) isn't a preprocessing problem at all — no image enhancement makes
  non-text into recognizable text. That class of failure's real fix is the vision-LLM cloud tier,
  not further local-ocr work.
