import type { ExtractedField, ExtractedLabel, FieldResult } from "@/lib/schema";
import { HEALTH_WARNING_TEXT } from "@/lib/ttb/warning";
import { collapseWhitespace } from "@/lib/ttb/normalize";

const FIELD: keyof ExtractedLabel = "healthWarningStatement";

export function checkHealthWarning(field: ExtractedField): FieldResult {
  // confidence: 0 is a placeholder — verify.ts's withConfidence() always overwrites it.
  const base = { field: FIELD, applicationValue: HEALTH_WARNING_TEXT, confidence: 0 };
  // An empty or whitespace-only transcription means the region was found but nothing was read —
  // treat it as unread (NEEDS_CORRECTION), the same guard compare() gives every other field,
  // never a NON_COMPLIANT asserting a regulatory violation that was never observed.
  if (!field.present || field.value === null || field.value.trim() === "") {
    return {
      ...base,
      labelValue: null,
      verdict: "NEEDS_CORRECTION",
      reason:
        "No health warning statement found on the label — verify by eye. It is mandatory on all alcohol beverages (≥ 0.5% ABV).",
    };
  }
  const label = collapseWhitespace(field.value);
  if (label === HEALTH_WARNING_TEXT) {
    return {
      ...base,
      labelValue: field.value,
      verdict: "COMPLIANT",
      reason: "Statement matches the mandatory text word-for-word.",
    };
  }
  if (!label.startsWith("GOVERNMENT WARNING:")) {
    if (label.toUpperCase().startsWith("GOVERNMENT WARNING:")) {
      return {
        ...base,
        labelValue: field.value,
        verdict: "NON_COMPLIANT",
        reason: `"GOVERNMENT WARNING" must appear in capital letters — the label shows "${label.slice(0, 19)}".`,
      };
    }
    return {
      ...base,
      labelValue: field.value,
      verdict: "NON_COMPLIANT",
      reason: 'Statement does not begin with the required "GOVERNMENT WARNING:" prefix.',
    };
  }
  // Case/spacing-only deviations → NEEDS_CORRECTION, not NON_COMPLIANT: the printed § 16.21 body is sentence case,
  // but TTB approves all-caps renderings in practice (9/10 real approved labels in eval/samples).
  if (label.toUpperCase() === HEALTH_WARNING_TEXT.toUpperCase()) {
    return {
      ...base,
      labelValue: field.value,
      verdict: "NEEDS_CORRECTION",
      reason:
        "Wording is exact; only letter case differs from the canonical text (commonly approved) — confirm styling.",
    };
  }
  if (label.replace(/\s+/g, "").toUpperCase() === HEALTH_WARNING_TEXT.replace(/\s+/g, "").toUpperCase()) {
    return {
      ...base,
      labelValue: field.value,
      verdict: "NEEDS_CORRECTION",
      reason:
        "Wording is exact; spacing (and possibly letter case) differs from the canonical text — confirm formatting.",
    };
  }
  let i = 0;
  const max = Math.min(label.length, HEALTH_WARNING_TEXT.length);
  while (i < max && label[i] === HEALTH_WARNING_TEXT[i]) i++;
  const snippet = label.slice(Math.max(0, i - 20), i + 20);
  return {
    ...base,
    labelValue: field.value,
    verdict: "NON_COMPLIANT",
    reason: `Statement deviates from the mandatory text near: "…${snippet}…". The warning must appear exactly as written in the TTB regulations.`,
  };
}
