import type { BoundingBox, ExtractedLabel } from "@/lib/schema";
import type { ImageMeta, VisionProvider } from "@/lib/vision/types";

export type LabelField = keyof ExtractedLabel;

/**
 * Fields where a repair may FILL an absent value but never REPLACE a present one. Shared by the
 * merge (which enforces it) and the policy (which must not plan an unimprovable repair for a
 * present one).
 *
 * The health warning statement is the one field whose correct answer an attacker already knows — a
 * published federal constant, checked byte-exact. Confidence-ranked replacement would let injected
 * artwork overwrite an honest low-confidence read of a defective warning with the forged canonical
 * text (REJECTED→APPROVED), so it is fill-only.
 */
export const FILL_ONLY_FIELDS: ReadonlySet<LabelField> = new Set(["healthWarningStatement"]);

/** The image operation applied before re-extracting. */
export type RepairTransform = "crop" | "enhance";

export interface RepairPlan {
  transform: RepairTransform;
  /** Fields this plan is trying to recover. Informational for the trace; the merge is per-field. */
  targetFields: LabelField[];
  /** Union bounding box for "crop"; always null for "enhance". */
  box: BoundingBox | null;
}

/** Invariant 5: the client-visible trace may carry only these categories, never e.message — real
 *  adapter messages embed raw model output (ExtractionError), AWS error bodies, and SDK URLs. */
export type RepairErrorKind = "invalid-model-output" | "call-failed" | "transform-failed";

export interface RepairAttempt {
  transform: RepairTransform;
  targetFields: LabelField[];
  durationMs: number;
  outcome: "improved" | "no-change" | "failed";
  improvedFields: LabelField[];
  error?: RepairErrorKind;
}

export interface ExtractionTrace {
  tier: string;
  baselineWeakFields: LabelField[];
  attempts: RepairAttempt[];
  extraCalls: number;
  totalMs: number;
  stoppedBecause: "clean" | "cap" | "budget" | "no-plan" | "not-repairable";
}

export interface EscalationOptions {
  budgetMs?: number;
  maxAttempts?: number;
  /** Injectable clock so the deadline path is testable without real waiting. */
  now?: () => number;
}

export interface EscalatingProvider extends VisionProvider {
  extractWithTrace(
    image: Buffer,
    meta: ImageMeta,
    opts?: EscalationOptions,
  ): Promise<{ label: ExtractedLabel; trace: ExtractionTrace }>;
}
