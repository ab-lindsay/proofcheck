import { readFile } from "node:fs/promises";
import path from "node:path";
import { ApplicationDataSchema, type ApplicationData, type Overall, type Verdict } from "@/lib/schema";
import { providerByName } from "@/lib/vision/select";
import type { VisionProvider } from "@/lib/vision/types";
import { withEscalation } from "@/lib/vision/escalation/escalate";
import type { EscalatingProvider } from "@/lib/vision/escalation/types";
import { verifyLabel } from "@/lib/matching/verify";
import { formatRatioPct } from "@/eval/format";
import { recordRun, type DetailRow, type RunSummary } from "@/eval/record-run";
import { checkInjectionGate } from "@/eval/injection-gate";
import { classifyFieldVerdict } from "@/eval/field-scoring";

// Unlike `pnpm dev` (a Next.js process, which loads .env.local automatically), this is a plain
// tsx script — nothing loads .env.local for it otherwise, so cloud-tier API keys are silently
// undefined here even when `pnpm dev` sees them fine. ENOENT (no .env.local at all) is expected
// and fine — the keyless tiers (mock, local-ocr) don't need it.
try {
  process.loadEnvFile(".env.local");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}

// Matches app/api/verify/route.ts's ALLOWED_TYPES — the real upload path detects the actual type
// from magic bytes rather than trusting this, but the eval harness only has a filename to go on.
function mimeTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

interface ExpectedEntry {
  file: string;
  application: unknown;
  expected: { overall: Overall; violation: { field: string; verdictOneOf: Verdict[] } | null };
  /** Real photo or degraded capture: a present field may legitimately resolve to NEEDS_CORRECTION
   *  instead of COMPLIANT (low OCR confidence, or genuinely absent from this particular image)
   *  without that being a scoring error. Never set on the synthetic default set. */
  tolerant?: boolean;
  /** Adversarial set only: the clean control twin this injected sample is compared against.
   *  null on a control itself. */
  pairedWith?: string | null;
}

interface BatchExpectedRow {
  filename: string;
  overall: Overall;
  violation: { field: string; verdictOneOf: Verdict[] } | null;
  /** The row must fail BEFORE producing a verdict — e.g. its image file is absent. Without this
   *  flag an exception is always a scoring error, so a crash can never be mistaken for a correct
   *  REJECTED. */
  expectError?: boolean;
}

interface BatchExpectedEntry {
  csv: string;
  images: string[];
  expected: {
    overall: Overall;
    /** How many rows the CSV must parse to. Asserted, so a fixture that parses to nothing (an
     *  empty CSV, a rejected header) is a checked outcome rather than a silently skipped one. */
    parsedRows: number;
    /** Substrings that must appear in the parse errors, one per expected error. Asserted exactly:
     *  the count must match too, so "some error happened" can never stand in for "the RIGHT error
     *  happened". */
    parseErrors?: string[];
    rows: BatchExpectedRow[];
  };
  tags: string[];
}

const MATCHED_APP_FIELDS = [
  "brandName",
  "classType",
  "alcoholContent",
  "netContents",
  "nameAndAddress",
  "countryOfOrigin",
] as const;

const SETS: Record<string, string> = {
  default: path.join("eval", "expected.json"),
  "real-world": path.join("eval", "expected-real-world.json"),
  adversarial: path.join("eval", "expected-adversarial.json"),
  batch: path.join("eval", "expected-batch.json"),
};

/** Spec §10 "expected per-field verdicts": every field the matcher compares defaults to COMPLIANT
 *  (or COMPLIANT-or-NEEDS_CORRECTION for a tolerant entry); the planted violation overrides its own
 *  field. Note: this only gates pass/fail (a tolerant entry's NEEDS_CORRECTION doesn't fail the
 *  run) — the separate compliant/needsCorrection/nonCompliant counters in the caller decide what
 *  counts toward the headline compliance metric. */
function expectedFieldVerdicts(entry: ExpectedEntry, app: ApplicationData): Record<string, Verdict[]> {
  const base: Verdict[] = entry.tolerant ? ["COMPLIANT", "NEEDS_CORRECTION"] : ["COMPLIANT"];
  const expected: Record<string, Verdict[]> = { healthWarningStatement: base };
  for (const field of MATCHED_APP_FIELDS) if (app[field]) expected[field] = base;
  const violation = entry.expected.violation;
  if (violation) expected[violation.field] = violation.verdictOneOf;
  return expected;
}

