"use client";
import { useState } from "react";
import { CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import type { VerifyResponse } from "@/hooks/use-verify";
import { FieldRow } from "@/components/field-row";
import { ExtractionTrail } from "@/components/extraction-trail";
import { LabelImageViewer } from "@/components/label-image-viewer";
import { repairSummary } from "@/lib/vision/escalation/summary";
import { useDevMode } from "@/hooks/use-dev-mode";

/**
 * One entry per overall disposition. Gradients are fixed rather than theme-toggled so white text
 * stays legible regardless of page theme — verified white-on-gradient contrast, both ends:
 *   approved 11.40:1 / 6.17:1   needs correction 11.74:1 / 5.86:1   rejected 10.67:1 / 6.64:1
 */
const OVERALL_STYLE = {
  APPROVED: {
    icon: CheckCircle2,
    label: "APPROVED",
    gradient: "bg-gradient-to-r from-[#24402a] to-[#3f6b46]",
    blurb: "No mismatches found.",
  },
  NEEDS_CORRECTION: {
    icon: AlertTriangle,
    label: "NEEDS CORRECTION",
    gradient: "bg-gradient-to-r from-[#4a3410] to-[#7d5f3f]",
    // Careful: four different situations produce this disposition (a field that couldn't be read, a
    // warning read but styled differently, a required value missing from the application, a
    // low-confidence read) — the copy must fit all of them, so it points at the per-row reasons
    // instead of asserting one cause.
    blurb: "Nothing contradicts the application, but some fields need your judgment — each yellow row below says why.",
  },
  REJECTED: {
    icon: XCircle,
    label: "REJECTED",
    gradient: "bg-gradient-to-r from-[#7a1815] to-[#b3221c]",
    blurb: "One or more fields don’t match the application.",
  },
} as const;

export function VerdictCard({ result, image }: { result: VerifyResponse; image?: File | null }) {
  const devMode = useDevMode();
  const repaired = repairSummary(result.extraction);
  const style = OVERALL_STYLE[result.overall];
  const reviews = result.fields.filter((f) => f.verdict === "NEEDS_CORRECTION").length;
  const Icon = style.icon;
  const [feedback, setFeedback] = useState<Map<string, "up" | "down">>(new Map());

  const handleFeedback = (field: string, direction: "up" | "down") => {
    setFeedback((prev) => {
      const next = new Map(prev);
      if (next.get(field) === direction) {
        next.delete(field); // Toggle off if same direction clicked again
      } else {
        next.set(field, direction);
      }
      return next;
    });
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div role="status" className={`flex items-center gap-4 px-6 py-5 text-white ${style.gradient}`}>
        <Icon aria-hidden className="h-11 w-11 shrink-0" />
        <div>
          <div className="font-heading text-4xl font-bold tracking-wide">{style.label}</div>
          <p className="mt-0.5 text-base font-medium text-white">{style.blurb}</p>
        </div>
      </div>

      <div className="px-5 py-5 sm:px-6">
        {/* Still shown on a rejection: the mismatch is the headline, but unverified fields need an
            eye too, and the count is not otherwise visible. Redundant-looking under a NEEDS
            CORRECTION banner, but it is the only place the *number* appears. */}
        {reviews > 0 ? (
          <div
            role="status"
            className="mb-4 flex items-center gap-2 rounded-xl border border-verdict-needs-correction/30 bg-verdict-needs-correction-bg px-4 py-3 text-lg font-semibold text-verdict-needs-correction"
          >
            <AlertTriangle aria-hidden className="h-6 w-6 shrink-0 text-verdict-needs-correction" />
            <span>
              {reviews} item{reviews === 1 ? " needs" : "s need"} your review before approving
            </span>
          </div>
        ) : null}

        {repaired ? (
          <p className="mb-4 rounded-xl border border-border bg-muted px-4 py-3 text-base text-muted-foreground">
            {repaired}
          </p>
        ) : null}

        <ul className="divide-y divide-border">
          {result.fields.map((f) => (
            <FieldRow
              key={f.field}
              result={f}
              beverageType={result.beverageType}
              feedbackState={feedback.get(f.field) ?? null}
              onFeedback={handleFeedback}
            />
          ))}
        </ul>

        {result.warnings.length > 0 ? (
          <div className="mt-5 rounded-xl border border-border bg-muted p-4 text-base text-muted-foreground">
            <p className="mb-1 font-semibold text-foreground">Notes</p>
            <ul className="list-disc space-y-1 pl-5">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {image ? (
          <div className="mt-5">
            <LabelImageViewer file={image} alt={`Label image: ${image.name}`} />
          </div>
        ) : null}

        {devMode && result.extraction ? <ExtractionTrail trace={result.extraction} /> : null}

        <p className="mt-5 border-t border-border pt-3 text-right text-sm text-muted-foreground">
          Checked in {result.processingMs < 100 ? "< 0.1" : (result.processingMs / 1000).toFixed(1)} s
        </p>
        {/* Tier/provider is internal jargon to a non-technical user — keep it dev-mode-only, but
            gated on devMode alone, not result.extraction: escalation is off by default, so most
            requests have no extraction trace, and this shouldn't disappear whenever they don't. */}
        {devMode ? (
          <p className="text-right text-xs text-muted-foreground">
            tier: {result.tier}
            {result.tier === "cloud" ? ` (${result.provider})` : ""}
          </p>
        ) : null}
      </div>
    </div>
  );
}
