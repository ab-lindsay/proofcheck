import { AlertTriangle, CheckCircle2, Scale, XCircle } from "lucide-react";
import type { BeverageType, FieldResult } from "@/lib/schema";
import { FIELD_LABELS } from "@/lib/schema";
import { citationFor } from "@/lib/ttb/citations";
import { CONFIDENCE_HIGH_THRESHOLD, CONFIDENCE_NEEDS_CORRECTION_THRESHOLD } from "@/lib/matching/verify";
import { CharacterDiff } from "@/components/character-diff";
import { useDevMode } from "@/hooks/use-dev-mode";
import { confidenceExplanation, FieldDetails } from "@/components/field-details";

// Mirrors verify.ts's own COMPLIANT->NEEDS_CORRECTION downgrade boundary (strict less-than at 0.5) so the
// displayed tier can never disagree with the verdict a field already went through.
function confidenceTier(confidence: number): "High" | "Medium" | "Low" {
  if (confidence >= CONFIDENCE_HIGH_THRESHOLD) return "High";
  if (confidence >= CONFIDENCE_NEEDS_CORRECTION_THRESHOLD) return "Medium";
  return "Low";
}

const STYLE = {
  COMPLIANT: {
    icon: CheckCircle2,
    dot: "text-verdict-compliant",
    pill: "border-verdict-compliant/30 bg-verdict-compliant-bg text-verdict-compliant",
    text: "Compliant",
  },
  NON_COMPLIANT: {
    icon: XCircle,
    dot: "text-verdict-non-compliant",
    pill: "border-verdict-non-compliant/30 bg-verdict-non-compliant-bg text-verdict-non-compliant",
    text: "Non-compliant",
  },
  NEEDS_CORRECTION: {
    icon: AlertTriangle,
    dot: "text-verdict-needs-correction",
    pill: "border-verdict-needs-correction/30 bg-verdict-needs-correction-bg text-verdict-needs-correction",
    // Matches the overall banner's wording. "Needs review" beside a NEEDS CORRECTION header read as
    // two different things when it is one.
    text: "Needs correction",
  },
} as const;

export function FieldRow({
  result,
  beverageType,
  feedbackState,
  onFeedback,
}: {
  result: FieldResult;
  beverageType: BeverageType;
  feedbackState?: "up" | "down" | null;
  onFeedback?: (field: string, direction: "up" | "down") => void;
}) {
  const devMode = useDevMode();
  const style = STYLE[result.verdict];
  const Icon = style.icon;
  const label = FIELD_LABELS[result.field];
  const citation = citationFor(result.field, beverageType);
  return (
    <li className="py-4">
      <div className="flex items-center gap-2">
        <Icon aria-hidden className={`h-6 w-6 shrink-0 ${style.dot}`} />
        <span className="text-lg font-semibold text-foreground">{label}</span>
        <div className="ml-auto flex flex-col items-end gap-1">
          <span className={`rounded-full border px-2.5 py-1 text-base font-bold uppercase tracking-wide ${style.pill}`}>
            {style.text}
          </span>
          <span className="text-xs text-muted-foreground">
            Confidence: {confidenceTier(result.confidence)} ({Math.round(result.confidence * 100)}%)
          </span>
        </div>
      </div>
      {/* No inequality guard: hiding the diff when the two strings match is exactly the regression
          character-diff.test.tsx pins — the character-level assurance is most wanted on a byte-exact
          health warning statement, i.e. precisely when the values ARE equal. */}
      {devMode && result.applicationValue && result.labelValue ? (
        <div className="mt-2 pl-8">
          <CharacterDiff
            canonical={result.applicationValue}
            extracted={result.labelValue}
            variant={result.field === "healthWarningStatement" ? "warning" : "field"}
          />
        </div>
      ) : (
        <div className="mt-2 grid gap-2 pl-8 sm:grid-cols-2">
          <div className="rounded-lg bg-muted px-3 py-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application</div>
            <div className="mt-0.5 text-base break-words text-foreground">{result.applicationValue ?? "—"}</div>
          </div>
          <div className="rounded-lg bg-muted px-3 py-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Label</div>
            <div className="mt-0.5 text-base break-words text-foreground">{result.labelValue ?? "not found"}</div>
          </div>
        </div>
      )}
      <p className="mt-2 pl-8 text-base text-muted-foreground">{result.reason}</p>
      {/* Always visible — a hover-only title tooltip never surfaces on a touch device, which is the
          primary device for this app's target user (73-year-old, non-technical). */}
      <p className="mt-1 pl-8 text-sm text-muted-foreground">{confidenceExplanation(result.confidence)}</p>
      {citation ? (
        <p className="mt-1.5 flex items-start gap-1 pl-8 text-base text-muted-foreground">
          <Scale aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
          <span>
            <span className="font-semibold text-foreground">Basis:</span> {citation.basis}{" "}
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-primary underline underline-offset-2 hover:no-underline"
            >
              {citation.cfr}
              {"\u00A0"}↗
            </a>
          </span>
        </p>
      ) : null}
      <div className="mt-2 pl-8">
        <FieldDetails field={result} feedbackState={feedbackState} onFeedback={onFeedback} />
      </div>
    </li>
  );
}
