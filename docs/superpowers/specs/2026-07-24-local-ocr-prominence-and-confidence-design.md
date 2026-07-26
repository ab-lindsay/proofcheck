# local-ocr line-level prominence & confidence — design (2026-07-24)

## Motivation

`docs/deferred-items-and-tradeoffs-2026-07-23.md` records where the local-ocr accuracy effort
stands after Phase 1 + Phase 2 (`pnpm eval:real-world` at 17/46, 37%) and names two root causes
that field-selection heuristics on flat text alone cannot fix:

1. **Prominence is guessed, not measured.** `brandName` and `classType` selection both work over
   `data.text` — a flat, unordered string — and infer which candidate line is the real brand/class
   designation from word count, comma-presence, and reading order. Real labels signal this visually
   (the brand is the largest text on the label); that signal exists in Tesseract's output and is
   never used.
2. **Confidence is per-image, not per-selection ("confident-wrong beats honest-uncertain").**
   Every field's confidence today is `overallConfidence * fixedWeight` — one blanket number for the
   whole image, times a hardcoded per-field multiplier. A garbled line sitting in an otherwise-decent
   scan still inherits a confident-looking score and produces a wrong answer instead of an honest
   `REVIEW`, because nothing captures "the specific text I picked is garbage" as distinct from "OCR
   did fine on this image overall."

Both problems have the same fix available: Tesseract's `recognize()` call can return a
`blocks → paragraphs → lines → words` hierarchy where every `line` carries its own real `bbox`
(pixel rectangle) and `confidence` (0–100). Today `local-ocr.ts` doesn't even request this data —
`blocks` defaults to `false` in tesseract.js's output-format options — so `ocr-parser.ts` only ever
sees the flattened text and one page-level confidence number.

This spec threads that per-line data through the extraction pipeline and uses it for both problems,
plus surfaces the resulting (now-trustworthy) confidence number in the UI, which nothing does today.

## Non-goals

- No changes to the _selection logic_ (which line matches) for `alcoholContent`, `netContents`,
  `nameAndAddress`, or `countryOfOrigin` — only their confidence source changes, per Phase 1's
  original non-goal (the evidence never justified touching them).
- No image preprocessing (contrast normalization, deskew, orientation detection) — unchanged scope
  boundary from Phase 1/2.
- No changes to `lib/matching/*` verdict logic beyond the new `FieldResult.confidence` field —
  invariant 1 ("extraction proposes, matching disposes") holds; `withConfidence`'s MATCH→REVIEW
  downgrade behavior and threshold are unchanged, just no longer discarding the number afterward.
- No cross-tier confidence changes — this is local-ocr-only; the cloud tiers already self-report
  real per-field confidence from the model.

## Design

### 1. Requesting the data

`local-ocr.ts`'s `worker.recognize()` call must explicitly request block-level output — it doesn't
get generated otherwise:

```ts
const { data } = await worker.recognize(preparedImage, {}, { blocks: true });
```

### 2. Flattening into `OcrLine[]`

New type, in `ocr-parser.ts`:

```ts
export interface OcrLine {
  text: string;
  confidence: number; // 0..1, normalized from Tesseract's 0..100
  bbox: { x0: number; y0: number; x1: number; y1: number }; // pixel coords
}
```

`local-ocr.ts` flattens Tesseract's hierarchy and reads the _actual_ OCR'd image's dimensions (after
`prepareForOcr`'s possible downscale — bbox pixel coordinates are in that resized space, not the
original upload's):

```ts
const prepared = await prepareForOcr(image);
const { width, height } = await sharp(prepared).metadata();
const { data } = await worker.recognize(prepared, {}, { blocks: true });
const lines: OcrLine[] = (data.blocks ?? [])
  .flatMap((b) => b.paragraphs)
  .flatMap((p) => p.lines)
  .map((l) => ({
    text: l.text.trim(),
    confidence: Number.isFinite(l.confidence) ? Math.max(0, Math.min(1, l.confidence / 100)) : 0,
    bbox: l.bbox,
  }));
return parseOcrText(lines, data.text, width ?? 0, height ?? 0);
```

