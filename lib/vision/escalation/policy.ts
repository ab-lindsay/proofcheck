import type { BoundingBox, ExtractedField, ExtractedLabel } from "@/lib/schema";
import { CONFIDENCE_NEEDS_CORRECTION_THRESHOLD } from "@/lib/matching/verify";
import { FILL_ONLY_FIELDS, type LabelField, type RepairPlan } from "@/lib/vision/escalation/types";

/** Repair order = expected value of a second look, highest first.
 *  healthWarningStatement leads because it is checked byte-exact: one wrong character flips
 *  COMPLIANT -> NON_COMPLIANT, so a better transcription is worth more here than anywhere else. */
export const FIELD_PRIORITY: readonly LabelField[] = [
  "healthWarningStatement",
  "brandName",
  "classType",
  "netContents",
  "alcoholContent",
  "nameAndAddress",
  "countryOfOrigin",
];

/** Whether ABSENCE is worth spending a call on. Low confidence always is.
 *  countryOfOrigin is false: domestic labels legitimately lack it, so treating its absence as weak
 *  would spend the whole attempt budget re-reading a field that is correctly not there. */
export const REPAIR_ON_ABSENT: Record<LabelField, boolean> = {
  healthWarningStatement: true,
  brandName: true,
  classType: true,
  netContents: true,
  alcoholContent: true,
  nameAndAddress: true,
  countryOfOrigin: false,
};

/** Weak = the extraction read this badly. Intrinsic to the extraction only — never a comparison
 *  against ApplicationData (spec §3.2: the ladder must not be able to retry toward an APPROVED). */
export function isWeak(field: ExtractedField): boolean {
  if (!field.present || field.value === null || field.value.trim() === "") return true;
  return field.confidence < CONFIDENCE_NEEDS_CORRECTION_THRESHOLD;
}

export function weakFields(label: ExtractedLabel): LabelField[] {
  return FIELD_PRIORITY.filter((name) => {
    const field = label[name];
    const blank = !field.present || field.value === null || field.value.trim() === "";
    if (blank) return REPAIR_ON_ABSENT[name];
    // A PRESENT fill-only field (health warning) can never be improved by a repair — the merge
    // refuses to replace it — so planning one just burns cloud calls. Only its absent state (above)
    // is repairable. Low confidence on a present fill-only field is a matching-layer NEEDS_CORRECTION nudge,
    // not a ladder trigger.
    if (FILL_ONLY_FIELDS.has(name)) return false;
    return isWeak(field);
  });
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function unionBox(boxes: BoundingBox[]): BoundingBox {
  const x = clamp01(Math.min(...boxes.map((b) => b.x)));
  const y = clamp01(Math.min(...boxes.map((b) => b.y)));
  const right = clamp01(Math.max(...boxes.map((b) => b.x + b.width)));
  const bottom = clamp01(Math.max(...boxes.map((b) => b.y + b.height)));
  return { x, y, width: clamp01(right - x), height: clamp01(bottom - y) };
}

/** Three or more weak fields suggests a whole-image quality problem (glare, dim, low res) rather
 *  than a few hard-to-read regions — so enhance the whole image before cropping. */
const WHOLE_IMAGE_WEAK_THRESHOLD = 3;

export function planRepairs(label: ExtractedLabel, maxPlans: number): RepairPlan[] {
  const weak = weakFields(label);
  if (weak.length === 0) return [];

  const boxed = weak.filter((name) => label[name].boundingBox != null);
  const cropPlan: RepairPlan | null =
    boxed.length > 0
      ? {
          transform: "crop",
          targetFields: boxed,
          box: unionBox(boxed.map((name) => label[name].boundingBox as BoundingBox)),
        }
      : null;
  const enhancePlan: RepairPlan = { transform: "enhance", targetFields: weak, box: null };

  const plans: RepairPlan[] =
    cropPlan === null
      ? [enhancePlan]
      : weak.length >= WHOLE_IMAGE_WEAK_THRESHOLD
        ? [enhancePlan, cropPlan]
        : [cropPlan, enhancePlan];

  return plans.slice(0, Math.max(0, maxPlans));
}
