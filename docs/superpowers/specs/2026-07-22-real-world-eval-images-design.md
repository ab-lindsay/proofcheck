# Real-world eval images — design (2026-07-22)

## Motivation

`pnpm eval` today only exercises 13 synthetic samples: clean serif text on a cream background,
rendered by `eval/generate-samples.ts` from `MOCK_FIXTURES`. That's sufficient to guard the
matching layer against regressions (its actual job), but it says nothing about how the extraction
tiers (`local-ocr`, `cloud`) hold up against real label photography or the imperfect conditions
described in the brief:

> "I've seen labels that are photographed at weird angles, or the lighting is bad, or there's
> glare on the bottle... if an agent can't read the label they just reject it and ask for a better
> image." — Jenny, `docs/BRIEF.md`

Separately, 10 real TTB-approved labels (17 images) were already fetched from the public COLA
registry during planning (`eval/samples/SOURCES.md`, commit `ad5673b`) — genuine design variety
(script fonts, low-contrast gray-on-gray, gold-on-dark, handwriting-style values, rotated warning
panels) — but never wired into `eval/expected.json`. They currently do nothing.

This spec covers: (A) wiring those 17 real images into a real-world eval set, (B) generating
camera-quality-degraded variants (blur/skew/glare/low-res) to cover the brief's "imperfect photo"
scenario, (C) the ground-truth semantics needed for both, and (D) batch-workflow coverage for the
same image variety.

## Goals

- Exercise `local-ocr` (and optionally `cloud`) against real label photography and degraded
  capture conditions, with meaningful ground truth — not just "does it crash."
- Keep the existing `pnpm eval` (mock tier, CI-gating) completely unaffected — same file, same
  100%-required behavior, same speed.
- Reuse the existing single-image eval harness rather than building a parallel batch-accuracy tool.
- Extend batch e2e coverage to include the new image variety at the workflow level.

## Non-goals

- **Multi-image (front + back) merge support.** This was already scoped as stretch goal #5 in
  the MVP design spec and explicitly deferred there; it stays deferred here. Front and back images
  are wired in as **independent single-image entries** — this needs zero application-code changes,
  since the app has only ever supported one image per verification. The real-world eval data this
  spec adds is what should inform that work later, not a prerequisite for it.
- Image preprocessing (deskew/glare correction) — explicitly out of scope per the MVP design spec.
- A dedicated batch-accuracy harness — batch is a client-side fan-out over `/api/verify`
  (`hooks/use-batch.ts`), so per-image eval accuracy already covers it; see Non-goals rationale
  in "Batch coverage" below.

## A. Real-photo eval set

New file: `eval/expected-real-world.json`, same shape as `eval/expected.json` plus one optional
field (`tolerant`, see §C). Kept separate from `eval/expected.json` so:

- `pnpm eval`'s default mock-tier run (CI-gating, must stay 100%) never sees these entries.
- `mock` cannot run this set at all — `mockProvider.extract()` throws for any filename without a
  `MOCK_FIXTURES` entry, and adding real-photo fixtures there would be circular (hand-transcribing
  known ground truth into a fixture tests nothing about real OCR).

All 17 images from `eval/samples/` (documented in `SOURCES.md`) become independent entries — front
and back of the same COLA are two separate entries, each with the **full application data** (a
real applicant submits every field to TTB regardless of which panel shows it) and per-field
expected verdicts reflecting what's actually visible **in that specific image** (`SOURCES.md`
already documents this per label, e.g. Kendall-Jackson's ABV is back-only). A field genuinely
absent from the tested image is expected to resolve to REVIEW ("missing from label"), which is
existing, correct `lib/matching/verify.ts` behavior — not a new code path.

