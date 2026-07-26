import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";

export interface FieldStat {
  compliant: number;
  total: number;
  /** NEEDS_CORRECTION verdicts for this field across the run. Tracked separately from `compliant`
   *  so a tolerant entry's "verify by eye" row is visible instead of silently inflating the
   *  compliance metric. Optional: older history lines and the batch set's simple counters predate
   *  this split. */
  needsCorrection?: number;
  nonCompliant?: number;
}

export interface RunSummary {
  provider: string;
  set: string;
  entries: number;
  /** Count of entries whose overall verdict matched ground truth ("overall disposition agreement"
   *  in eval/run.ts's console output) — NOT a count of compliant labels; a correctly-caught
   *  REJECTED counts the same as a correct APPROVED. For a `set: "batch"` run this field means
   *  something narrower still: a count of generic assertion passes (CSV parse shape, row count,
   *  per-row verdict, batch-overall) from runBatchEval, not label-level disposition agreement. */
  overallCompliant: number;
  overallTotal: number;
  perField: Record<string, FieldStat>;
  violationsCaught: number;
  violationsTotal: number;
  extractionErrors: number;
  /** Total field-level NEEDS_CORRECTION verdicts across the run (sum over perField). NOT counted
   *  toward overallCompliant or perField.compliant — a tolerant entry's NEEDS_CORRECTION doesn't
   *  fail the run, but it's still not a compliant result, so it's surfaced here instead of being
   *  folded into the headline compliance number. */
  needsCorrection?: number;
  // Plain real photos vs. deliberately-degraded (blur/skew/glare/lowres/combo) synthetic fixtures —
  // their pass rates move independently (see docs/deferred-items-and-tradeoffs-2026-07-23.md), so a
  // blended overall number alone can hide whether a change actually helped real-world photography.
  // Omitted (not just zeroed) when a set has no `degraded/`-prefixed entries, so old history lines
  // and sets without this split stay meaningfully distinct from "we checked and found nothing there."
  bySubset?: { real: FieldStat; degraded: FieldStat };
  /** Whether the escalation ladder was active for this run. Older history lines predate the ladder
   *  and omit it, which is why a comparison must read this rather than assume. */
  escalation?: boolean;
  /** Total extra extraction calls the ladder spent across the whole set — the cost side of the
   *  accuracy delta. */
  extraCalls?: number;
  /** True when the run covered only a `--only` subset. Suffixes the detail file so a subset run
   *  can't overwrite (and thus corrupt) the canonical full-run detail file that
   *  eval/compare-escalation.ts reads. */
  subset?: boolean;
}

export interface DetailRow {
  file: string;
  field: string;
  actual: string;
  expectedOneOf: string[];
  ok: boolean;
  extractedValue: string | null;
  appValue: string | null;
}

export interface RunRecord {
  summary: RunSummary;
  details: DetailRow[];
}

export interface RecordPaths {
  historyPath?: string;
  resultsDir?: string;
}

const DEFAULT_HISTORY_PATH = path.join("eval", "history.jsonl");
const DEFAULT_RESULTS_DIR = path.join("eval", ".results");

// Best-effort provenance for a history line. Eval is a dev-only tool that may run outside a git
// checkout (or without git on PATH) — degrade to nulls rather than crash the whole eval run over
// metadata that isn't essential to the accuracy numbers themselves.
function gitMeta(): { gitSha: string | null; dirty: boolean | null } {
  try {
    const gitSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    const status = execSync("git status --porcelain", { encoding: "utf8" });
    return { gitSha, dirty: status.trim().length > 0 };
  } catch {
    return { gitSha: null, dirty: null };
  }
}

export async function recordRun(runData: RunRecord, paths: RecordPaths = {}): Promise<void> {
  const historyPath = paths.historyPath ?? DEFAULT_HISTORY_PATH;
  const resultsDir = paths.resultsDir ?? DEFAULT_RESULTS_DIR;
  const { gitSha, dirty } = gitMeta();

  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    gitSha,
    dirty,
    ...runData.summary,
  });
  await appendFile(historyPath, line + "\n", "utf8");

  await mkdir(resultsDir, { recursive: true });
  // Suffix by condition so a --no-escalate baseline and a ladder run of the same set/provider don't
  // overwrite each other — the paired per-label comparison (eval/compare-escalation.ts) needs both.
  // A --only subset run gets its own suffix so it can never clobber the canonical full detail file.
  const suffix =
    (runData.summary.subset ? "-subset" : "") + (runData.summary.escalation === false ? "-no-escalate" : "");
  const detailPath = path.join(resultsDir, `${runData.summary.set}-${runData.summary.provider}${suffix}.json`);
  await writeFile(detailPath, JSON.stringify(runData.details, null, 2), "utf8");
}
