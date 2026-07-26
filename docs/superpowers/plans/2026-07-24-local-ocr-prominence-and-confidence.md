# local-ocr line-level prominence & confidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace guessed brand/class prominence (word-count/reading-order heuristics on flat OCR
text) and blanket per-image confidence with real per-line signals from Tesseract's bounding-box and
per-line confidence data, and surface the resulting confidence in the UI.

**Architecture:** `local-ocr.ts` requests Tesseract's block-level output (`{ blocks: true }`, not
requested today), flattens `blocks → paragraphs → lines` into a simple `OcrLine[]` (text + real
confidence + bbox), and passes that plus the image's actual OCR'd dimensions into `ocr-parser.ts`.
`ocr-parser.ts`'s existing regex-based field selection keeps working over `.text`; brandName/
classType additionally use line height as a tiebreaker; every field's confidence and bounding box
now derive from the real line(s) that produced its value instead of a blanket per-image number.
`FieldResult` gains a `confidence` field threaded through to `FieldRow` for display.

**Tech Stack:** TypeScript, tesseract.js 7, Zod, Vitest, React (Next.js App Router), Tailwind.

## Global Constraints

- Invariant 2 (`CLAUDE.md`): every extraction tier returns a Zod-validated `ExtractedLabel` — no
  code path may throw out of `ExtractedLabelSchema.parse`.
- Invariant 3: the health warning statement's byte-exact / wording-exact matching in
  `lib/matching/warning.ts` is untouched — this plan only changes how confidence/bbox are attached to
  the extracted value, never the value-matching logic.
- Invariant 7: fail closed, per item — a malformed bbox or non-finite confidence must degrade to a
  safe default (0 confidence, zero-size bbox), never throw and never silently produce a confident
  wrong answer.
- `pnpm eval` (mock tier) must stay at 100% after every task — mock never reaches `ocr-parser.ts`,
  so any regression there is a signal something leaked outside local-ocr scope.
- No changes to `lib/matching/*` verdict logic beyond adding `FieldResult.confidence` — extraction
  proposes, matching disposes (invariant 1).

---

### Task 1: Structured line data — `OcrLine`, real per-line confidence, bbox output

**Files:**

- Modify: `lib/vision/ocr-parser.ts` (full rewrite of the module body; field-selection _order_ for
  brandName/classType is unchanged in this task — only the data plumbing and confidence/bbox source
  change. Prominence-based reordering is Task 2.)
- Modify: `lib/vision/local-ocr.ts`
- Modify: `lib/vision/ocr-parser.test.ts`
- Modify: `lib/vision/local-ocr.test.ts`

**Interfaces:**

- Produces: `export interface OcrLine { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }` (in `ocr-parser.ts`)
- Produces: `export function parseOcrText(lines: OcrLine[], fullText: string, imageWidth: number, imageHeight: number): ExtractedLabel` — signature change from today's `(text: string, overallConfidence: number)`. The `overallConfidence` parameter is removed entirely (every non-null field value now traces to a concrete `OcrLine` with its own real confidence).
- Consumes (Task 2): the same `OcrLine[]`/`parseOcrText` surface — Task 2 only changes the sort inside `classLine`/`brandLine` selection, not the type signature.

- [ ] **Step 1: Rewrite `lib/vision/ocr-parser.ts`**

Replace the entire file with:

```ts
import type { BoundingBox, ExtractedField, ExtractedLabel } from "@/lib/schema";
import { ExtractedLabelSchema } from "@/lib/schema";
import { collapseWhitespace, parseNetContents } from "@/lib/ttb/normalize";

export interface OcrLine {
  text: string;
  confidence: number; // 0..1, already clamped/finite by the caller (local-ocr.ts)
  bbox: { x0: number; y0: number; x1: number; y1: number }; // pixel coords, as Tesseract returns them
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function toBoundingBox(bbox: OcrLine["bbox"], imageWidth: number, imageHeight: number): BoundingBox {
  // A zero/negative image dimension (shouldn't happen — local-ocr.ts always reads real decoded
  // dimensions — but this is the boundary between untrusted OCR output and the validated schema)
  // degrades to a zero-size box instead of dividing by zero into NaN, which would fail Zod's parse.
  if (imageWidth <= 0 || imageHeight <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: clamp01(bbox.x0 / imageWidth),
    y: clamp01(bbox.y0 / imageHeight),
    width: clamp01((bbox.x1 - bbox.x0) / imageWidth),
    height: clamp01((bbox.y1 - bbox.y0) / imageHeight),
  };
}

function unionBbox(boxes: OcrLine["bbox"][]): OcrLine["bbox"] {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

// Word-boundary anchored so a class keyword must be a whole word — otherwise "gin" matches
// "VIRGINIA", "ale" matches "DALE", "rum" matches "DRUM", stealing the brand line into classType.
const CLASS_KEYWORDS =
  /\b(?:whisk(?:e)?y|bourbon|rye|vodka|gin|rum|tequila|brandy|wine|ale|lager|beer|stout|porter|liqueur|vin|vino|vinho|rouge|tinto|rosso|blanc|blanco|bianco|branco|chardonnay|cabernet|merlot|pinot|sauvignon|zinfandel|syrah|shiraz|malbec|riesling|grenache|tempranillo|sangiovese|moscato|muscat|ros[eé]|champagne|prosecco|m[aä]rzen|ipa|pilsner|amber|wheat|saison)\b/i;

// Shared by the country-line test, its capture, and the brandLine exclusion below — a single
// source of truth so a new marker (or language) only needs to be added in one place.
const COUNTRY_MARKERS =
  "(?:PRODUCT\\s+OF|PRODUCE\\s+OF|IMPORTED\\s+FROM|PRODUIT\\s+DE|PRODUCTO\\s+DE|PRODOTTO\\s+IN|PRODUZIDO\\s+EM)";

// Real TTB class/type declarations are short standalone designations ("BOURBON WHISKEY", "DRAUGHT
// STOUT"); marketing prose that incidentally contains a class keyword runs much longer. Prefer the
// shortest matching line over the first — OCR reading order is not a reliable signal here.
const wordCount = (line: string) => line.trim().split(/\s+/).filter(Boolean).length;

// Standardized whiskey designations (only "bottled in bond" is an actual federal designation, per
// the Bottled-in-Bond Act; the rest are industry-standard but not legally defined) that commonly
// survive OCR when the real (often large, stylized) brand title gets dropped entirely — observed on
// real bottles where OCR skipped the brand and left one of these behind as the only short,
// comma-free "leftover" candidate line.
const BRAND_DENYLIST = /\b(?:bottled in bond|sour mash|single barrel|small batch|cask strength)\b/i;

// None of our real or synthetic brand names contain a digit or these symbols — TTB brand text is
// letters, spaces, apostrophes, hyphens, periods, and occasionally "&". OCR garble on a heavily
// degraded image, by contrast, routinely produces stray digits and punctuation ("100 PROOF 100
// PROOF", "OL |", "y Mark:", "* 00d. I's the") that would otherwise sail through the word-count/
// comma checks below and be reported as a confident wrong brand instead of an honest "not found."
const BRAND_NOISE = /[0-9|=[\]!:;()*<>]/;

// A bare "%" line is ambiguous (marketing copy like "100% FRENCH OAK" also contains one) — real ABV
// declarations are always printed alongside "ALC"/"VOL"/"ABV". A bare "proof" line has no analogous
// false-positive pattern in the eval data, so it still qualifies on its own.
const ABV_CONTEXT = /\b(?:alc|vol|abv)\b/i;

const PRODUCER_VERB =
  "(?:distilled|bottled|produced|brewed|imported|made)\\s+by|mis\\s+en\\s+bouteille\\s+par|embotellado\\s+por|imbottigliato\\s+da|engarrafado\\s+por";

export function parseOcrText(
  lines: OcrLine[],
  fullText: string,
  imageWidth: number,
  imageHeight: number,
): ExtractedLabel {
  // Real labels hyphenate words across line breaks ("MACHIN-ERY", "AC-CORDING") — rejoin them before
  // parsing or the warning can never match word-for-word. The canonical § 16.21 text has no hyphens.
  const dehyphenated = fullText.replace(/([A-Za-z])-[ \t]*\r?\n\s*([A-Za-z])/g, "$1$2");
  const joined = collapseWhitespace(dehyphenated);

  // Every field's confidence/bbox comes from the real OcrLine(s) that produced its value — a single
  // line for most fields, several for multi-line fields (min confidence, union bbox: consistent with
  // the project's fail-closed bias — one bad contributing line should drag the field down, not hide
  // behind a good one).
  const field = (value: string | null, source: OcrLine | OcrLine[] | null): ExtractedField => {
    if (value === null || source === null) return { value, present: false, confidence: 0, boundingBox: null };
    const sources = Array.isArray(source) ? source : [source];
    return {
      value,
      present: true,
      confidence: clamp01(Math.min(...sources.map((s) => s.confidence))),
      boundingBox: toBoundingBox(unionBbox(sources.map((s) => s.bbox)), imageWidth, imageHeight),
    };
  };

  // Bound the warning to the end of its final sentence so importer/UPC/website text printed AFTER the
  // statement is not appended (which would make the exact checkHealthWarning comparison misfire).
  // Bound to the closing "health problems." — tolerate stray spacing before the period so an OCR
  // artifact ("health problems .") doesn't defeat the bound and append trailing importer/UPC/website
  // text (which would flip a spacing-only REVIEW into a MISMATCH).
  // If the closing "health problems." isn't found cleanly (common on real photos — OCR garbles the
  // final period), stop the fallback capture at the first trailing URL or barcode/UPC digit run
  // instead of running to end-of-string. Canonical § 16.21 warning text contains neither, so this
  // can never clip real warning content — it only trims OCR noise appended after the statement.
  const warningMatch =
    joined.match(/GOVERNMENT\s+WARNING:.*?health\s+problems\s*\./i) ??
    joined.match(/GOVERNMENT\s+WARNING:.*?(?=\s+(?:www\.|https?:\/\/|\d{4,})|$)/i);

  const classLine =
    lines
      .filter((l) => CLASS_KEYWORDS.test(l.text) && !/GOVERNMENT/i.test(l.text))
      .sort((a, b) => wordCount(a.text) - wordCount(b.text))[0] ?? null;

  const alcoholLine =
    lines.find(
      (l) => !/GOVERNMENT/i.test(l.text) && ((/%/.test(l.text) && ABV_CONTEXT.test(l.text)) || /proof/i.test(l.text)),
    ) ?? null;

  // Reuse the parser as the selector so the two never diverge — parseNetContents accepts "12 FL. OZ.",
  // "1.5 LITERS", commas and leading decimals, and returns null for a street address. Exclude % lines
  // so an ABV like "45% Alc./Vol." is never read as a volume.
  const netLine = lines.find((l) => !/%/.test(l.text) && parseNetContents(l.text) !== null) ?? null;

  // The bottler's own name/address (what an applicant would type into the "name and address" form
  // field) never includes the leading verb phrase itself — only the "Co.," style line does that
  // natively. Capture past the verb phrase so nameAndAddress compares like-for-like against the
  // application value instead of always penalizing it for a prefix the applicant would never type.
  const producerLine =
    lines.find((l) => new RegExp(PRODUCER_VERB, "i").test(l.text) || /\bco\.,/i.test(l.text)) ?? null;
  const producerMatch = producerLine ? producerLine.text.match(new RegExp(`(?:${PRODUCER_VERB})\\s+(.+)$`, "i")) : null;
  // Real photos often OCR the producer verb phrase ("Distilled and Bottled by") and the company
  // name/address onto separate lines. When the verb phrase is the whole line (producerMatch finds
  // nothing after it) and it matched via the verb-phrase branch (not the "Co.," branch, where the
  // whole line already IS the name), fall back to the next OCR line as the value instead of
  // returning the bare verb phrase.
  const producerIsVerbPhraseOnly =
    producerLine !== null && producerMatch === null && new RegExp(PRODUCER_VERB, "i").test(producerLine.text);
  const producerLineIndex = producerLine ? lines.indexOf(producerLine) : -1;
  const producerNextLine = producerIsVerbPhraseOnly ? lines[producerLineIndex + 1] : undefined;
  const nameAndAddressValue = producerMatch
    ? producerMatch[1].trim()
    : (producerNextLine?.text ?? producerLine?.text ?? null);
  const nameAndAddressSource: OcrLine | OcrLine[] | null =
    producerNextLine && producerLine ? [producerLine, producerNextLine] : producerLine;

  // "PRODUCT OF FRANCE", "PRODUCE OF ITALY", "IMPORTED FROM SCOTLAND" — capture the country only, and
  // match on the country's OWN line: the collapsed `joined` string loses line boundaries, letting a
  // following field ("Alc. 13% by Vol.") bleed into the capture.
  const countryLine = lines.find((l) => new RegExp(COUNTRY_MARKERS, "i").test(l.text)) ?? null;
  const countryMatch = countryLine
    ? countryLine.text.match(new RegExp(`${COUNTRY_MARKERS}\\s+([A-Za-zÀ-ÿ ]+?)(?=$|[.]|\\s+\\d)`, "i"))
    : null;

  // The brand sits above the warning. Only consider lines before the warning block so that when the
  // brand line is absent (OCR often drops a large bold title), brandLine falls to null — a "not found"
  // REVIEW — instead of grabbing a warning-body line like "women should not drink...". Anchor on the
  // first GOVERNMENT line (not "GOVERNMENT WARNING") so a header split across two OCR lines still bounds.
  const warningStart = lines.findIndex((l) => /GOVERNMENT/i.test(l.text));
  let preWarningLines = warningStart >= 0 ? lines.slice(0, warningStart) : lines;
  // Real labels put the brand first — it's the largest, most prominent text, typically the very
  // first line. Everything after the first structured field (alcohol content, net contents, or the
  // producer line) is increasingly likely to be marketing copy, not a missed brand. classLine is
  // excluded from this cutoff because some labels print the class/type designation as a header
  // above the brand.
  const structuredFieldIndices = [alcoholLine, netLine, producerLine]
    .filter((l): l is OcrLine => l !== null)
    .map((l) => lines.indexOf(l));
  const firstStructuredFieldIndex = structuredFieldIndices.length > 0 ? Math.min(...structuredFieldIndices) : -1;
  if (firstStructuredFieldIndex >= 0) {
    preWarningLines = preWarningLines.slice(0, firstStructuredFieldIndex);
  }
  // Beyond the exclusions above, a leftover line must also look brand-shaped: real brand/fanciful
  // names are short (<=6 words) and comma-free, so a longer or comma-bearing line is almost always
  // marketing copy, not a brand — reject it rather than guess. BRAND_DENYLIST catches the remaining
  // case where a standardized designation (not marketing copy) is left over because the real brand
  // was dropped by OCR entirely.
  const brandLine =
    preWarningLines.find(
      (l) =>
        l !== classLine &&
        l !== alcoholLine &&
        l !== netLine &&
        l !== producerLine &&
        l.text.length >= 3 &&
        wordCount(l.text) <= 6 &&
        !l.text.includes(",") &&
        !BRAND_NOISE.test(l.text) &&
        !BRAND_DENYLIST.test(l.text) &&
        !/GOVERNMENT/i.test(l.text) &&
        !new RegExp(COUNTRY_MARKERS, "i").test(l.text),
    ) ?? null;

  // Which OcrLines contributed to the matched warning span, for confidence/bbox — walk forward from
  // the GOVERNMENT line, accumulating collapsed text until it covers the matched length, so this
  // never walks past what the regex above already decided is the statement (the trailing-URL/
  // barcode bound still applies to the VALUE; this only decides which lines back the confidence).
  let warningSources: OcrLine[] = [];
  if (warningMatch && warningStart >= 0) {
    const targetLength = collapseWhitespace(warningMatch[0]).length;
    let accumulated = "";
    for (let i = warningStart; i < lines.length && accumulated.length < targetLength; i++) {
      warningSources.push(lines[i]);
      accumulated = collapseWhitespace(`${accumulated} ${lines[i].text}`);
    }
  }

  // Validate before returning: invariant 2 — every extraction tier returns a Zod-validated ExtractedLabel.
  return ExtractedLabelSchema.parse({
    brandName: field(brandLine?.text ?? null, brandLine),
    classType: field(classLine?.text ?? null, classLine),
    alcoholContent: field(alcoholLine?.text ?? null, alcoholLine),
    netContents: field(netLine?.text ?? null, netLine),
    nameAndAddress: field(nameAndAddressValue, nameAndAddressSource),
    countryOfOrigin: field(countryMatch ? countryMatch[1].trim() : null, countryLine),
    healthWarningStatement: field(
      warningMatch ? warningMatch[0] : null,
      warningSources.length > 0 ? warningSources : null,
    ),
  });
}
```