`healthWarningStatement` is not hand-encoded as a "violation" for the well-known ALL-CAPS-body
case (9 of 10 labels, already documented in the design spec's REVIEW-not-MISMATCH rationale) —
it's covered generically by `tolerant: true` (§C), since case/spacing-only deviation legitimately
resolving to REVIEW isn't specific to these entries.

## B. Camera-quality-degraded variants

New script: `eval/generate-degraded.ts`, using `sharp` (already a dependency, same tool
`generate-samples.ts` uses). Five base images, chosen to cover both synthetic-clean and
real-world-hard starting points:

| Base image                                   | Why                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `old-tom-clean.png`                          | synthetic clean baseline (spirits)                                                                    |
| `kirkbride-import-wine.png`                  | synthetic clean baseline (wine, has countryOfOrigin)                                                  |
| `wrong-abv.png`                              | synthetic **with a planted violation** — tests that degradation doesn't silently hide a real MISMATCH |
| `spirits-old-tub-bourbon-back.jpg`           | real photo, condensed font, moderate baseline difficulty                                              |
| `wine-la-crema-saralees-chardonnay-back.png` | real photo, already low-contrast gray-on-gray — stacks two difficulty dimensions                      |

Five degradations per base image (25 generated files, written to `eval/samples/degraded/`):

1. **blur** — Gaussian blur (`sharp().blur(3)`), simulates defocus.
2. **skew** — rotate ±12° with a white background fill, simulates off-angle photography.
3. **glare** — composite a semi-transparent white radial-gradient SVG over ~30% of the frame,
   simulates a reflection/glare spot.
4. **lowres** — downscale to ~25% then upscale back to original dimensions, simulates a
   distant/low-resolution phone photo.
5. **combo** — mild rotation (±6°) + light blur (sigma 1.5) + a glare patch + JPEG recompression
   at quality 40, output as `.jpg` regardless of source format — the closest single approximation
   of Jenny's "weird angle, bad lighting, glare" description.

Naming: `eval/samples/degraded/<base-stem>-<technique>.<ext>` (e.g.
`old-tom-clean-blur.png`, `spirits-old-tub-bourbon-back-combo.jpg`). Each generated file gets an
entry in `expected-real-world.json` alongside the 17 real photos.

## C. Ground-truth semantics

`ExpectedEntry` in `eval/run.ts` gains one optional field:

```ts
interface ExpectedEntry {
  file: string;
  application: unknown;
  expected: { overall: "PASS" | "FAIL"; violation: { field: string; verdictOneOf: Verdict[] } | null };
  tolerant?: boolean; // real photo or degraded capture: a present field may legitimately
  // resolve to REVIEW instead of MATCH without that being a scoring error
}
```

`expectedFieldVerdicts()` expands its accepted-verdict set for `tolerant: true` entries: every
present, non-violation field (including `healthWarningStatement`) accepts `["MATCH", "REVIEW"]`
instead of just `["MATCH"]`. This is the only code change needed to `run.ts`'s scoring logic.

For entries with a planted violation (only `wrong-abv.png`'s five degraded derivatives), the
violation field's `verdictOneOf` is authored directly in the JSON as `["MISMATCH", "REVIEW"]` —
no code change needed there, since `run.ts` already treats a violation as "caught" if the actual
verdict is anywhere in that array. The one outcome that must never count as caught is `MATCH` —
a degraded image silently reading a real violation as fine is the actual failure mode this whole
exercise exists to catch.

**Accepted imprecision:** `entry.expected.overall` stays a single fixed value per entry even
though a tolerant violation entry could legitimately land on either `PASS` (violation downgraded
to REVIEW) or `FAIL` (violation read as MISMATCH) depending on OCR luck — both are safe outcomes.
This slightly under-reports the printed "overall accuracy %" for those 5 entries. Not worth a
schema extension to fix: `eval/run.ts` only hard-fails (`process.exit(1)`) when
`provider.name === "mock"` (line 87), and `--set real-world` can only run under `local-ocr`/`cloud`
(see §D) — so this is an observability number, never a gate, for every entry this spec adds.

## D. `eval/run.ts` CLI changes

- New `--set <name>` flag: `default` (current behavior, `eval/expected.json`) or `real-world`
  (`eval/expected-real-world.json`). Defaults to `default` — `pnpm eval` with no flags is
  byte-identical to today.
- Guard: if `--set real-world` is passed with `--provider mock` (or no `--provider`, which
  defaults to mock), fail fast with a clear message ("the real-world set requires `--provider
local-ocr` or `--provider cloud` — mock can't read real pixels") instead of letting
  `mockProvider.extract()`'s per-file throw surface as an opaque per-entry crash.
- `package.json` gets a convenience script, e.g. `"eval:real-world": "tsx eval/run.ts --set
real-world --provider local-ocr"`.

## E. Batch coverage

Playwright e2e (`e2e/batch.spec.ts`) always runs against the `mock` tier by design (deterministic,
keyless, fast — see `playwright.config.ts`'s comment on why `next dev` + `VISION_PROVIDER=mock` is
used instead of hitting the production build). Under mock, any filename without a `MOCK_FIXTURES`
entry throws and becomes a per-row `ERROR` — which is itself the correct, existing "ask for a
better image" recovery behavior (workflow 3 in the design spec), just exercised at batch scale.

Extend `e2e/batch.spec.ts` with a run that mixes in a few real photos (e.g.
`spirits-old-tub-bourbon-front.jpg`, one degraded image) alongside the existing recognized
filenames, asserting the batch table still streams `PASS`/`FAIL`/`ERROR` rows correctly and
doesn't abort on the unrecognized ones — this is a workflow/UI robustness check (does a batch of
mixed real-world file sizes/dimensions/formats upload and stream correctly), not an accuracy
check.

**Why no separate batch-accuracy harness:** `hooks/use-batch.ts` fans out one `/api/verify` request
per row — the same endpoint `eval/run.ts` exercises directly. Per-image accuracy from
`eval --set real-world --provider local-ocr` already is batch accuracy; a second harness
re-implementing that fan-out would be duplicated surface area for no new signal.

## File/script inventory

New:

- `eval/expected-real-world.json`
- `eval/generate-degraded.ts`
- `eval/samples/degraded/*.{png,jpg}` (25 files, generated — not hand-authored)

Modified:

- `eval/run.ts` (`--set` flag, mock+real-world guard, `tolerant` in `expectedFieldVerdicts`)
- `package.json` (`eval:real-world` script)
- `e2e/batch.spec.ts` (mixed real-photo batch case)

Unchanged:

- `eval/expected.json`, `eval/generate-samples.ts`, `lib/vision/mock.ts`, `lib/matching/*`,
  `pnpm eval`'s default (mock) behavior and CI gate.

## Testing / verification

- `pnpm eval` (default, mock) must still be 13/13, 8/8 planted caught — unchanged file, unchanged
  gate.
- `pnpm eval:real-world` runs against `local-ocr` and reports (not gates) per-field and overall
  accuracy, plus violation-catch rate for the 5 `wrong-abv`-derived degraded entries.
- `eval/generate-degraded.ts` follows `generate-samples.ts`'s existing pattern of a blank-render
  sanity check (fail loudly if a generated file is degenerate, e.g. fully blank or zero-byte).
- New Playwright batch case run via `pnpm e2e`.

## Risks / open notes

- We have not independently re-transcribed each real label's exact warning-statement text against
  `HEALTH_WARNING_TEXT` byte-for-byte — `SOURCES.md` notes legibility and case, not a verified
  transcription. `tolerant: true` covers this (REVIEW is an acceptable outcome either way), so no
  entry asserts a hard MATCH on `healthWarningStatement` for a real photo.
- `local-ocr` (Tesseract) is markedly slower than mock; `eval:real-world` is not part of the fast
  inner dev loop and is not added to CI in this pass — it's a manually-run accuracy report.
- Multi-image (front+back) support remains unbuilt; this spec's ground truth (which fields are
  visible on which panel, per `SOURCES.md`) is exactly the input that future work will need.