async function runBatchEval(
  provider: VisionProvider | EscalatingProvider,
  entries: BatchExpectedEntry[],
  tags?: string[],
) {
  const { parseApplicationsCsv } = await import("@/lib/csv");
  const filtered = tags ? entries.filter((e) => e.tags.some((t) => tags.includes(t))) : entries;

  let compliant = 0;
  let total = 0;
  let unexpectedErrors = 0;

  // Every assertion goes through here, so a fixture can never contribute zero checks. An entry that
  // parses to no rows still records its parse-shape and batch-overall checks; previously a
  // header-only CSV produced no output and no score at all.
  const check = (ok: boolean, label: string) => {
    total++;
    if (ok) compliant++;
    console.log(`${ok ? "✓" : "✗"} ${label}`);
  };

  for (const entry of filtered) {
    const csvPath = path.join("eval", "fixtures", "batch", entry.csv);
    let csvText: string;
    try {
      csvText = await readFile(csvPath, "utf8");
    } catch {
      check(false, `${entry.csv} → CSV fixture not found at ${csvPath}`);
      continue;
    }

    const { rows, errors } = parseApplicationsCsv(csvText);
    const wantErrors = entry.expected.parseErrors ?? [];
    // Matched in BOTH directions. Checking only "each expected substring appears somewhere" leaves a
    // hole: two expectations can match the same error while a third error goes entirely unvalidated,
    // and the count check alone would not notice.
    const missingErrors = wantErrors.filter((want) => !errors.some((e) => e.includes(want)));
    const unexpectedParseErrors = errors.filter((e) => !wantErrors.some((want) => e.includes(want)));
    const parseOk =
      rows.length === entry.expected.parsedRows &&
      errors.length === wantErrors.length &&
      missingErrors.length === 0 &&
      unexpectedParseErrors.length === 0;
    check(
      parseOk,
      `${entry.csv} → parsed ${rows.length} row(s), ${errors.length} error(s)` +
        ` (expected ${entry.expected.parsedRows} row(s), ${wantErrors.length} error(s))` +
        (missingErrors.length ? ` · missing expected error(s): ${missingErrors.join("; ")}` : "") +
        (unexpectedParseErrors.length ? ` · unexpected error(s): ${unexpectedParseErrors.join(" | ")}` : ""),
    );

    // Expectations are matched to parsed rows BY INDEX, and the counts must agree. Matching by
    // filename let a parsed row with no expectation be skipped silently, so a fixture could gain or
    // lose rows without any check noticing.
    check(
      rows.length === entry.expected.rows.length,
      `${entry.csv} → ${rows.length} parsed row(s) vs ${entry.expected.rows.length} expectation(s)`,
    );

    let anyRowRejected = false;
    let anyRowNeedsCorrection = false;
    for (let i = 0; i < Math.min(rows.length, entry.expected.rows.length); i++) {
      const row = rows[i];
      const want = entry.expected.rows[i];
      check(row.filename === want.filename, `${entry.csv}[${i}] → ${row.filename} (expected ${want.filename})`);

      let actual: Overall | "ERROR";
      let detail = "";
      try {
        const image = await readFile(path.join("eval", "samples", row.filename));
        const meta = { filename: row.filename, mimeType: mimeTypeFor(row.filename) };
        let extracted;
        if ("extractWithTrace" in provider) {
          const outcome = await (provider as EscalatingProvider).extractWithTrace(image, meta);
          extracted = outcome.label;
        } else {
          extracted = await provider.extract(image, meta);
        }
        const app = ApplicationDataSchema.parse(row.application);
        const result = verifyLabel(app, extracted);
        actual = result.overall;
        // The planted violation must be caught on its OWN field. `violation` was present in the
        // expectations all along but never read, so a row could report the right overall verdict for
        // entirely the wrong reason.
        if (want.violation) {
          const field = result.fields.find((f) => f.field === want.violation!.field);
          const caught = !!field && want.violation.verdictOneOf.includes(field.verdict);
          check(
            caught,
            `${entry.csv}:${row.filename} → violation(${want.violation.field}) ` +
              (caught ? "CAUGHT" : `MISSED (got ${field ? field.verdict : "no such field"})`),
          );
        }
      } catch (e) {
        actual = "ERROR";
        detail = e instanceof Error ? e.message : String(e);
        if (!want.expectError) unexpectedErrors++;
      }

      // An exception is correct ONLY for a row that declares expectError. Previously any thrown
      // error scored as a correct REJECTED whenever the row expected REJECTED, so a crash earned a point —
      // the opposite of fail-closed.
      const ok = want.expectError ? actual === "ERROR" : actual === want.overall;
      if (actual === "REJECTED" || actual === "ERROR") anyRowRejected = true;
      else if (actual === "NEEDS_CORRECTION") anyRowNeedsCorrection = true;
      check(
        ok,
        `${entry.csv}:${row.filename} → ${actual}${detail ? ` (${detail})` : ""}` +
          ` (expected ${want.expectError ? "ERROR" : want.overall})`,
      );
    }

    // Batch overall mirrors the label precedence: REJECTED iff the CSV failed to parse or any row
    // was REJECTED/errored, else NEEDS_CORRECTION iff any row needs correction, else APPROVED.
    // (Previously this collapsed to two states, making a NEEDS_CORRECTION expectation unsatisfiable.)
    const actualOverall: Overall =
      errors.length > 0 || anyRowRejected ? "REJECTED" : anyRowNeedsCorrection ? "NEEDS_CORRECTION" : "APPROVED";
    check(
      actualOverall === entry.expected.overall,
      `${entry.csv} → batch overall ${actualOverall} (expected ${entry.expected.overall})`,
    );
  }

  const pct = total === 0 ? 0 : Math.round((compliant / total) * 100);
  console.log(`\nbatch results: ${compliant}/${total} checks (${pct}%)`);
  if (unexpectedErrors > 0) console.log(`unexpected extraction errors: ${unexpectedErrors}`);
  console.log(
    "Scope: this set measures CSV parsing and matcher accuracy over batch-shaped inputs. It does\n" +
      "NOT exercise POST /api/batch — its multipart parsing, per-image guards, concurrency pool and\n" +
      "result ordering are covered by app/api/batch/route.test.ts.",
  );

  return { compliant, total, unexpectedErrors };
}