- [ ] **Step 2: Rewrite `lib/vision/local-ocr.ts`**

Replace the entire file with:

```ts
import sharp from "sharp";
import { createWorker, PSM, type Worker, type Block } from "tesseract.js";
import type { VisionProvider } from "@/lib/vision/types";
import { parseOcrText, type OcrLine } from "@/lib/vision/ocr-parser";

let workerPromise: Promise<Worker> | null = null;

// Cap the longest side before OCR so the single shared tesseract worker can't be pegged by a large
// (but within the route's pixel budget) upload. 2000 px keeps label text legible for recognition.
const MAX_OCR_DIMENSION = 2000;

async function prepareForOcr(image: Buffer): Promise<Buffer> {
  try {
    const { width = 0, height = 0 } = await sharp(image).metadata();
    if (Math.max(width, height) <= MAX_OCR_DIMENSION) return image;
    return await sharp(image)
      .resize(MAX_OCR_DIMENSION, MAX_OCR_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .toBuffer();
  } catch {
    // Best effort: a decode/resize failure must not disable the keyless default tier. Hand the
    // original bytes to tesseract, which will surface any genuine decode error itself.
    return image;
  }
}

async function getWorker(): Promise<Worker> {
  // Never cache a REJECTED promise: `??=` would keep a failed init forever, permanently disabling the
  // keyless default tier after one transient blip (traineddata fetch, /tmp not writable). Reset on
  // failure so the next request re-creates the worker and the tier self-heals.
  if (!workerPromise) {
    workerPromise = createWorker("eng+fra+spa+ita+por", 1, { cachePath: "/tmp" })
      .then(async (worker) => {
        // Labels are a single column of wildly varying font sizes (a large bold brand title, then
        // progressively smaller class/type, content, and fine-print lines). Left at its default,
        // tesseract.js's automatic page segmentation can drop an isolated large heading entirely —
        // confirmed: the same brand line OCRs correctly in isolation (95% confidence) but disappears
        // from the full-page result with no PSM set. SINGLE_COLUMN names this layout exactly and,
        // unlike the OSD-based modes, needs no extra osd.traineddata fetch.
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_COLUMN });
        return worker;
      })
      .catch((e) => {
        workerPromise = null;
        throw e;
      });
  }
  return workerPromise;
}

// Tesseract's block-level output (`blocks: true`, not requested by default) is the only way to get
// per-line bbox/confidence — flatten its blocks -> paragraphs -> lines into a simple array so
// ocr-parser.ts's field selection can work over one uniform shape.
function flattenLines(blocks: Block[] | null): OcrLine[] {
  return (blocks ?? [])
    .flatMap((b) => b.paragraphs)
    .flatMap((p) => p.lines)
    .map((l) => ({
      text: l.text.trim(),
      confidence: Number.isFinite(l.confidence) ? Math.max(0, Math.min(1, l.confidence / 100)) : 0,
      bbox: l.bbox,
    }));
}

export const localOcrProvider: VisionProvider = {
  name: "local-ocr",
  async extract(image) {
    const worker = await getWorker();
    const prepared = await prepareForOcr(image);
    // bbox pixel coordinates from tesseract are in the prepared (possibly downscaled) image's space,
    // not the original upload's — read dimensions off the buffer actually handed to recognize().
    const { width = 0, height = 0 } = await sharp(prepared).metadata();
    const { data } = await worker.recognize(prepared, {}, { blocks: true });
    return parseOcrText(flattenLines(data.blocks), data.text, width, height);
  },
};
```

- [ ] **Step 3: Update `lib/vision/ocr-parser.test.ts` — add the `OcrLine` migration shim**

At the top of the file, replace:

```ts
import { describe, expect, it } from "vitest";
import { parseOcrText } from "@/lib/vision/ocr-parser";
import { ExtractedLabelSchema } from "@/lib/schema";
```

with:

```ts
import { describe, expect, it } from "vitest";
import { parseOcrText as parseOcrTextLines, type OcrLine } from "@/lib/vision/ocr-parser";
import { ExtractedLabelSchema } from "@/lib/schema";

// Test fixture builder: turns a list of line strings into OcrLine[] with a uniform default
// confidence/height. Most existing tests only care about which line's TEXT gets selected, not its
// bbox/confidence, so a uniform default keeps those tests unchanged. Tests that need to control a
// specific line's prominence (height) or confidence pass `opts` explicitly.
function mkLines(strings: string[], opts?: { heights?: number[]; confidences?: number[] }): OcrLine[] {
  return strings.map((text, i) => ({
    text,
    confidence: opts?.confidences?.[i] ?? 0.9,
    bbox: { x0: 0, y0: i * 20, x1: 500, y1: i * 20 + (opts?.heights?.[i] ?? 20) },
  }));
}

// Back-compat shim: every existing test below was written against the old (text: string, confidence:
// number) signature. This keeps those call sites unchanged; new tests that need to control a specific
// line's height/confidence call parseOcrTextLines directly with a hand-built OcrLine[].
function parseOcrText(text: string, _unusedOverallConfidence = 0.9): ReturnType<typeof parseOcrTextLines> {
  const strings = text.split("\n").filter((l) => l.trim() !== "");
  return parseOcrTextLines(mkLines(strings), text, 1000, 1000);
}
```

Leave every existing `describe`/`it` block below this unchanged, **except** the one test that no
longer has an equivalent (the shim above ignores `_unusedOverallConfidence` entirely, so a test
about _that specific parameter_ being NaN no longer tests anything real). Replace:

```ts
it("clamps a non-finite confidence and returns a schema-valid label (invariant 2)", () => {
  const r = parseOcrText(OCR_TEXT, Number.NaN);
  for (const f of Object.values(r)) expect(Number.isFinite(f.confidence)).toBe(true);
  expect(() => ExtractedLabelSchema.parse(r)).not.toThrow();
});
```

with:

```ts
it("clamps a malformed bbox and returns a schema-valid label (invariant 2)", () => {
  const lines = mkLines(OCR_TEXT.split("\n"));
  // Simulate a degenerate Tesseract bbox (x1 < x0) on the brand line — must clamp to a zero-size
  // box, not throw out of BoundingBoxSchema.parse.
  lines[0] = { ...lines[0], bbox: { x0: 500, y0: 0, x1: 100, y1: 20 } };
  const r = parseOcrTextLines(lines, OCR_TEXT, 1000, 1000);
  for (const f of Object.values(r)) expect(Number.isFinite(f.confidence)).toBe(true);
  expect(() => ExtractedLabelSchema.parse(r)).not.toThrow();
  expect(r.brandName.boundingBox?.width).toBe(0);
});
```

Then add these new tests at the end of the `describe("parseOcrText", ...)` block, right before the
final closing `});`:

```ts
it("a field's confidence reflects its own line, not a high confidence elsewhere on the page", () => {
  // Regression test for "confident-wrong beats honest-uncertain": a garbled brand line sitting in
  // an otherwise-decent scan must not inherit the other lines' high confidence.
  const lines = mkLines(["GARBLED BRAND", "Kentucky Straight Bourbon Whiskey", "45% Alc./Vol.", "750 mL"], {
    confidences: [0.2, 0.95, 0.95, 0.95],
  });
  const r = parseOcrTextLines(lines, lines.map((l) => l.text).join("\n"), 1000, 1000);
  expect(r.brandName.value).toBe("GARBLED BRAND");
  expect(r.brandName.confidence).toBe(0.2);
  expect(r.classType.confidence).toBe(0.95);
});

it("multi-line nameAndAddress confidence is the minimum across its contributing lines", () => {
  const lines = mkLines(
    [
      "OLD TUB",
      "BOURBON WHISKEY",
      "50% ALC./VOL.",
      "Distilled and Bottled by",
      "James B. Beam Distilling Co., Clermont, KY",
      "750 mL",
    ],
    { confidences: [0.9, 0.9, 0.9, 0.9, 0.4, 0.9] },
  );
  const r = parseOcrTextLines(lines, lines.map((l) => l.text).join("\n"), 1000, 1000);
  expect(r.nameAndAddress.value).toBe("James B. Beam Distilling Co., Clermont, KY");
  expect(r.nameAndAddress.confidence).toBe(0.4);
});

it("populates boundingBox as the image-fraction rectangle of the selected line", () => {
  const lines: OcrLine[] = [
    { text: "OLD TOM DISTILLERY", confidence: 0.9, bbox: { x0: 100, y0: 50, x1: 900, y1: 150 } },
    { text: "750 mL", confidence: 0.9, bbox: { x0: 100, y0: 400, x1: 300, y1: 440 } },
  ];
  const r = parseOcrTextLines(lines, lines.map((l) => l.text).join("\n"), 1000, 500);
  expect(r.brandName.boundingBox).toEqual({ x: 0.1, y: 0.1, width: 0.8, height: 0.2 });
});

it("healthWarningStatement confidence is the minimum across the lines it actually spans, not the whole page", () => {
  const text = [
    "OLD TOM DISTILLERY",
    "Kentucky Straight Bourbon Whiskey",
    "45% Alc./Vol.",
    "750 mL",
    "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not",
    "drink alcoholic beverages during pregnancy because of the risk of birth defects.",
    "(2) Consumption of alcoholic beverages impairs your ability to drive a car or",
    "operate machinery, and may cause health problems.",
    "IMPORTED BY ACME IMPORTS, NEW YORK, NY",
  ];
  const lines = mkLines(text, { confidences: [0.9, 0.9, 0.9, 0.9, 0.9, 0.3, 0.9, 0.9, 0.9] });
  const r = parseOcrTextLines(lines, text.join("\n"), 1000, 1000);
  expect(r.healthWarningStatement.value).toMatch(/health problems\.$/);
  // The trailing importer line (index 8, confidence irrelevant) must not be included — only the 4
  // warning lines (indices 4-7) contribute, so the minimum among THEM (0.3) is the field's confidence.
  expect(r.healthWarningStatement.confidence).toBe(0.3);
});
```

- [ ] **Step 4: Update `lib/vision/local-ocr.test.ts` — add `blocks` to existing mocks, assert the new recognize() call, move the NaN-confidence test here**

Replace the full file with:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const mockCreateWorker = vi.fn();
const mockRecognize = vi.fn();
vi.mock("tesseract.js", () => ({
  createWorker: (...args: unknown[]) => mockCreateWorker(...args),
  PSM: { SINGLE_COLUMN: "4" },
}));

import { localOcrProvider } from "@/lib/vision/local-ocr";

const meta = { filename: "x.png", mimeType: "image/png" };