`parseOcrText`'s signature changes from `(text: string, overallConfidence: number)` to
`(lines: OcrLine[], fullText: string, imageWidth: number, imageHeight: number)`. The blanket
`overallConfidence` parameter is dropped entirely — every non-null field value now traces back to a
concrete `OcrLine` with its own real confidence, so the page-level number has nothing left to
weight. `fullText` (`data.text`) is kept, unchanged, solely for the health-warning statement's
existing cross-line regex capture (invariant 3 is deterministic text matching — that mechanism is
not touched).

`data.blocks` being `null`/empty (decode failure, blank image) flattens to `lines = []`; every
existing `lines.find(...)` already returns `undefined` → `null` on empty input, so this degrades to
today's "not found" `REVIEW` path, not a crash.

### 3. Prominence-based selection (`brandName`, `classType`)

Both fields keep their existing candidate filters (word count ≤6, no comma, no digit/symbol noise,
denylist, not the country/warning line for `brandName`; `CLASS_KEYWORDS` match, not the warning
line, for `classType`) — prominence only changes _which surviving candidate wins_, replacing
`classType`'s current shortest-line-wins and `brandName`'s current first-in-reading-order:

```ts
const lineHeight = (l: OcrLine) => l.bbox.y1 - l.bbox.y0;

const classLine =
  lines
    .filter((l) => CLASS_KEYWORDS.test(l.text) && !/GOVERNMENT/i.test(l.text))
    .sort((a, b) => lineHeight(b) - lineHeight(a))[0] ?? null;

const brandLine =
  preWarningLines
    .filter((l) => /* same shape checks as today, unchanged, operating on l.text */)
    .sort((a, b) => lineHeight(b) - lineHeight(a))[0] ?? null;
```

### 4. Real per-line confidence, all 7 fields

Every field's `confidence` becomes the real confidence of the `OcrLine`(s) that produced its value,
replacing the fixed per-field weight constants (`0.6`, `0.8`, `0.85`, `0.85`, `0.7`, `0.7`, `0.9`),
which are deleted:

```ts
field(value, matchedLine?.confidence ?? 0);
```

`field()`'s existing convention (`confidence: value === null ? 0 : conf`) is unchanged — a
not-found field is still confidence 0 regardless.

### 5. Multi-line fields: min confidence, union bbox

`healthWarningStatement` (always spans multiple OCR lines) and `nameAndAddress` (when the
verb-phrase-only next-line fallback fires) aggregate across every contributing `OcrLine`:

- **Confidence:** minimum across the contributing lines — consistent with the project's fail-closed
  bias (invariant 7); one bad line should drag the field's confidence down, not hide behind a good
  one.
- **bbox:** union rectangle (`min(x0, y0)` / `max(x1, y1)` across the set).

