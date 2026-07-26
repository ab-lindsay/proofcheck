import { ThumbsDown, ThumbsUp } from "lucide-react";
import { FIELD_LABELS, type FieldResult } from "@/lib/schema";
import { CONFIDENCE_HIGH_THRESHOLD, CONFIDENCE_NEEDS_CORRECTION_THRESHOLD } from "@/lib/matching/verify";

export interface FieldDetailsProps {
  field: FieldResult;
  onFeedback?: (field: string, direction: "up" | "down") => void;
  feedbackState?: "up" | "down" | null;
}

// Deliberately NOT verdict-coloured and deliberately not the COMPLIANT/NON_COMPLIANT icon set: these buttons
// collect an opinion about the explanation, they do not change the verdict (invariant 1). A green
// CheckCircle2 inside a red NON_COMPLIANT row read as a control that overrides the result.
const BUTTON_BASE =
  "flex h-11 w-11 items-center justify-center rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-ring/40";

export function FieldDetails({ field, onFeedback, feedbackState }: FieldDetailsProps) {
  // One pair of these buttons renders per field row, so the accessible name must say WHICH
  // explanation it rates — identically-named buttons are indistinguishable to a screen reader.
  const fieldLabel = FIELD_LABELS[field.field];
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Was this explanation helpful?</span>
      <button
        type="button"
        aria-label={`Mark the ${fieldLabel} explanation as helpful`}
        aria-pressed={feedbackState === "up"}
        onClick={() => onFeedback?.(field.field, "up")}
        className={`${BUTTON_BASE} ${
          feedbackState === "up" ? "bg-accent text-primary" : "text-muted-foreground hover:bg-muted"
        }`}
      >
        <ThumbsUp aria-hidden className="h-5 w-5" />
      </button>
      <button
        type="button"
        aria-label={`Mark the ${fieldLabel} explanation as not helpful`}
        aria-pressed={feedbackState === "down"}
        onClick={() => onFeedback?.(field.field, "down")}
        className={`${BUTTON_BASE} ${
          feedbackState === "down" ? "bg-accent text-primary" : "text-muted-foreground hover:bg-muted"
        }`}
      >
        <ThumbsDown aria-hidden className="h-5 w-5" />
      </button>
    </div>
  );
}

/** Explains the confidence NUMBER, which is the extractor's self-reported reading confidence —
 *  never a statement about whether the field matches. verify.ts treats it as untrusted and
 *  one-directional (it can only downgrade a COMPLIANT to NEEDS_CORRECTION, never manufacture one), so any
 *  match-shaped wording here would both overclaim and contradict the row's own verdict pill.
 *  Thresholds are the same constants the visible tier uses, so this text and the tier can never disagree.
 *  Rendered as always-visible text in FieldRow (not a hover-only title attribute) — a title tooltip
 *  never surfaces on a touch device, which is the primary device for this app's target user. */
export function confidenceExplanation(confidence: number): string {
  const tail =
    " This score is about how clearly the text was read, not whether it matches — the verdict comes from comparing it with your application.";
  if (confidence >= CONFIDENCE_HIGH_THRESHOLD) return "Read clearly." + tail;
  if (confidence >= CONFIDENCE_NEEDS_CORRECTION_THRESHOLD) return "Read with some uncertainty." + tail;
  // No causal claim here: this band also renders beside NON_COMPLIANT rows, where the verdict came
  // from the comparison, not the score (confidence only ever downgrades a COMPLIANT).
  return "Read with low confidence — double-check this field on the label." + tail;
}