// Matches the real tesseract.js blocks -> paragraphs -> lines shape, minimally.
function blocksFor(lines: { text: string; confidence: number }[]) {
  return [
    {
      paragraphs: [
        {
          lines: lines.map((l) => ({
            text: l.text,
            confidence: l.confidence,
            bbox: { x0: 0, y0: 0, x1: 100, y1: 20 },
          })),
        },
      ],
    },
  ];
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("localOcrProvider worker singleton", () => {
  it("does not cache a rejected worker init — a later call retries and succeeds", async () => {
    mockCreateWorker
      .mockRejectedValueOnce(new Error("eng.traineddata download failed"))
      .mockResolvedValueOnce({ recognize: mockRecognize, setParameters: vi.fn().mockResolvedValue(undefined) });
    mockRecognize.mockResolvedValue({
      data: {
        text: "OLD TOM DISTILLERY\n750 mL",
        confidence: 90,
        blocks: blocksFor([
          { text: "OLD TOM DISTILLERY", confidence: 90 },
          { text: "750 mL", confidence: 90 },
        ]),
      },
    });

    // First call: worker init rejects -> must throw, and must NOT poison the singleton.
    await expect(localOcrProvider.extract(Buffer.alloc(0), meta)).rejects.toThrow(/traineddata/);
    // Second call: the tier self-heals by re-creating the worker.
    const result = await localOcrProvider.extract(Buffer.alloc(0), meta);
    expect(result.netContents.value).toBe("750 mL");
    expect(mockCreateWorker).toHaveBeenCalledTimes(2);
  });

  it("creates the worker with the combined Romance-language pack", async () => {
    // The worker is a module-level singleton (see local-ocr.ts) — the existing test above already
    // resolves it, so a fresh module instance is needed to observe a real createWorker() call here.
    vi.resetModules();
    mockCreateWorker.mockResolvedValueOnce({
      recognize: mockRecognize,
      setParameters: vi.fn().mockResolvedValue(undefined),
    });
    mockRecognize.mockResolvedValue({
      data: {
        text: "OLD TOM DISTILLERY",
        confidence: 90,
        blocks: blocksFor([{ text: "OLD TOM DISTILLERY", confidence: 90 }]),
      },
    });
    const { localOcrProvider: freshProvider } = await import("@/lib/vision/local-ocr");
    await freshProvider.extract(Buffer.alloc(0), meta);
    expect(mockCreateWorker).toHaveBeenCalledWith("eng+fra+spa+ita+por", 1, { cachePath: "/tmp" });
  });

  it("requests block-level output so per-line bbox/confidence is available", async () => {
    vi.resetModules();
    mockCreateWorker.mockResolvedValueOnce({
      recognize: mockRecognize,
      setParameters: vi.fn().mockResolvedValue(undefined),
    });
    mockRecognize.mockResolvedValue({
      data: {
        text: "OLD TOM DISTILLERY",
        confidence: 90,
        blocks: blocksFor([{ text: "OLD TOM DISTILLERY", confidence: 90 }]),
      },
    });
    const { localOcrProvider: freshProvider } = await import("@/lib/vision/local-ocr");
    await freshProvider.extract(Buffer.alloc(0), meta);
    expect(mockRecognize).toHaveBeenCalledWith(expect.anything(), {}, { blocks: true });
  });

  it("clamps a non-finite per-line confidence instead of letting it poison the extracted field", async () => {
    vi.resetModules();
    mockCreateWorker.mockResolvedValueOnce({
      recognize: mockRecognize,
      setParameters: vi.fn().mockResolvedValue(undefined),
    });
    mockRecognize.mockResolvedValue({
      data: {
        text: "OLD TOM DISTILLERY",
        confidence: 90,
        blocks: blocksFor([{ text: "OLD TOM DISTILLERY", confidence: Number.NaN }]),
      },
    });
    const { localOcrProvider: freshProvider } = await import("@/lib/vision/local-ocr");
    const result = await freshProvider.extract(Buffer.alloc(0), meta);
    expect(Number.isFinite(result.brandName.confidence)).toBe(true);
    expect(result.brandName.confidence).toBe(0);
  });

  it("gracefully returns not-found fields (not a crash) when blocks is null", async () => {
    vi.resetModules();
    mockCreateWorker.mockResolvedValueOnce({
      recognize: mockRecognize,
      setParameters: vi.fn().mockResolvedValue(undefined),
    });
    mockRecognize.mockResolvedValue({ data: { text: "", confidence: 0, blocks: null } });
    const { localOcrProvider: freshProvider } = await import("@/lib/vision/local-ocr");
    const result = await freshProvider.extract(Buffer.alloc(0), meta);
    expect(result.brandName.present).toBe(false);
    expect(result.brandName.confidence).toBe(0);
  });
});
```

- [ ] **Step 5: Run the full vision test suite**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts lib/vision/local-ocr.test.ts lib/vision/local-ocr-downscale.test.ts`
Expected: all pass. `local-ocr-downscale.test.ts` needs no changes — its mocks don't assert on
recognize()'s new arguments and its assertions are only about the resized image buffer.

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `pnpm vitest run && pnpm exec tsc --noEmit`
Expected: all pass, no type errors. (`lib/vision/select.ts`/`select.test.ts` and the cloud providers
are untouched by this task and should be unaffected.)

- [ ] **Step 7: Commit**

```bash
git add lib/vision/ocr-parser.ts lib/vision/local-ocr.ts lib/vision/ocr-parser.test.ts lib/vision/local-ocr.test.ts
git commit -m "Thread Tesseract's per-line bbox/confidence through local-ocr extraction

Requests block-level output (not enabled by default), flattens it into
a simple OcrLine[], and uses each field's own matched line for real
confidence and bounding box instead of one blanket per-image number.
Brand/class selection order is unchanged in this commit."
```

---

### Task 2: Prominence-based selection for `brandName` and `classType`

**Files:**

- Modify: `lib/vision/ocr-parser.ts:` the `classLine`/`brandLine` sort criteria only
- Modify: `lib/vision/ocr-parser.test.ts`

**Interfaces:**

- Consumes: `OcrLine`, `parseOcrText` from Task 1 — no signature change, only the internal sort key.

- [ ] **Step 1: Change `classLine`'s sort to tallest-wins**

In `lib/vision/ocr-parser.ts`, replace:

```ts
const classLine =
  lines
    .filter((l) => CLASS_KEYWORDS.test(l.text) && !/GOVERNMENT/i.test(l.text))
    .sort((a, b) => wordCount(a.text) - wordCount(b.text))[0] ?? null;
```

with:

```ts
const lineHeight = (l: OcrLine) => l.bbox.y1 - l.bbox.y0;

const classLine =
  lines
    .filter((l) => CLASS_KEYWORDS.test(l.text) && !/GOVERNMENT/i.test(l.text))
    .sort((a, b) => lineHeight(b) - lineHeight(a))[0] ?? null;
```

- [ ] **Step 2: Change `brandLine`'s selection from first-match to tallest-wins**

Replace:

```ts
const brandLine =
  preWarningLines.find(
    (l) =>
      l !== classLine &&
      l !== alcoholLine &&
      l !== netLine &&
      l !== producerLine &&
      l.text.length >= 3 &&
      wordCount(l.text) <= 6 &&
      !l.text.includes(",") &&
      !BRAND_NOISE.test(l.text) &&
      !BRAND_DENYLIST.test(l.text) &&
      !/GOVERNMENT/i.test(l.text) &&
      !new RegExp(COUNTRY_MARKERS, "i").test(l.text),
  ) ?? null;
```

with:

```ts
const brandLine =
  preWarningLines
    .filter(
      (l) =>
        l !== classLine &&
        l !== alcoholLine &&
        l !== netLine &&
        l !== producerLine &&
        l.text.length >= 3 &&
        wordCount(l.text) <= 6 &&
        !l.text.includes(",") &&
        !BRAND_NOISE.test(l.text) &&
        !BRAND_DENYLIST.test(l.text) &&
        !/GOVERNMENT/i.test(l.text) &&
        !new RegExp(COUNTRY_MARKERS, "i").test(l.text),
    )
    .sort((a, b) => lineHeight(b) - lineHeight(a))[0] ?? null;
```

- [ ] **Step 3: Run the existing suite and fix the two tests whose fixtures rely on flat-text order/word-count instead of a real height differential**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts`

Two tests are expected to fail, because `mkLines`' default (uniform height for every line) removes
the height signal these two specifically rely on — both migrate from the string-based `parseOcrText`
shim to `parseOcrTextLines` with explicit heights that model the real-world relationship (the actual
class/type designation line prints larger than incidental marketing prose containing the same
keyword):

Replace:

```ts
it("classType prefers the short designation line over a longer line that incidentally contains the same keyword (Guinness-style)", () => {
  const r = parseOcrText(GUINNESS_STYLE_OCR, 0.9);
  expect(r.classType.value).toBe("DRAUGHT STOUT");
});
```

with:

```ts
it("classType prefers the taller (more prominent) designation line over a longer line that incidentally contains the same keyword (Guinness-style)", () => {
  const strings = GUINNESS_STYLE_OCR.split("\n");
  // strings: [0] marketing line 1, [1] marketing line 2 (contains "beer"), [2] "GUINNESS",
  // [3] "DRAUGHT STOUT", [4] ABV, [5] net contents. DRAUGHT STOUT prints larger than the fine-print
  // marketing lines above it, same as the real can.
  const lines = mkLines(strings, { heights: [12, 12, 30, 24, 10, 10] });
  const r = parseOcrTextLines(lines, GUINNESS_STYLE_OCR, 1000, 1000);
  expect(r.classType.value).toBe("DRAUGHT STOUT");
});
```

Replace:

```ts
it("classType prefers a newly-recognized varietal line over marketing prose containing an unrelated class keyword (Kunde-style)", () => {
  const text = [
    "LA CREMA",
    "Kunde, a beloved wine-growing visionary, who planted the vineyard with her husband,",
    "CHARDONNAY",
    "13.5% Alc/Vol",
    "750 mL",
  ].join("\n");
  const r = parseOcrText(text, 0.9);
  expect(r.classType.value).toBe("CHARDONNAY");
});
```

with:

```ts
it("classType prefers the taller varietal line over marketing prose containing an unrelated class keyword (Kunde-style)", () => {
  const strings = [
    "LA CREMA",
    "Kunde, a beloved wine-growing visionary, who planted the vineyard with her husband,",
    "CHARDONNAY",
    "13.5% Alc/Vol",
    "750 mL",
  ];
  // The marketing sentence contains "wine" as a whole word (matches CLASS_KEYWORDS) but prints as
  // small fine print; CHARDONNAY is the real, larger class/type designation.
  const lines = mkLines(strings, { heights: [30, 10, 26, 14, 14] });
  const r = parseOcrTextLines(lines, strings.join("\n"), 1000, 1000);
  expect(r.classType.value).toBe("CHARDONNAY");
});
```

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts`
Expected: all pass, including the two replaced tests and every other existing test unchanged (they
either have only one candidate line surviving the shape filters, so sort order is moot, or are
themselves testing a genuine height/word-count tie, where a stable sort over `mkLines`' uniform
default height preserves the same first-wins result as before).

- [ ] **Step 4: Add new tests exercising the prominence signal directly**

Add to the end of the `describe("parseOcrText", ...)` block:

```ts
it("brandName picks the taller candidate over an earlier, shorter one", () => {
  const strings = [
    "Est. Since 1849",
    "REAL BRAND NAME",
    "Kentucky Straight Bourbon Whiskey",
    "45% Alc./Vol.",
    "750 mL",
  ];
  // "Est. Since 1849" has a digit -> already rejected by BRAND_NOISE regardless of height, so use a
  // shape-plausible-but-wrong earlier candidate instead: a short, comma-free, low-prominence line.
  const withValidEarlierCandidate = [
    "Fine Spirits",
    "REAL BRAND NAME",
    "Kentucky Straight Bourbon Whiskey",
    "45% Alc./Vol.",
    "750 mL",
  ];
  const lines = mkLines(withValidEarlierCandidate, { heights: [10, 40, 20, 14, 14] });
  const r = parseOcrTextLines(lines, withValidEarlierCandidate.join("\n"), 1000, 1000);
  expect(r.brandName.value).toBe("REAL BRAND NAME");
});
```

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `pnpm vitest run && pnpm exec tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add lib/vision/ocr-parser.ts lib/vision/ocr-parser.test.ts
git commit -m "Use line height (prominence) instead of word-count/order for brand/class selection

Replaces classType's shortest-line-wins and brandName's
first-in-reading-order tiebreaks with a real visual signal: the
tallest surviving shape-filtered candidate wins, matching how these
fields are actually printed on real labels."
```

---

### Task 3: `FieldResult.confidence` in the matching layer

**Files:**

- Modify: `lib/schema.ts`
- Modify: `lib/matching/verify.ts`
- Modify: `lib/matching/verify.test.ts`

**Interfaces:**

- Produces: `FieldResult.confidence: number` (0..1) — every `FieldResult` returned by `verifyLabel`.
- Produces: `export const CONFIDENCE_REVIEW_THRESHOLD = 0.5` and `export const CONFIDENCE_HIGH_THRESHOLD = 0.8` from `lib/matching/verify.ts`, consumed by Task 4's `FieldRow`.

- [ ] **Step 1: Write the failing test**

In `lib/matching/verify.test.ts`, add to the end of the `describe("verifyLabel", ...)` block:

```ts
it("FieldResult.confidence matches the underlying extracted field's confidence", () => {
  const r = verifyLabel(app, { ...clean, classType: f("Kentucky Straight Bourbon Whiskey", 0.73) });
  expect(r.fields.find((x) => x.field === "classType")?.confidence).toBe(0.73);
});
it("a missing field's FieldResult has confidence 0", () => {
  const noNet = { ...clean, netContents: f(null) };
  const r = verifyLabel(app, noNet);
  expect(r.fields.find((x) => x.field === "netContents")?.confidence).toBe(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run lib/matching/verify.test.ts`
Expected: FAIL — `confidence` is `undefined` on the returned `FieldResult` (property doesn't exist
yet on the type, so this will actually fail at typecheck first if run through `tsc`; running vitest
directly will show `expect(undefined).toBe(0.73)` failing).

- [ ] **Step 3: Add `confidence` to `FieldResult`**

In `lib/schema.ts`, replace:

```ts
export interface FieldResult {
  field: keyof ExtractedLabel;
  applicationValue: string | null;
  labelValue: string | null;
  verdict: Verdict;
  reason: string; // plain-English, agent-facing
}
```

with:

```ts
export interface FieldResult {
  field: keyof ExtractedLabel;
  applicationValue: string | null;
  labelValue: string | null;
  verdict: Verdict;
  reason: string; // plain-English, agent-facing
  confidence: number; // 0..1, the extracted field's own confidence
}
```

- [ ] **Step 4: Populate it in `lib/matching/verify.ts`**

Replace:

```ts
const CONFIDENCE_REVIEW_THRESHOLD = 0.5;

function missing(field: keyof ExtractedLabel, applicationValue: string): FieldResult {
  return {
    field,
    applicationValue,
    labelValue: null,
    verdict: "REVIEW",
    reason: `${FIELD_LABELS[field]} was not found on the label — verify by eye.`,
  };
}

// Extraction confidence is treated as UNTRUSTED and strictly ONE-DIRECTIONAL: it may only downgrade a
// MATCH to REVIEW, never upgrade a verdict or rescue a MISMATCH. So a prompt-injected cloud model that
// self-reports confidence: 1.0 can never manufacture a PASS (REVIEW never causes FAIL either) — the worst
// it achieves is forgoing this extra "verify by eye" nudge, while deterministic matching and the always-on
// health-warning bold-check note still stand. Deriving confidence from an independent signal (cross-checking
// the cloud transcription against local-ocr) is a documented, deferred hardening (audit §2); it is kept out
// of matching so this layer never branches on which tier ran (architecture rule 2).
function withConfidence(result: FieldResult, extracted: ExtractedField): FieldResult {
  if (result.verdict === "MATCH" && extracted.confidence < CONFIDENCE_REVIEW_THRESHOLD) {
    return { ...result, verdict: "REVIEW", reason: `${result.reason} (Low extraction confidence — verify by eye.)` };
  }
  return result;
}
```

with:

```ts
// Exported so lib/matching/verify.test.ts and components/field-row.tsx's confidence-tier display
// share the exact same boundaries — the displayed tier can never disagree with the actual
// REVIEW-downgrade decision a field already went through.
export const CONFIDENCE_REVIEW_THRESHOLD = 0.5;
export const CONFIDENCE_HIGH_THRESHOLD = 0.8;

function missing(field: keyof ExtractedLabel, applicationValue: string): FieldResult {
  return {
    field,
    applicationValue,
    labelValue: null,
    verdict: "REVIEW",
    confidence: 0,
    reason: `${FIELD_LABELS[field]} was not found on the label — verify by eye.`,
  };
}

// Extraction confidence is treated as UNTRUSTED and strictly ONE-DIRECTIONAL: it may only downgrade a
// MATCH to REVIEW, never upgrade a verdict or rescue a MISMATCH. So a prompt-injected cloud model that
// self-reports confidence: 1.0 can never manufacture a PASS (REVIEW never causes FAIL either) — the worst
// it achieves is forgoing this extra "verify by eye" nudge, while deterministic matching and the always-on
// health-warning bold-check note still stand. Deriving confidence from an independent signal (cross-checking
// the cloud transcription against local-ocr) is a documented, deferred hardening (audit §2); it is kept out
// of matching so this layer never branches on which tier ran (architecture rule 2).
function withConfidence(result: FieldResult, extracted: ExtractedField): FieldResult {
  const withScore = { ...result, confidence: extracted.confidence };
  if (withScore.verdict === "MATCH" && extracted.confidence < CONFIDENCE_REVIEW_THRESHOLD) {
    return {
      ...withScore,
      verdict: "REVIEW",
      reason: `${withScore.reason} (Low extraction confidence — verify by eye.)`,
    };
  }
  return withScore;
}
```

Then, further down in the same file, replace the manually-constructed `FieldResult` literal (the
"alcohol content required but not provided" branch):

```ts
fields.push({
  field: "alcoholContent",
  applicationValue: null,
  labelValue: extracted.alcoholContent.value,
  verdict: "REVIEW",
  reason: "Alcohol content is required for this beverage type but was not provided in the application — request it.",
});
```

with:

```ts
fields.push({
  field: "alcoholContent",
  applicationValue: null,
  labelValue: extracted.alcoholContent.value,
  verdict: "REVIEW",
  confidence: extracted.alcoholContent.confidence,
  reason: "Alcohol content is required for this beverage type but was not provided in the application — request it.",
});
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `pnpm vitest run lib/matching/verify.test.ts`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `pnpm vitest run && pnpm exec tsc --noEmit`
Expected: all pass. (`components/field-row.test.tsx`'s `base: FieldResult` literal will fail to
typecheck until Task 4 adds `confidence` to it — if Task 4 isn't done yet, this specific failure is
expected and resolved there; don't add a `confidence` field to that test file's fixtures here, since
Task 4 owns that file.)

- [ ] **Step 7: Commit**

```bash
git add lib/schema.ts lib/matching/verify.ts lib/matching/verify.test.ts
git commit -m "Surface extracted field confidence on FieldResult

verify.ts already read each field's confidence to decide the
MATCH->REVIEW downgrade and threw the number away afterward; it now
attaches it to the result. Exports the existing 0.5 REVIEW threshold
plus a new 0.8 high-confidence threshold so a future confidence
display can never disagree with the actual downgrade decision."
```

---

### Task 4: Confidence display in `FieldRow` (single-label view + batch table)

**Files:**

- Modify: `components/field-row.tsx`
- Modify: `components/field-row.test.tsx`

**Interfaces:**

- Consumes: `FieldResult.confidence`, `CONFIDENCE_REVIEW_THRESHOLD`, `CONFIDENCE_HIGH_THRESHOLD` from Task 3.
- No new exports — `BatchTable` already renders `VerdictCard` → `FieldRow` for its expanded detail row, so this one component change covers both surfaces.

- [ ] **Step 1: Write the failing tests**

In `components/field-row.test.tsx`, first fix the existing `base` fixture (now missing a required
property) by replacing:

```ts
const base: FieldResult = {
  field: "alcoholContent",
  applicationValue: "45% Alc./Vol.",
  labelValue: "45% Alc./Vol.",
  verdict: "MATCH",
  reason: "Matches the application exactly.",
};
```

with:

```ts
const base: FieldResult = {
  field: "alcoholContent",
  applicationValue: "45% Alc./Vol.",
  labelValue: "45% Alc./Vol.",
  verdict: "MATCH",
  reason: "Matches the application exactly.",
  confidence: 0.95,
};
```

Then add a new `describe` block at the end of the file:

```ts
describe("FieldRow confidence display", () => {
  it("renders the High tier and percentage at >= 0.8", () => {
    render(<ul><FieldRow result={{ ...base, confidence: 0.94 }} beverageType="distilled-spirits" /></ul>);
    expect(screen.getByText("Confidence: High (94%)")).toBeInTheDocument();
  });
  it("renders the Medium tier and percentage at 0.5-0.8", () => {
    render(<ul><FieldRow result={{ ...base, confidence: 0.58 }} beverageType="distilled-spirits" /></ul>);
    expect(screen.getByText("Confidence: Medium (58%)")).toBeInTheDocument();
  });
  it("renders the Low tier and percentage below 0.5", () => {
    render(<ul><FieldRow result={{ ...base, confidence: 0.12 }} beverageType="distilled-spirits" /></ul>);
    expect(screen.getByText("Confidence: Low (12%)")).toBeInTheDocument();
  });
  it("treats exactly 0.5 as Medium, matching verify.ts's strict-less-than downgrade boundary", () => {
    render(<ul><FieldRow result={{ ...base, confidence: 0.5 }} beverageType="distilled-spirits" /></ul>);
    expect(screen.getByText("Confidence: Medium (50%)")).toBeInTheDocument();
  });
  it("treats exactly 0.8 as High", () => {
    render(<ul><FieldRow result={{ ...base, confidence: 0.8 }} beverageType="distilled-spirits" /></ul>);
    expect(screen.getByText("Confidence: High (80%)")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run components/field-row.test.tsx`
Expected: FAIL — no "Confidence:" text is rendered yet.

- [ ] **Step 3: Implement the confidence tier helper and display line**

In `components/field-row.tsx`, replace:

```ts
import { AlertTriangle, CheckCircle2, Scale, XCircle } from "lucide-react";
import type { BeverageType, FieldResult } from "@/lib/schema";
import { FIELD_LABELS } from "@/lib/schema";
import { citationFor } from "@/lib/ttb/citations";
```

with:

```ts
import { AlertTriangle, CheckCircle2, Scale, XCircle } from "lucide-react";
import type { BeverageType, FieldResult } from "@/lib/schema";
import { FIELD_LABELS } from "@/lib/schema";
import { citationFor } from "@/lib/ttb/citations";
import { CONFIDENCE_HIGH_THRESHOLD, CONFIDENCE_REVIEW_THRESHOLD } from "@/lib/matching/verify";

// Mirrors verify.ts's own MATCH->REVIEW downgrade boundary (strict less-than at 0.5) so the
// displayed tier can never disagree with the verdict a field already went through.
function confidenceTier(confidence: number): "High" | "Medium" | "Low" {
  if (confidence >= CONFIDENCE_HIGH_THRESHOLD) return "High";
  if (confidence >= CONFIDENCE_REVIEW_THRESHOLD) return "Medium";
  return "Low";
}
```

Then, in the same file, replace:

```ts
      <p className="mt-2 pl-8 text-base text-muted-foreground">{result.reason}</p>
```

with:

```ts
      <p className="mt-2 pl-8 text-base text-muted-foreground">{result.reason}</p>
      <p className="mt-1 pl-8 text-sm text-muted-foreground">
        Confidence: {confidenceTier(result.confidence)} ({Math.round(result.confidence * 100)}%)
      </p>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run components/field-row.test.tsx`
Expected: PASS, all tests including the 5 new ones.

- [ ] **Step 5: Run the full test suite, typecheck, and lint**

Run: `pnpm vitest run && pnpm exec tsc --noEmit && pnpm lint`
Expected: all pass.

- [ ] **Step 6: Manual smoke check**

Run: `pnpm dev`, open the single-label page, verify with a bundled mock sample, and confirm each
field row shows a "Confidence: <Tier> (<N>%)" line. Then check the batch page with a small batch and
expand a row's "View details" to confirm the same line appears there too (via the shared
`VerdictCard`/`FieldRow`).

- [ ] **Step 7: Commit**

```bash
git add components/field-row.tsx components/field-row.test.tsx
git commit -m "Show extraction confidence (tier + percentage) on each field row

Surfaces FieldResult.confidence for the first time in the UI, on both
the single-label view and the batch table's expanded detail (both
already share FieldRow via VerdictCard). Tiering reuses verify.ts's
existing 0.5/0.8 thresholds so the displayed tier never disagrees with
the actual REVIEW-downgrade decision a field already went through."
```

---

### Task 5: Validate and record the accuracy delta

**Files:**

- Modify: `docs/deferred-items-and-tradeoffs-2026-07-23.md` (append, don't rewrite — this is the
  project's running status doc for this line of work)

**Interfaces:** none — this task only runs and records, no code changes.

- [ ] **Step 1: Confirm the mock-tier gate is unaffected**

Run: `pnpm eval`
Expected: still 13/13 (100%) — the mock tier never reaches `ocr-parser.ts`, so any change here is a
signal something leaked outside local-ocr scope.

- [ ] **Step 2: Run the real-world eval on local-ocr and record the numbers**

Run: `pnpm eval:real-world`
Record: overall accuracy, per-field accuracy, and planted-violation catch rate, compared against the
17/46 (37%) baseline recorded in `docs/deferred-items-and-tradeoffs-2026-07-23.md`.

- [ ] **Step 3: Append the result to the status doc**

Add a new section at the end of `docs/deferred-items-and-tradeoffs-2026-07-23.md`:

```markdown
## Update 2026-07-24 — line-level prominence and confidence

Implemented `docs/superpowers/specs/2026-07-24-local-ocr-prominence-and-confidence-design.md`:
Tesseract's per-line bbox/confidence (previously not even requested) now drives brandName/classType
selection (tallest candidate wins, replacing word-count/reading-order guesses) and every field's
confidence/boundingBox (replacing the blanket per-image number). Confidence is now shown in the UI
(tier + percentage) for the first time.

`pnpm eval:real-world` (local-ocr tier): **17/46 (37%)** -> **<FILL IN ACTUAL RESULT>**. Per-field:
<FILL IN ACTUAL PER-FIELD NUMBERS>. Mock-tier gate held at 13/13 (100%).
```

(The `<FILL IN...>` placeholders here are for the plan executor to replace with the real numbers
from Step 2 — not a gap in this plan, since the actual numbers don't exist until Step 2 runs.)

- [ ] **Step 4: Commit**

```bash
git add docs/deferred-items-and-tradeoffs-2026-07-23.md
git commit -m "Record the local-ocr eval delta from line-level prominence and confidence"
```

## Self-Review

**Spec coverage:**

- §1 (requesting `blocks: true`) — Task 1, Step 2. ✓
- §2 (flattening into `OcrLine[]`, dropping `overallConfidence`) — Task 1, Steps 1-2. ✓
- §3 (prominence-based `brandName`/`classType`) — Task 2. ✓
- §4 (real per-line confidence, all 7 fields) — Task 1, Step 1 (`field()` helper). ✓
- §5 (multi-line min-confidence/union-bbox) — Task 1, Step 1 (`field()` handles arrays; `warningSources` walk). ✓
- §6 (bbox → schema fractions, clamped) — Task 1, Step 1 (`toBoundingBox`). ✓
- §7 (`FieldResult.confidence` + UI tier/percentage display) — Tasks 3 and 4. ✓
- Error handling (null `blocks`, non-finite confidence, malformed bbox, resize-dimension capture) — Task 1, Steps 1-2, with explicit tests in Steps 3-4. ✓
- Testing plan (fixture migration, new prominence/confidence/aggregation/bbox tests, `verify.test.ts`, `field-row.test.tsx`, eval validation) — Tasks 1, 2, 3, 4, 5. ✓

**Placeholder scan:** the only `<FILL IN...>` text is in Task 5, Step 3, and is explicitly called out
as depending on Step 2's real (not-yet-existing) run output — not a planning gap.

**Type consistency:** `OcrLine` (Task 1) is used identically in Task 2's sort and Task 1's tests;
`FieldResult.confidence` (Task 3) is consumed by the exact same name in Task 4; `CONFIDENCE_REVIEW_THRESHOLD`/`CONFIDENCE_HIGH_THRESHOLD` are exported from `verify.ts` in Task 3 and imported by that exact name in Task 4.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-24-local-ocr-prominence-and-confidence.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
