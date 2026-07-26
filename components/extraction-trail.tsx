import { FIELD_LABELS } from "@/lib/schema";
import type { ExtractionTrace } from "@/lib/vision/escalation/types";

const STOP_REASON: Record<ExtractionTrace["stoppedBecause"], string> = {
  clean: "no weak fields left",
  cap: "hit the attempt cap",
  budget: "ran out of time budget",
  "no-plan": "no repair worth attempting",
  "not-repairable": "fixture-keyed tier — repairs cannot help",
};

/** Dev-mode only (gated by the caller, components/verdict-card.tsx). Too technical for the everyday
 *  reviewer, but the fastest way to understand why an extraction came out the way it did. */
export function ExtractionTrail({ trace }: { trace: ExtractionTrace }) {
  if (trace.attempts.length === 0) return null;
  return (
    <div className="mt-4 rounded-xl border border-border bg-muted p-4 text-sm text-muted-foreground">
      <p className="mb-2 font-semibold text-foreground">Escalation ladder</p>
      <ol className="space-y-2">
        {trace.attempts.map((attempt, i) => (
          <li key={i} className="border-l-2 border-border pl-3">
            <span className="font-mono">{attempt.transform}</span> → <strong>{attempt.outcome}</strong>{" "}
            <span className="tabular-nums">({attempt.durationMs} ms)</span>
            {attempt.improvedFields.length > 0 ? (
              <div>improved: {attempt.improvedFields.map((f) => FIELD_LABELS[f]).join(", ")}</div>
            ) : null}
            {attempt.error ? <div className="text-verdict-non-compliant">error: {attempt.error}</div> : null}
          </li>
        ))}
      </ol>
      <p className="mt-3 border-t border-border pt-2">
        {trace.extraCalls} extra extraction call{trace.extraCalls === 1 ? "" : "s"} · stopped:{" "}
        {STOP_REASON[trace.stoppedBecause]} · tier: {trace.tier} · {trace.totalMs} ms total
      </p>
    </div>
  );
}
