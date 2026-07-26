import type { ExtractedLabel, FieldResult } from "@/lib/schema";
import { normalizeLoose } from "@/lib/ttb/normalize";

export function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[n];
}

export function fuzzyVerdict(args: {
  field: keyof ExtractedLabel;
  applicationValue: string;
  labelValue: string;
  normalizedEqualIsMatch: boolean;
}): FieldResult {
  const { field, applicationValue, labelValue, normalizedEqualIsMatch } = args;
  // confidence: 0 is a placeholder — verify.ts's withConfidence() always overwrites it with the
  // real extracted confidence before this result reaches a caller.
  const base = { field, applicationValue, labelValue, confidence: 0 };
  if (applicationValue === labelValue) {
    return { ...base, verdict: "COMPLIANT", reason: "Matches the application exactly." };
  }
  const a = normalizeLoose(applicationValue);
  const b = normalizeLoose(labelValue);
  // D2a (false-APPROVED, HIGH, 2026-07-25 hardening): normalizeLoose strips [^a-z0-9\s], so an
  // all-non-Latin/symbolic string (CJK, Cyrillic, etc.) folds to "". Two DIFFERENT non-Latin
  // strings then both normalize to "" and would compare equal below — a false COMPLIANT wherever
  // normalizedEqualIsMatch is true (classType, nameAndAddress, countryOfOrigin). Neither COMPLIANT
  // nor NON_COMPLIANT is honest here: the fold genuinely cannot compare this text, so it must always
  // be NEEDS_CORRECTION, regardless of normalizedEqualIsMatch.
  if ((a === "" && applicationValue.trim() !== "") || (b === "" && labelValue.trim() !== "")) {
    return {
      ...base,
      verdict: "NEEDS_CORRECTION",
      reason: `Could not be compared automatically ("${applicationValue}" vs "${labelValue}" — non-Latin or symbolic text) — verify by eye.`,
    };
  }
  if (a === b) {
    return normalizedEqualIsMatch
      ? {
          ...base,
          verdict: "COMPLIANT",
          reason: "Matches the application (differs only in capitalization/punctuation).",
        }
      : {
          ...base,
          verdict: "NEEDS_CORRECTION",
          reason: `Same name, different styling ("${applicationValue}" vs "${labelValue}") — confirm this is intentional.`,
        };
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const isWordBoundaryPrefix =
    shorter.length > 0 &&
    longer.startsWith(shorter) &&
    (longer.length === shorter.length || longer[shorter.length] === " ");
  if (isWordBoundaryPrefix) {
    return {
      ...base,
      verdict: "NEEDS_CORRECTION",
      reason: `One name is a shorter form of the other ("${applicationValue}" vs "${labelValue}") — confirm this is the same brand/product.`,
    };
  }
  const threshold = Math.max(2, Math.round(a.length * 0.2));
  // D5 companion (2026-07-25): edit distance is always >= the difference in length, so once the
  // normalized lengths differ by more than the threshold, the full distance is guaranteed to
  // exceed it too — skip the O(m*n) levenshtein call rather than run it on a pathological input
  // (paired with the ExtractedFieldSchema.max(2000) cap). Behavior-preserving: the mathematical
  // bound means the verdict here is identical to what the full computation below would produce.
  if (Math.abs(a.length - b.length) > threshold) {
    return {
      ...base,
      verdict: "NON_COMPLIANT",
      reason: `Label shows "${labelValue}" but the application says "${applicationValue}".`,
    };
  }
  const distance = levenshtein(a, b);
  if (distance <= threshold) {
    return {
      ...base,
      verdict: "NEEDS_CORRECTION",
      reason: `Close but not identical ("${applicationValue}" vs "${labelValue}") — needs a human look.`,
    };
  }
  return {
    ...base,
    verdict: "NON_COMPLIANT",
    reason: `Label shows "${labelValue}" but the application says "${applicationValue}".`,
  };
}
