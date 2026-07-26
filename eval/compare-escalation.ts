import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DetailRow } from "@/eval/record-run";

/** Paired per-label diff of a --no-escalate detail file against a ladder detail file.
 *  Usage: pnpm tsx eval/compare-escalation.ts <set> <provider>
 *  Reads eval/.results/<set>-<provider>-no-escalate.json and eval/.results/<set>-<provider>.json.
 *
 *  Why paired: same-SHA cloud runs vary by ±5/46 overall (see eval/history.jsonl), so a single
 *  before/after pair of blended numbers cannot resolve the ladder's expected delta. Comparing the
 *  SAME label across conditions cancels most of that variance, and the monotonic merge predicts
 *  regressed ≈ 0 as a built-in sanity check. */
async function main() {
  const [set, provider] = process.argv.slice(2);
  if (!set || !provider) {
    console.error("usage: pnpm tsx eval/compare-escalation.ts <set> <provider>");
    process.exit(1);
  }
  const dir = path.join("eval", ".results");
  const load = async (suffix: string): Promise<Map<string, string>> => {
    const rows: DetailRow[] = JSON.parse(await readFile(path.join(dir, `${set}-${provider}${suffix}.json`), "utf8"));
    return new Map(rows.filter((r) => r.field === "__overall__").map((r) => [r.file, r.actual]));
  };
  const baseline = await load("-no-escalate");
  const ladder = await load("");

  const improved: string[] = [];
  const regressed: string[] = [];
  let unchanged = 0;
  for (const [file, before] of baseline) {
    const after = ladder.get(file);
    if (after === undefined) continue; // extraction error in one condition — reported by the runs themselves
    const row = `${file}: ${before} -> ${after}`;
    if (before === after) unchanged++;
    else if (before === "REJECTED" && after === "APPROVED") improved.push(row);
    else regressed.push(row);
  }
  console.log(`paired per-label comparison — set=${set} provider=${provider}`);
  console.log(`unchanged: ${unchanged}`);
  console.log(`improved (REJECTED -> APPROVED): ${improved.length}`);
  for (const row of improved) console.log(`  + ${row}`);
  console.log(`regressed (APPROVED -> REJECTED): ${regressed.length}`);
  for (const row of regressed) console.log(`  - ${row}`);
  if (regressed.length > 0) {
    console.error("\nNOTE: the monotonic merge predicts zero regressions on a deterministic tier;");
    console.error("on a stochastic cloud tier, isolate whether these reproduce with --only before blaming the ladder.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
