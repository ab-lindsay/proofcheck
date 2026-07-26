import { readFile } from "node:fs/promises";
import path from "node:path";
import { ApplicationDataSchema, ExtractedLabelSchema } from "@/lib/schema";
import { providerByName, selectCloudProvider } from "@/lib/vision/select";
import { verifyLabel } from "@/lib/matching/verify";
import { withEscalation } from "@/lib/vision/escalation/escalate";
import type { VisionProvider } from "@/lib/vision/types";

// Mirrors eval/run.ts: this is a plain tsx script, so nothing loads .env.local for it the way
// `pnpm dev` (a Next.js process) does — without this, `--provider bedrock` fails with "key is not
// set" even when the key is present and the app works fine. ENOENT is expected and fine: the
// default keyless tiers need no env file.
try {
  process.loadEnvFile(".env.local");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}

/**
 * Every tier that is actually reachable in this environment — not just the two keyless ones.
 *
 * Measuring only mock + local-ocr meant the "<5 s budget verified" claim rested on the two fastest
 * tiers while the one a reviewer's deployment actually uses (cloud) was never timed. Unconfigured
 * tiers are SKIPPED, not failed, so CI stays keyless and green with no secrets while a developer
 * with a key automatically gets full coverage.
 *
 * local-llm is opt-in (`--provider local-llm`): it needs a running Ollama, and probing for one adds
 * a slow failure path to every default run.
 */
function selectedTiers(): { name: string; provider: VisionProvider }[] {
  const i = process.argv.indexOf("--provider");
  if (i >= 0 && process.argv[i + 1]) {
    const name = process.argv[i + 1];
    return [{ name, provider: providerByName(name) }];
  }
  const tiers = [
    { name: "mock", provider: providerByName("mock") },
    { name: "local-ocr", provider: providerByName("local-ocr") },
  ];
  const cloud = selectCloudProvider();
  if (cloud) tiers.push({ name: cloud.name, provider: cloud });
  else console.log("(skipping cloud: no API key configured — set one to include it)\n");
  return tiers;
}

// Spec's end-to-end single-label verify budget ("Sarah's adoption-killer requirement" —
// docs/ARCHITECTURE.md's check-latency skill row). Checked against p95, like a test.
const BUDGET_MS = 5000;

/**
 * Second, categorical gate on the SLOWEST sample.
 *
 * The p95-only verdict was structurally blind to the tail: with 46 samples p95 is the 44th value, so
 * a run printing `max 7136 ms` also printed a clean within-budget summary. That is
 * how a real budget breach on the keyless default tier hid for two days (see
 * docs/superpowers/specs/2026-07-25-local-ocr-latency-and-language-packs-design.md).
 *
 * Deliberately NOT a second copy of BUDGET_MS. Gating max at the product budget would make the gate
 * hostage to the single worst sample in a growing corpus and invite threshold-fudging. Gating it at
 * the route's own EXTRACT_TIMEOUT_MS asserts something categorical instead — no sample may reach the
 * point where /api/verify gives the user a 504 — while p95 keeps asserting the product budget.
 */
const MAX_BUDGET_MS = 8000;

// The synthetic set is clean, small, and fast. Real photographed labels are larger JPEGs that take
// materially longer, so verifying the budget only against `default` overstated the margin — the
// worst case a reviewer hits is a real photo. `--set real-world` measures those.
const SETS: Record<string, string> = {
  default: path.join("eval", "expected.json"),
  "real-world": path.join("eval", "expected-real-world.json"),
};

function selectedSet(): { name: string; file: string } {
  const i = process.argv.indexOf("--set");
  const name = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "default";
  const file = SETS[name];
  if (!file) {
    console.error(`Unknown --set "${name}". Valid sets: ${Object.keys(SETS).join(", ")}`);
    process.exit(1);
  }
  return { name, file };
}

// Matches eval/run.ts's mimeTypeFor — the real upload path sniffs magic bytes from the buffer
// (app/api/verify/route.ts's sniffMime), but this harness only has a filename to go on.
function mimeTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

interface SampleEntry {
  file: string;
  application: unknown;
}

/** Names WHICH budget a tier missed — a bare failure token leaves the reader guessing between a slow
 *  typical case and one pathological sample (different causes, different fixes). Budget language, not
 *  verdict language: APPROVED/REJECTED are label dispositions, and using them for a latency check
 *  made grep-for-verdict audits noisy. */
