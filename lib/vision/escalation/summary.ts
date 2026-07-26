import { FIELD_LABELS } from "@/lib/schema";
import type { ExtractionTrace, LabelField } from "@/lib/vision/escalation/types";

/**
 * The one plain-English line shown to every reviewer when the ladder actually recovered something.
 * Deliberately says nothing when no field improved: a reviewer should never have to read about work
 * that changed nothing. Jargon-free per the "usable by a non-technical 73-year-old" bar — no counts,
 * no transform names, no tier names (those live in the dev-mode trail).
 */
export function repairSummary(trace: ExtractionTrace | undefined): string | null {
  if (!trace) return null;
  const improved = [...new Set(trace.attempts.flatMap((a) => a.improvedFields))] as LabelField[];
  if (improved.length === 0) return null;

  const names = improved.map((f) => FIELD_LABELS[f].toLowerCase());
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const pronoun = improved.length === 1 ? "it" : "them";
  return `Took a closer look at the ${list} to read ${pronoun} more clearly.`;
}
