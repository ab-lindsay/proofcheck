export type DiffTokenKind = "same" | "case-diff" | "space-diff" | "diverge";

export interface DiffToken {
  text: string;
  kind: DiffTokenKind;
}

function tokenize(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t !== "");
}

function isSpace(t: string): boolean {
  return /^\s+$/.test(t);
}

// "GOVERNMENT", " ", "WARNING:" — the mandatory prefix's own 3 tokens (see HEALTH_WARNING_TEXT).
// warning.ts treats ANY case deviation here as NON_COMPLIANT (TTB requires it specifically in
// capitals), unlike the body where case-only deviations are NEEDS_CORRECTION — so a case-diff at
// these positions is classified "diverge" below, not "case-diff", to keep this visualization from
// contradicting the verdict pill it sits under (amber highlights under a red NON_COMPLIANT banner).
const PREFIX_TOKEN_COUNT = 3;

/**
 * Splits canonical/extracted into whitespace-delimited tokens and classifies where they diverge.
 * Mirrors the NEEDS_CORRECTION/NON_COMPLIANT boundary lib/matching/warning.ts already decides — this never
 * re-judges, it only visualizes: case/space-only differences are "case-diff"/"space-diff" (the
 * conditions that already produce NEEDS_CORRECTION there); a genuine wording difference collapses the rest
 * of both strings into one trailing "diverge" token per side (what already produces NON_COMPLIANT). If
 * one side simply runs out first (missing trailing text), only the longer side gets a diverge tail.
 */
export function diffWarningTokens(
  canonical: string,
  extracted: string,
): { canonical: DiffToken[]; extracted: DiffToken[] } {
  const a = tokenize(canonical);
  const b = tokenize(extracted);
  const canonicalOut: DiffToken[] = [];
  const extractedOut: DiffToken[] = [];
  const len = Math.min(a.length, b.length);

  let i = 0;
  for (; i < len; i++) {
    const ca = a[i];
    const cb = b[i];
    if (isSpace(ca) && isSpace(cb)) {
      canonicalOut.push({ text: ca, kind: ca === cb ? "same" : "space-diff" });
      extractedOut.push({ text: cb, kind: ca === cb ? "same" : "space-diff" });
      continue;
    }
    if (!isSpace(ca) && !isSpace(cb) && ca.toLowerCase() === cb.toLowerCase()) {
      // If lowercase versions match, determine if it's exact match or case-diff
      const kind = ca === cb ? "same" : i < PREFIX_TOKEN_COUNT ? "diverge" : "case-diff";
      canonicalOut.push({ text: ca, kind });
      extractedOut.push({ text: cb, kind });
      continue;
    }
    break;
  }

  const restA = a.slice(i).join("");
  const restB = b.slice(i).join("");
  if (restA) canonicalOut.push({ text: restA, kind: "diverge" });
  if (restB) extractedOut.push({ text: restB, kind: "diverge" });

  return { canonical: canonicalOut, extracted: extractedOut };
}