function verdictFor(r: { p95: number; max: number; ok: boolean }): string {
  if (r.ok) return "WITHIN BUDGET";
  const missed: string[] = [];
  if (r.p95 > BUDGET_MS) missed.push(`p95 > ${BUDGET_MS}ms`);
  if (r.max > MAX_BUDGET_MS) missed.push(`max > ${MAX_BUDGET_MS}ms`);
  return `OVER BUDGET (${missed.join(", ")})`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1;
  return sorted[idx];
}

/**
 * Times the same span app/api/verify/route.ts reports as `processingMs`: wall clock from just
 * before extraction through the (pure, fast) matching step. Extraction failures are logged and
 * excluded from the timing sample rather than aborting the tier (architecture rule 7: fail
 * closed per item, not per batch) — a single bad label shouldn't hide the rest of the tier's
 * latency profile.
 *
 * Mirrors the route's own default: single-shot, with the escalation ladder opt-in via `--escalate`.
 * Two bugs are being avoided here. Timing bare `provider.extract` when the route wrapped every
 * request in the ladder measured a shorter pipeline than the app ran; and defaulting the ladder ON
 * now that the app ships it OFF would measure a longer one. Either way the budget gets verified
 * against something nobody runs, so this flag has to track route.ts.
 */
async function measureTier(provider: VisionProvider, entries: SampleEntry[]): Promise<number[]> {
  const measured = process.argv.includes("--escalate") ? withEscalation(provider) : provider;
  const durations: number[] = [];
  for (const entry of entries) {
    // Everything per-entry lives inside the try: a malformed application or a missing sample file
    // must cost that ONE entry an error line, not abort every remaining entry and tier. The timer
    // still starts after the local file read, so measured time is extract+verify only, as before.
    try {
      const app = ApplicationDataSchema.parse(entry.application);
      const image = await readFile(path.join("eval", "samples", entry.file));
      const started = Date.now();
      const extracted = ExtractedLabelSchema.parse(
        await measured.extract(image, { filename: entry.file, mimeType: mimeTypeFor(entry.file) }),
      );
      verifyLabel(app, extracted);
      durations.push(Date.now() - started);
    } catch (e) {
      console.error(`  ✗ ${provider.name}/${entry.file} → ERROR: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
  }
  return durations;
}

async function main() {
  const set = selectedSet();
  let allEntries: SampleEntry[];
  try {
    allEntries = JSON.parse(await readFile(set.file, "utf8"));
  } catch (e) {
    console.error(`Failed to read or parse ${set.file}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  // Must match measureTier's gate exactly — this only drives the banner, and an inverted copy here
  // made a single-shot run announce itself as having measured the ladder.
  const escalating = process.argv.includes("--escalate");

  console.log(`check-latency: measuring end-to-end verify time over ${allEntries.length} samples (${set.file})`);
  console.log(
    `escalation ladder: ${
      escalating ? "ON (opt-in — matches ESCALATION_ENABLED=1 or the dev-mode switch)" : "OFF (the route's default)"
    }`,
  );
  console.log(`budget: p95 < ${BUDGET_MS} ms AND max < ${MAX_BUDGET_MS} ms (the route's hard timeout) per tier\n`);

  let anyFail = false;
  const rows: { tier: string; p50: number; p95: number; min: number; max: number; n: number; ok: boolean }[] = [];

  for (const { name, provider } of selectedTiers()) {
    const durations = await measureTier(provider, allEntries);
    if (durations.length === 0) {
      console.log(`${name}: no successful runs — cannot assess (see errors above)`);
      anyFail = true;
      continue;
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const max = sorted[sorted.length - 1];
    const ok = p95 <= BUDGET_MS && max <= MAX_BUDGET_MS;
    if (!ok) anyFail = true;
    rows.push({ tier: name, p50, p95, min: sorted[0], max, n: durations.length, ok });
  }

  console.log("tier       p50(ms)  p95(ms)  min(ms)  max(ms)  n   verdict");
  for (const r of rows) {
    console.log(
      `${r.tier.padEnd(10)} ${String(r.p50).padStart(7)}  ${String(r.p95).padStart(7)}  ${String(r.min).padStart(7)}  ` +
        `${String(r.max).padStart(7)}  ${String(r.n).padStart(2)}  ${verdictFor(r)}`,
    );
  }

  console.log();
  if (anyFail) {
    console.error(
      `OVER BUDGET: at least one tier missed the ${BUDGET_MS}ms p95 or ${MAX_BUDGET_MS}ms max budget ` +
        "(or had no successful runs).",
    );
    process.exit(1);
  }
  console.log(`WITHIN BUDGET: all tiers within the ${BUDGET_MS}ms p95 and ${MAX_BUDGET_MS}ms max budgets.`);
  process.exit(0); // terminate lingering tesseract worker threads (local-ocr keeps the event loop alive)
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
