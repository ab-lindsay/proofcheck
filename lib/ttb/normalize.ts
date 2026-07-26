export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Latin letters with NO canonical decomposition — NFKD leaves them unchanged, so without an explicit
// fold the `[^a-z0-9\s]` strip below would delete them (æ -> " "), diverging a proper glyph from its
// ASCII transliteration and producing wrong verdicts.
const FOLD: Record<string, string> = {
  æ: "ae",
  œ: "oe",
  ø: "o",
  ß: "ss",
  þ: "th",
  ð: "d",
  ł: "l",
  đ: "d",
  ħ: "h",
};

// Derived from FOLD's own keys so the two can never desync. Previously the class was written out by
// hand; if a key were added to one and not the other, the replacer would return `undefined`, which
// String.replace stringifies to the literal text "undefined" — and being pure [a-z] it would survive
// the punctuation strip below and silently corrupt every comparison built on normalizeLoose.
// (All FOLD keys are plain letters, so none needs regex escaping.)
const FOLD_PATTERN = new RegExp(`[${Object.keys(FOLD).join("")}]`, "g");

export function normalizeLoose(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks (é -> e)
    .toLowerCase()
    .replace(FOLD_PATTERN, (c) => FOLD[c]) // fold non-decomposable letters
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseAlcoholContent(s: string): { abv: number } | null {
  const pct = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return { abv: parseFloat(pct[1]) };
  const proof = s.match(/(\d+(?:\.\d+)?)\s*proof/i);
  if (proof) return { abv: parseFloat(proof[1]) / 2 };
  return null;
}

export function abvToProof(abv: number): number {
  return abv * 2;
}

const UNIT_ML: Record<string, number> = {
  ml: 1,
  cl: 10,
  l: 1000,
  liter: 1000,
  liters: 1000,
  "fl oz": 29.5735,
  floz: 29.5735,
  oz: 29.5735,
};

export function parseNetContents(s: string): { ml: number } | null {
  const cleaned = s
    .toLowerCase()
    // D2c (European decimal comma, MED, 2026-07-25 hardening): a comma is ambiguous between a US
    // thousands separator ("1,750" -> 1750) and a European decimal point ("0,75" -> 0.75). Three
    // rules, in order: (1) a bare-zero integer part can never be a thousands count, so "0,750 L"
    // (a real 27 CFR 4.72 standard of fill, European-formatted) is a decimal; (2) a comma
    // followed by exactly three digits is a thousands separator — lookahead, not capture, so
    // multi-group "1,234,567" strips both commas in one pass; (3) a comma followed by 1-2 digits
    // can only be a decimal fraction (nobody groups thousands in ones or tens).
    .replace(/(^|[^\d])0,(\d{1,3})(?!\d)/g, "$10.$2") // "0,750 L" -> "0.750 L"; "0,75" -> "0.75"
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1") // "1,750" -> "1750"; "1,234,567" -> "1234567"
    .replace(/(\d),(\d{1,2})(?!\d)/g, "$1.$2") // "1,5" -> "1.5"
    .replace(/\.(?!\d)/g, ""); // keep decimals ("1.75 L"); drop "fl. oz." dots
  // \d*\.?\d+ so a leading-decimal (".75 L") keeps its value instead of dropping the dot
  const m = cleaned.match(/(\d*\.?\d+)\s*(fl\s?oz|floz|ml|cl|liters?|l|oz)\b/);
  if (!m) return null;
  const unit = m[2].replace(/\s+/g, " ").trim();
  const key = unit === "fl oz" ? "fl oz" : unit;
  const mult = UNIT_ML[key];
  // Unreachable today — every alternative in the regex above resolves to a UNIT_ML key. Kept because
  // a unit added to the regex WITHOUT a map entry yields `parseFloat(...) * undefined` = NaN, and
  // lib/vision/ocr-parser.ts uses `parseNetContents(text) !== null` as a LINE SELECTOR: `{ml: NaN}`
  // is not null, so the parser would accept an unreadable line as the net contents. Returning null
  // keeps that failure honest (NEEDS_CORRECTION) instead of silently wrong. tsconfig has no
  // noUncheckedIndexedAccess, so TypeScript cannot catch the desync for us.
  /* v8 ignore next */
  if (!mult) return null;
  return { ml: parseFloat(m[1]) * mult };
}
