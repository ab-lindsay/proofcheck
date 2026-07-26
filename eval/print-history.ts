import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatRatioPct } from "@/eval/format";

interface LegacyFieldStat {
  /** Pre-2026-07-26 field name for `compliant`, from before the verdict-vocabulary rename. */
  correct?: number;
  compliant?: number;
  total: number;
}

export interface HistoryEntry {
  timestamp: string;
  gitSha: string | null;
  dirty: boolean | null;
  provider: string;
  set: string;
  entries: number;
  /** Pre-2026-07-26 history lines wrote this as `overallCorrect`. Both keys are read (see
   *  `overallCompliantOf` below); the design doc's decision was to rename the writer without
   *  rewriting 134 already-committed lines, so the reader has to carry both spellings. */
  overallCorrect?: number;
  overallCompliant?: number;
  overallTotal: number;
  perField: Record<string, LegacyFieldStat>;
  violationsCaught: number;
  violationsTotal: number;
  extractionErrors: number;
  // Recorded by recordRun but previously dropped from the printed table, making a ladder-on run or
  // a --only subset run visually indistinguishable from a clean full run (D6c, 2026-07-25).
  escalation?: boolean;
  subset?: boolean;
  bySubset?: { real: LegacyFieldStat; degraded: LegacyFieldStat };
}

/** Reads either spelling a history line may use for the "verdict matched ground truth" count —
 *  `overallCompliant` (current) or `overallCorrect` (every line before the 2026-07-26 rename). */
function overallCompliantOf(e: HistoryEntry): number {
  return e.overallCompliant ?? e.overallCorrect ?? 0;
}

/** Same dual-spelling read for a per-field stat bucket: `compliant` (current) or `correct` (legacy). */
function fieldCompliantOf(stat: LegacyFieldStat): number {
  return stat.compliant ?? stat.correct ?? 0;
}

export function parseHistory(raw: string): HistoryEntry[] {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let skipped = 0;
  const entries = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as HistoryEntry];
    } catch {
      skipped++;
      return [];
    }
  });

  if (skipped > 0) {
    console.warn(`parseHistory: skipped ${skipped} malformed line(s) in eval/history.jsonl`);
  }

  return entries;
}

export function filterHistory(entries: HistoryEntry[], filters: { set?: string; provider?: string }): HistoryEntry[] {
  return entries.filter(
    (e) =>
      (filters.set === undefined || e.set === filters.set) &&
      (filters.provider === undefined || e.provider === filters.provider),
  );
}

export function formatHistoryTable(entries: HistoryEntry[], limit: number): string {
  const rows = entries.slice(-limit);
  if (rows.length === 0) return "No matching history entries found.";
  return rows
    .map((e) => {
      const sha = e.gitSha ? e.gitSha.slice(0, 7) + (e.dirty ? "*" : "") : "unknown";
      const overallCompliant = overallCompliantOf(e);
      const overallPct = e.overallTotal === 0 ? 100 : Math.round((overallCompliant / e.overallTotal) * 100);
      const violationPct = formatRatioPct(e.violationsCaught, e.violationsTotal);
      const perField = Object.entries(e.perField)
        .map(([field, stat]) => `${field} ${fieldCompliantOf(stat)}/${stat.total}`)
        .join(" · ");
      const subsetLine = e.bySubset
        ? `\n  real ${fieldCompliantOf(e.bySubset.real)}/${e.bySubset.real.total} · ` +
          `degraded ${fieldCompliantOf(e.bySubset.degraded)}/${e.bySubset.degraded.total}`
        : "";
      const markers = [e.escalation ? "ladder" : null, e.subset ? "subset" : null].filter(Boolean).join(", ");
      const tag = markers ? ` [${markers}]` : "";
      return (
        `${e.timestamp}  ${sha}  ${e.provider}/${e.set}${tag}  ` +
        `overall ${overallCompliant}/${e.overallTotal} (${overallPct}%)  ` +
        `violations ${e.violationsCaught}/${e.violationsTotal} (${violationPct})\n  ${perField}${subsetLine}`
      );
    })
    .join("\n\n");
}

async function main() {
  const setIndex = process.argv.indexOf("--set");
  const set = setIndex >= 0 ? process.argv[setIndex + 1] : undefined;
  const providerIndex = process.argv.indexOf("--provider");
  const provider = providerIndex >= 0 ? process.argv[providerIndex + 1] : undefined;
  const limitIndex = process.argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : 20;

  const historyPath = path.join("eval", "history.jsonl");
  let raw: string;
  try {
    raw = await readFile(historyPath, "utf8");
  } catch {
    console.log("No eval/history.jsonl found yet — run `pnpm eval` or `pnpm eval:real-world` first.");
    return;
  }

  const entries = parseHistory(raw);
  const filtered = filterHistory(entries, { set, provider });
  console.log(formatHistoryTable(filtered, limit));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
