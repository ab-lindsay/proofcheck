import type { ExtractedField, ExtractedLabel } from "@/lib/schema";
import { FILL_ONLY_FIELDS, type LabelField } from "@/lib/vision/escalation/types";

const usable = (field: ExtractedField): boolean => field.present && field.value !== null && field.value.trim() !== "";

/**
 * Monotonic merge (spec §3.3): a repair may only IMPROVE a field.
 *
 * This is what makes "crop the image and re-extract" safe as a repair strategy. A tight crop around
 * the health warning returns every other field as absent; because absent can never overwrite
 * present, those are simply ignored rather than needing a special case. It also guarantees the
 * ladder cannot produce a worse result than the single-shot baseline — worst case it costs time.
 *
 * Ties keep the baseline so the merge is deterministic and never churns a value for no measured gain.
 *
 * NOTE: mergeExtraction's improvement detection relies on this function returning `base` or
 * `repair` BY IDENTITY — never a constructed object. If that ever changes, the reference check
 * below silently breaks.
 */
export function mergeField(base: ExtractedField, repair: ExtractedField, fillOnly = false): ExtractedField {
  if (!usable(repair)) return base;
  if (!usable(base)) return repair;
  if (fillOnly) return base;
  return repair.confidence > base.confidence ? repair : base;
}

export function mergeExtraction(
  base: ExtractedLabel,
  repair: ExtractedLabel,
): { merged: ExtractedLabel; improvedFields: LabelField[] } {
  const merged = { ...base };
  const improvedFields: LabelField[] = [];
  for (const name of Object.keys(base) as LabelField[]) {
    const next = mergeField(base[name], repair[name], FILL_ONLY_FIELDS.has(name));
    if (next !== base[name]) {
      merged[name] = next;
      improvedFields.push(name);
    }
  }
  return { merged, improvedFields };
}
