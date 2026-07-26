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

// Real brand/fanciful names are short (<=6 words); a longer leftover line is almost always marketing
// copy, not a brand. classType/brandName selection among multiple candidates is height-driven (the
// tallest line wins — see lineHeight below); wordCount here is only this shape gate, not a tiebreak.
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
  // text (which would flip a spacing-only NEEDS_CORRECTION into a NON_COMPLIANT).
  // If the closing "health problems." isn't found cleanly (common on real photos — OCR garbles the
  // final period), stop the fallback capture at the first trailing URL or barcode/UPC digit run
  // instead of running to end-of-string. Canonical § 16.21 warning text contains neither, so this
  // can never clip real warning content — it only trims OCR noise appended after the statement.
  const warningMatch =
    joined.match(/GOVERNMENT\s+WARNING:.*?health\s+problems\s*\./i) ??
    joined.match(/GOVERNMENT\s+WARNING:.*?(?=\s+(?:www\.|https?:\/\/|\d{4,})|$)/i);

  const lineHeight = (l: OcrLine) => l.bbox.y1 - l.bbox.y0;

  const classLine =
    lines
      .filter((l) => CLASS_KEYWORDS.test(l.text) && !/GOVERNMENT/i.test(l.text))
      .sort((a, b) => lineHeight(b) - lineHeight(a))[0] ?? null;

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
  // The next line is only a credible company line if it isn't the GOVERNMENT WARNING block — on real
  // labels the warning sits right below the producer credit, so when OCR drops the (small) company
  // line, the adjacent line is the warning header, not an address.
  const producerNextRaw = producerIsVerbPhraseOnly ? lines[producerLineIndex + 1] : undefined;
  const producerNextLine = producerNextRaw && !/GOVERNMENT/i.test(producerNextRaw.text) ? producerNextRaw : undefined;
  // In the verb-phrase-only branch the fallback must never be the bare verb phrase itself (there is
  // no name in it to compare): no credible next line means the field is absent — a "not found"
  // NEEDS_CORRECTION downstream, not a false NON_COMPLIANT against the applicant's real address.
  const nameAndAddressValue = producerMatch
    ? producerMatch[1].trim()
    : producerIsVerbPhraseOnly
      ? (producerNextLine?.text ?? null)
      : (producerLine?.text ?? null);
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
  // NEEDS_CORRECTION — instead of grabbing a warning-body line like "women should not drink...". Anchor on the
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

  // Which OcrLines contributed to the matched warning span, for confidence/bbox — walk forward from
  // the GOVERNMENT line, accumulating collapsed text until it covers the matched length, so this
  // never walks past what the regex above already decided is the statement (the trailing-URL/
  // barcode bound still applies to the VALUE; this only decides which lines back the confidence).
  const warningSources: OcrLine[] = [];
  if (warningMatch && warningStart >= 0) {
    const targetLength = collapseWhitespace(warningMatch[0]).length;
    let accumulated = "";
    for (let i = warningStart; i < lines.length && accumulated.length < targetLength; i++) {
      warningSources.push(lines[i]);
      accumulated = collapseWhitespace(`${accumulated} ${lines[i].text}`);
    }
  }

  // If "GOVERNMENT" itself is split across two OCR lines (rare — dehyphenation can reconnect it in
  // fullText while the per-line data still holds it broken), warningStart is -1 and warningSources
  // stays empty even though warningMatch found a value. Treat that as not-found too, the same as
  // every other field, rather than returning a non-null value with present:false.
  const warningValue = warningSources.length > 0 && warningMatch ? warningMatch[0] : null;

  // Validate before returning: invariant 2 — every extraction tier returns a Zod-validated ExtractedLabel.
  return ExtractedLabelSchema.parse({
    brandName: field(brandLine?.text ?? null, brandLine),
    classType: field(classLine?.text ?? null, classLine),
    alcoholContent: field(alcoholLine?.text ?? null, alcoholLine),
    netContents: field(netLine?.text ?? null, netLine),
    nameAndAddress: field(nameAndAddressValue, nameAndAddressSource),
    countryOfOrigin: field(countryMatch ? countryMatch[1].trim() : null, countryLine),
    healthWarningStatement: field(warningValue, warningSources.length > 0 ? warningSources : null),
  });
}