async function main() {
  const flagIndex = process.argv.indexOf("--provider");
  const providerName = flagIndex >= 0 ? process.argv[flagIndex + 1] : "mock";
  const baseProvider = providerByName(providerName);

  // OFF by default, tracking the app's own default (route.ts: the ladder became opt-in after it
  // measured ~75% more latency and ~55% more model calls for a null accuracy gain). Leaving this ON
  // while the app ships it OFF would mean the recorded accuracy described a pipeline nobody runs.
  // `--escalate` measures the ladder; `--no-escalate` remains valid as an explicit off.
  const escalation = process.argv.includes("--escalate");
  const provider: VisionProvider | EscalatingProvider = escalation ? withEscalation(baseProvider) : baseProvider;

  const setIndex = process.argv.indexOf("--set");
  const setName = setIndex >= 0 ? process.argv[setIndex + 1] : "default";
  const setPath = SETS[setName];
  if (!setPath) {
    console.error(`Unknown --set "${setName}". Valid sets: ${Object.keys(SETS).join(", ")}`);
    process.exit(1);
    return;
  }
  if ((setName === "real-world" || setName === "adversarial") && provider.name === "mock") {
    console.error(
      `The "${setName}" set contains images the mock tier cannot read ` +
        "(it only recognizes bundled synthetic filenames via fixed fixtures). Re-run with " +
        "`--provider local-ocr` or a cloud provider.",
    );
    process.exit(1);
    return;
  }

  // Throttle between labels so cloud runs stay under free-tier rate caps
  // (e.g. Gemini free tier ~5 req/min → --delay 13000). Default 0: mock/local-ocr unaffected.
  const delayIndex = process.argv.indexOf("--delay");
  const delayMs = delayIndex >= 0 ? Number(process.argv[delayIndex + 1]) : 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Re-check a specific subset without re-spending cloud calls on entries that already passed —
  // e.g. after fixing a bug that only affected some files: `--only a.jpg,b.jpg`.
  const onlyIndex = process.argv.indexOf("--only");
  const onlyFiles = onlyIndex >= 0 ? new Set(process.argv[onlyIndex + 1].split(",")) : null;

  // D6a (2026-07-25 hardening): a non-tautological accuracy floor for CI. Unlike the mock-tier gate
  // (which only proves the matcher, since the mock tier's fixtures are fixed), this runs against any
  // set/provider — CI uses real-world/local-ocr, which is keyless and deterministic. Accepts both
  // "--min-overall 22" and "--min-overall=22": a gate that silently no-ops on a typo is worse than
  // no gate (NaN comparisons are always false, and an unmatched token is never detected at all).
  let minOverall: number | null = null;
  const minOverallToken = process.argv.find((a) => a === "--min-overall" || a.startsWith("--min-overall="));
  if (minOverallToken) {
    const raw = minOverallToken.includes("=")
      ? minOverallToken.slice(minOverallToken.indexOf("=") + 1)
      : process.argv[process.argv.indexOf(minOverallToken) + 1];
    minOverall = Number(raw);
    if (raw === undefined || raw === "" || !Number.isFinite(minOverall)) {
      console.error(`FAIL: --min-overall requires a numeric value, got "${raw}".`);
      process.exit(1);
    }
  }

  // Tag filter for batch set
  const tagIndex = process.argv.indexOf("--tags");
  const tags = tagIndex >= 0 ? process.argv[tagIndex + 1].split(",") : undefined;

  // Batch set dispatch
  if (setName === "batch") {
    const batchEntries: BatchExpectedEntry[] = JSON.parse(await readFile(setPath, "utf8"));
    const batchResult = await runBatchEval(provider, batchEntries, tags);
    // Record batch run. NOTE: overallCompliant means something different here than in the
    // default/real-world/adversarial sets above — `batchResult.compliant` is a count of generic
    // assertion passes (CSV parse shape, row-count, per-row verdict, batch-overall), not a count of
    // "the label was compliant". It shares the field name because both are "count of checks that
    // passed" at the history-schema level, but don't diff the two set's overallCompliant numbers
    // against each other and expect them to mean the same thing.
    const summary: RunSummary = {
      provider: provider.name,
      set: "batch",
      entries: batchResult.total,
      overallCompliant: batchResult.compliant,
      overallTotal: batchResult.total,
      perField: {},
      violationsCaught: 0,
      violationsTotal: 0,
      extractionErrors: batchResult.unexpectedErrors,
      escalation,
      extraCalls: 0,
    };
    await recordRun({ summary, details: [] });
    // Zero checks is a failure, not a vacuous pass — it means every entry was filtered out (or the
    // set is empty), so the run proved nothing.
    process.exit(batchResult.total === 0 || batchResult.compliant < batchResult.total ? 1 : 0);
  }

  const allEntries: ExpectedEntry[] = JSON.parse(await readFile(setPath, "utf8"));
  const entries = onlyFiles ? allEntries.filter((e) => onlyFiles.has(e.file)) : allEntries;
  // Adversarial set: injected sample -> its clean control twin, for the differential gate below.
  const pairs: Record<string, string> = {};
  for (const e of entries) if (e.pairedWith) pairs[e.file] = e.pairedWith;
  let overallCompliant = 0;
  let violationsCaught = 0;
  let violationsTotal = 0;
  let extractionErrors = 0;
  let extraCalls = 0;
  // Pass/fail gate, independent of the strict compliant/needsCorrection/nonCompliant breakdown below:
  // a field whose planted violation expects NEEDS_CORRECTION (e.g. "field missing from label") is
  // correctly scored (`ok`) without its verdict ever being COMPLIANT, so the mock-must-score-100%
  // gate has to key off `ok`, not off the headline compliance count.
  let fieldChecksFailed = 0;
  const fieldStats = new Map<
    string,
    { compliant: number; needsCorrection: number; nonCompliant: number; total: number }
  >();
  const details: DetailRow[] = [];
  // Plain real photos vs. deliberately-degraded (blur/skew/glare/lowres/combo) synthetic fixtures —
  // their pass rates move independently, so a blended overall number alone can hide whether a change
  // actually helped real-world photography vs. only the synthetic stress tests we generate ourselves.
  const bySubset = { real: { compliant: 0, total: 0 }, degraded: { compliant: 0, total: 0 } };

  for (const [index, entry] of entries.entries()) {
    if (delayMs > 0 && index > 0) await sleep(delayMs);
    const app = ApplicationDataSchema.parse(entry.application);
    const image = await readFile(path.join("eval", "samples", entry.file));
    // Counted here (before the extract/verify below can fail) so an extraction error still counts as
    // a miss in its subset's total, the same way it already counts as a miss in the overall percentage
    // (entries.length includes it, overallCompliant doesn't) — the two denominators stay comparable.
    const subset = entry.file.startsWith("degraded/") ? bySubset.degraded : bySubset.real;
    subset.total++;

    // Fail per item, not per batch (architecture rule 9) — a single flaky cloud extraction (e.g. the
    // model returning invalid JSON even after the adapter's own retry) must not abort the remaining
    // entries, the same way a single bad label never aborts a real batch run.
    let extracted;
    try {
      const meta = { filename: entry.file, mimeType: mimeTypeFor(entry.file) };
      // EscalatingProvider extends VisionProvider, so TS reduces the union and `in` alone can't
      // narrow — the cast is safe because the property's presence IS the discriminant.
      if ("extractWithTrace" in provider) {
        const outcome = await (provider as EscalatingProvider).extractWithTrace(image, meta);
        extracted = outcome.label;
        extraCalls += outcome.trace.extraCalls;
      } else {
        extracted = await provider.extract(image, meta);
      }
    } catch (e) {
      extractionErrors++;
      console.log(`✗ ${entry.file} → ERROR: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const result = verifyLabel(app, extracted);

    // A tolerant entry (real photo or degraded fixture) may legitimately resolve to
    // NEEDS_CORRECTION overall — an unrelated field going unreadable, not a real miss — the same
    // leniency expectedFieldVerdicts already grants at the field level. This only widens an
    // expected APPROVED: an expected REJECTED still requires an exact match, since the label
    // precedence (REJECTED > NEEDS_CORRECTION > APPROVED) means a genuine planted violation
    // reaches REJECTED regardless of what any tolerant field does, so there is nothing to widen.
    const tolerantOverallOk =
      entry.tolerant === true && entry.expected.overall === "APPROVED" && result.overall === "NEEDS_CORRECTION";
    const overallOk = result.overall === entry.expected.overall || tolerantOverallOk;
    if (overallOk) overallCompliant++;
    if (overallOk) subset.compliant++;
    details.push({
      file: entry.file,
      field: "__overall__",
      actual: result.overall,
      expectedOneOf: tolerantOverallOk ? [entry.expected.overall, "NEEDS_CORRECTION"] : [entry.expected.overall],
      ok: overallOk,
      extractedValue: null,
      appValue: null,
    });

    for (const [field, accepted] of Object.entries(expectedFieldVerdicts(entry, app))) {
      const stats = fieldStats.get(field) ?? { compliant: 0, needsCorrection: 0, nonCompliant: 0, total: 0 };
      stats.total++;
      const row = result.fields.find((f) => f.field === field);
      // `ok` is the pass/fail gate (a tolerant entry accepts NEEDS_CORRECTION so it doesn't fail the
      // run); the compliant/needsCorrection/nonCompliant split below is the headline metric, and only
      // a true COMPLIANT verdict counts toward it — NEEDS_CORRECTION must never inflate compliance
      // just because it happened not to fail the run.
      const ok = row !== undefined && accepted.includes(row.verdict);
      if (!ok) fieldChecksFailed++;
      stats[classifyFieldVerdict(row?.verdict ?? "NEEDS_CORRECTION")]++;
      fieldStats.set(field, stats);
      details.push({
        file: entry.file,
        field,
        actual: row?.verdict ?? "no row",
        expectedOneOf: accepted,
        ok,
        extractedValue: row?.labelValue ?? null,
        appValue: row?.applicationValue ?? null,
      });
    }

    const violation = entry.expected.violation;
    let violationNote = "";
    if (violation) {
      violationsTotal++;
      const row = result.fields.find((f) => f.field === violation.field);
      const caught = row !== undefined && violation.verdictOneOf.includes(row.verdict);
      if (caught) violationsCaught++;
      violationNote = ` · violation(${violation.field}): ${caught ? "CAUGHT" : `MISSED (got ${row?.verdict ?? "no row"})`}`;
      details.push({
        file: entry.file,
        field: "__violation__",
        actual: row?.verdict ?? "no row",
        expectedOneOf: violation.verdictOneOf,
        ok: caught,
        extractedValue: row?.labelValue ?? null,
        appValue: row?.applicationValue ?? null,
      });
    }
    console.log(
      `${overallOk ? "✓" : "✗"} ${entry.file} → ${result.overall} (expected ${entry.expected.overall})` +
        `${tolerantOverallOk ? " [tolerant: NEEDS_CORRECTION accepted]" : ""}${violationNote}`,
    );
  }

  const overallPct = entries.length === 0 ? 100 : Math.round((overallCompliant / entries.length) * 100);
  const violationPct = formatRatioPct(violationsCaught, violationsTotal);
  console.log(`\nprovider: ${provider.name}`);
  console.log(`set: ${setName} (${entries.length} entries)`);
  const perField = [...fieldStats.entries()].map(([f, st]) => `${f} ${st.compliant}/${st.total}`).join(" · ");
  // Aggregated across all fields: how many of the field-level checks landed on NEEDS_CORRECTION
  // rather than a true COMPLIANT — reported separately so a tolerant entry's "verify by eye" rows
  // stay visible instead of disappearing into the headline compliance percentage.
  const { needsCorrection, total: totalFieldChecks } = [...fieldStats.values()].reduce(
    (sum, st) => ({ needsCorrection: sum.needsCorrection + st.needsCorrection, total: sum.total + st.total }),
    { needsCorrection: 0, total: 0 },
  );
  const needsCorrectionPct = totalFieldChecks === 0 ? 0 : Math.round((needsCorrection / totalFieldChecks) * 100);
  // Named "disposition agreement" rather than "compliance": this counts the run's overall verdict
  // (APPROVED/NEEDS_CORRECTION/REJECTED) matching ground truth, so a correctly-caught REJECTED
  // increments it same as a correct APPROVED — it is not a count of compliant labels. The
  // per-field "compliant" bucket below is the one that means what its name says.
  console.log(`overall disposition agreement: ${overallCompliant}/${entries.length} (${overallPct}%)`);
  console.log(`per-field compliance: ${perField}`);
  console.log(`fields needing correction: ${needsCorrection}/${totalFieldChecks} (${needsCorrectionPct}%)`);
  console.log(`planted violations caught: ${violationsCaught}/${violationsTotal} (${violationPct})`);
  if (extractionErrors > 0) console.log(`extraction errors: ${extractionErrors}/${entries.length}`);
  console.log(`escalation: ${escalation ? `on · extra extraction calls: ${extraCalls}` : "off"}`);
  if (bySubset.degraded.total > 0) {
    const realPct = bySubset.real.total === 0 ? 100 : Math.round((bySubset.real.compliant / bySubset.real.total) * 100);
    const degradedPct = Math.round((bySubset.degraded.compliant / bySubset.degraded.total) * 100);
    console.log(
      `split: real photos ${bySubset.real.compliant}/${bySubset.real.total} (${realPct}%) · ` +
        `degraded fixtures ${bySubset.degraded.compliant}/${bySubset.degraded.total} (${degradedPct}%)`,
    );
  }

  const summary: RunSummary = {
    provider: provider.name,
    set: setName,
    entries: entries.length,
    overallCompliant,
    overallTotal: entries.length,
    perField: Object.fromEntries(fieldStats),
    violationsCaught,
    violationsTotal,
    extractionErrors,
    needsCorrection,
    escalation,
    extraCalls,
    ...(onlyFiles ? { subset: true } : {}),
    ...(bySubset.degraded.total > 0 ? { bySubset } : {}),
  };
  await recordRun({ summary, details });

  if (minOverall !== null && overallCompliant < minOverall) {
    console.error(`
FAIL: overall compliant ${overallCompliant}/${entries.length} is below --min-overall ${minOverall}.`);
    process.exit(1);
  }

  if (
    setName === "default" &&
    provider.name === "mock" &&
    (overallCompliant < entries.length || violationsCaught < violationsTotal || fieldChecksFailed > 0)
  ) {
    console.error("\nFAIL: the mock tier must score 100% — a matcher regression.");
    process.exit(1);
  }

  // Security gate (spec §5.2): differential and one-directional. Unlike the accuracy sets, this is
  // a hard binary gate — a planted injection moving any verdict toward passing fails the run.
  if (setName === "adversarial") {
    // A misconfigured --only filter (or a broken expected-set file) that selects zero comparable
    // pairs must not report APPROVED: an empty gate proves nothing, and CI keys on exit code, not the
    // printed count. A legitimate full adversarial run always has pairs, so this never fires there.
    if (Object.keys(pairs).length === 0) {
      console.error(
        "\nFAIL: adversarial run compared 0 injection pairs — check the --only filter or the expected set.",
      );
      process.exit(1);
    }
    const gate = checkInjectionGate(details, pairs);
    for (const drift of gate.safeDrift) console.log(`  ~ ${drift}`);
    if (gate.violations.length > 0) {
      console.error("\nFAIL: a planted injection moved a verdict toward passing:");
      for (const v of gate.violations) console.error(`  ✗ ${v}`);
      process.exit(1);
    }
    console.log(`\nPASS: ${Object.keys(pairs).length} planted injections altered no verdict toward passing.`);
  }
  process.exit(0); // terminate lingering tesseract worker threads (local-ocr keeps the event loop alive)
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