For the health warning specifically: value extraction is unchanged (still the existing regex over
the dehyphenated, whitespace-collapsed `fullText`). To find which lines contributed, walk `lines`
forward from the line containing `GOVERNMENT` (same concept as today's `warningStart`), accumulating
each line's collapsed text until the accumulated length reaches the already-matched
`warningMatch[0]` — so the existing trailing-URL/barcode bound still applies; this never walks past
what the regex already decided is the statement.

### 6. bbox → schema fractions

```ts
{
  x: clamp01(bbox.x0 / imageWidth),
  y: clamp01(bbox.y0 / imageHeight),
  width: clamp01((bbox.x1 - bbox.x0) / imageWidth),
  height: clamp01((bbox.y1 - bbox.y0) / imageHeight),
}
```

`clamp01 = (n) => Math.max(0, Math.min(1, n))`, applied to every component. This guards a malformed
Tesseract bbox (e.g. `x1 < x0`) degrading to a zero-size rectangle instead of throwing out of
`BoundingBoxSchema.parse` inside `ExtractedLabelSchema.parse` — a real new failure mode, since local-
ocr never populated `boundingBox` before this change and so never hit that validation path.

Populated for every field with a non-null value, single-line or unioned, matching the shape the
cloud tiers already produce.

### 7. Surfacing confidence in the UI

`FieldResult` (`lib/schema.ts`) gains one field:

```ts
export interface FieldResult {
  field: keyof ExtractedLabel;
  applicationValue: string | null;
  labelValue: string | null;
  verdict: Verdict;
  reason: string;
  confidence: number; // 0..1 — new
}
```

`lib/matching/verify.ts` already reads `extracted[field].confidence` in `withConfidence` (to decide
the MATCH→REVIEW downgrade) and discards it afterward; it now also attaches it to the `FieldResult`
it returns. No new signal — this only stops throwing one away.

**Tiering** reuses the existing `CONFIDENCE_REVIEW_THRESHOLD = 0.5` as the Low/Medium boundary, so
the displayed tier can never disagree with the actual REVIEW-downgrade decision a field already went
through: `verify.ts` downgrades on `confidence < CONFIDENCE_REVIEW_THRESHOLD` (strict), so tiering
uses the same boundary the same way — `Low` is `< 0.5`, `Medium` is `0.5 ≤ c < 0.8`, `High` is
`≥ 0.8`. A new `0.8` constant is the Medium/High boundary. Both live in `verify.ts` (exported) as
the single source of truth; a small `confidenceTier()` helper, colocated in `field-row.tsx` (same
pattern as the existing local `STYLE` map), buckets into `High | Medium | Low`.

**Display:** `FieldRow` gains one line under the existing `reason` paragraph, shown for every field
regardless of tier (including MATCH rows):

```
Confidence: High (94%)
```

Since `BatchTable`'s expanded row detail already renders `VerdictCard` → `FieldRow`, this one
component change covers both the single-label view and the batch results table.

## Testing

- `ocr-parser.test.ts`: every existing fixture moves from a flat multi-line string to an `OcrLine[]`
  array. Add a small `mkLines()` test helper defaulting confidence/bbox to uniform plausible values,
  so tests that only care about text-selection behavior (the majority) don't need to hand-write bbox
  numbers — only the new prominence tests need deliberately varied heights. New cases: prominence
  wins (taller candidate beats an earlier/shorter one for both `brandName` and `classType`), per-line
  confidence (a field's confidence reflects its own line, not a high blanket page confidence — the
  direct regression test for the "confident-wrong" bug), multi-line min-confidence/union-bbox
  aggregation, bbox fraction conversion and clamping on malformed input.
- `local-ocr.test.ts`: existing mocks (`{ data: { text, confidence } }`, no `blocks`) need `blocks`
  added, matching their asserted text, to keep passing under lines-based selection; also assert
  `recognize()` is called with `{ blocks: true }`.
- `lib/matching/verify.test.ts`: `FieldResult.confidence` is populated and matches the underlying
  `ExtractedField.confidence`.
- `field-row.test.tsx`: tier + percentage renders correctly at each threshold boundary (just under
  0.5, 0.5–0.8, ≥0.8).
- Validation: `pnpm eval` (mock tier must stay 100% — untouched, mock never reaches `ocr-parser.ts`)
  and `pnpm eval:real-world --provider local-ocr`, reporting the delta against the 17/46 baseline.
  No specific target promised — the status doc's own evidence shows per-field gains don't move the
  overall pass rate linearly (correlated failures across the 46-image set).

## Known limitations (carried forward, not solved here)

- Severely degraded images that OCR into pure noise (no real text recognized at all) aren't fixed by
  any of this — there's no line to be prominent or confident about if Tesseract never recognized the
  text in the first place.
- The 3 La Crema back-label images (class type never printed as text on that panel) remain
  unrecoverable by any text-based heuristic, prominence-weighted or not.
