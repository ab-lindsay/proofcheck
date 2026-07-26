# Eval Run-History Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `pnpm eval` / `pnpm eval:real-world` run automatically persist a summary to a
committed history log and a per-item detail snapshot to a gitignored file, plus add a
`pnpm eval:history` command to read the log back as a table — so accuracy improvement (or
regression) across sessions is measured from data, not from re-reading commit message prose.

**Architecture:** One new pure-function module (`eval/record-run.ts`) does the two file writes and
degrades gracefully if git metadata is unavailable. `eval/run.ts` is extended (additively — console
output unchanged) to collect a per-item detail array and call `recordRun()` once, right before it
exits. A second new pure-function module (`eval/print-history.ts`) parses/filters/formats the log
for the new `pnpm eval:history` command. No existing extraction, matching, or app code is touched.

**Tech Stack:** TypeScript, Node.js `fs/promises` + `child_process`, Vitest, `tsx`. No new
dependencies.

## Global Constraints

- No changes to `lib/vision/*`, `lib/matching/*`, `lib/ttb/*`, `app/**`, `eval/expected.json`,
  `eval/expected-real-world.json` (spec File inventory — "Unchanged").
- Console output of `pnpm eval` / `pnpm eval:real-world` must be byte-identical to today's — this
  is purely additive observability (spec Goals: "Zero changes to ... existing eval console output").
- `eval/history.jsonl` is committed to git; `eval/.results/` is gitignored (spec Design — File
  formats and locations).
- `recordRun()` must accept optional path overrides so unit tests never touch the real, committed
  `eval/history.jsonl` (spec Design — `eval/record-run.ts (new)`, added during spec self-review).
- `provider` in every recorded record is the actual provider name (`mock` | `local-ocr` | `gemini` |
  `claude` | `openai`), never a generic "cloud" bucket (spec Design — File formats and locations).
- Git metadata lookups (`gitSha`, `dirty`) must degrade to `null` on failure, never throw or crash
  an eval run (spec Design — `eval/record-run.ts (new)`).
- No new CI gate on real-world numbers; the existing mock/default 100% gate in `eval/run.ts` is
  untouched (spec Non-goals).
- Full spec: `docs/superpowers/specs/2026-07-23-eval-run-history-design.md`.

---

### Task 1: `eval/record-run.ts` — the persistence module

**Files:**

- Create: `eval/record-run.ts`
- Test: `eval/record-run.test.ts`
- Modify: `vitest.config.ts` (add `eval/**/*.test.ts` to `test.include` — without this, the new test
  file above silently never runs under `pnpm test`)
- Modify: `.gitignore` (add `/eval/.results/`)

**Interfaces:**

- Produces: `recordRun(runData: RunRecord, paths?: RecordPaths): Promise<void>`; types
  `FieldStat { correct: number; total: number }`, `RunSummary { provider: string; set: string;
entries: number; overallCorrect: number; overallTotal: number; perField: Record<string,
FieldStat>; violationsCaught: number; violationsTotal: number; extractionErrors: number }`,
  `DetailRow { file: string; field: string; actual: string; expectedOneOf: string[]; ok: boolean;
extractedValue: string | null; appValue: string | null }`, `RunRecord { summary: RunSummary;
details: DetailRow[] }`, `RecordPaths { historyPath?: string; resultsDir?: string }` — all
  consumed by Task 2 (`eval/run.ts`) and re-exported implicitly for Task 2's own type usage.

- [ ] **Step 1: Add the eval test glob to vitest config**

In `vitest.config.ts`, find the `include` array inside `test`:

```ts
    include: ["lib/**/*.test.{ts,tsx}", "components/**/*.test.tsx", "hooks/**/*.test.ts", "app/**/*.test.{ts,tsx}"],
```

Change it to:

```ts
    include: [
      "lib/**/*.test.{ts,tsx}",
      "components/**/*.test.tsx",
      "hooks/**/*.test.ts",
      "app/**/*.test.{ts,tsx}",
      "eval/**/*.test.ts",
    ],
```

- [ ] **Step 2: Add the gitignore entry**

In `.gitignore`, find the "Playwright MCP / local verification artifacts" section:

```
# Playwright MCP / local verification artifacts
.playwright-mcp/
```

Change it to:

```
# Playwright MCP / local verification artifacts
.playwright-mcp/
/eval/.results/
```

- [ ] **Step 3: Write the failing tests**

Create `eval/record-run.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordRun, type RunRecord } from "@/eval/record-run";

const SAMPLE_RECORD: RunRecord = {
  summary: {
    provider: "mock",
    set: "default",
    entries: 13,
    overallCorrect: 13,
    overallTotal: 13,
    perField: { brandName: { correct: 13, total: 13 } },
    violationsCaught: 8,
    violationsTotal: 8,
    extractionErrors: 0,
  },
  details: [
    {
      file: "old-tom-clean.png",
      field: "brandName",
      actual: "MATCH",
      expectedOneOf: ["MATCH"],
      ok: true,
      extractedValue: "OLD TOM DISTILLERY",
      appValue: "OLD TOM DISTILLERY",
    },
  ],
};

describe("recordRun", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("appends a well-formed line to the history file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");

    await recordRun(SAMPLE_RECORD, { historyPath, resultsDir });

    const raw = await readFile(historyPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.provider).toBe("mock");
    expect(parsed.set).toBe("default");
    expect(parsed.overallCorrect).toBe(13);
    expect(parsed.perField.brandName).toEqual({ correct: 13, total: 13 });
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("appends a second line rather than overwriting on a second call", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");

    await recordRun(SAMPLE_RECORD, { historyPath, resultsDir });
    await recordRun(SAMPLE_RECORD, { historyPath, resultsDir });

    const raw = await readFile(historyPath, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  it("overwrites (not appends) the per-(set, provider) detail file on a second call", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");

    await recordRun(SAMPLE_RECORD, { historyPath, resultsDir });
    const secondRecord: RunRecord = {
      ...SAMPLE_RECORD,
      details: [{ ...SAMPLE_RECORD.details[0], actual: "MISMATCH", ok: false }],
    };
    await recordRun(secondRecord, { historyPath, resultsDir });

    const detailPath = path.join(resultsDir, "default-mock.json");
    const parsed = JSON.parse(await readFile(detailPath, "utf8"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].actual).toBe("MISMATCH");
  });

  it("degrades to null gitSha/dirty instead of throwing when git commands fail", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");

    // os.tmpdir() itself is never a git repo, so running from there makes `git rev-parse HEAD` fail.
    const cwdBefore = process.cwd();
    process.chdir(tmpdir());
    try {
      await recordRun(SAMPLE_RECORD, { historyPath, resultsDir });
    } finally {
      process.chdir(cwdBefore);
    }

    const raw = await readFile(historyPath, "utf8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed.gitSha).toBeNull();
    expect(parsed.dirty).toBeNull();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm vitest run eval/record-run.test.ts`
Expected: FAIL — `Cannot find module './record-run'` (the module doesn't exist yet).

- [ ] **Step 5: Implement `eval/record-run.ts`**

```ts
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";

export interface FieldStat {
  correct: number;
  total: number;
}

export interface RunSummary {
  provider: string;
  set: string;
  entries: number;
  overallCorrect: number;
  overallTotal: number;
  perField: Record<string, FieldStat>;
  violationsCaught: number;
  violationsTotal: number;
  extractionErrors: number;
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
  const detailPath = path.join(resultsDir, `${runData.summary.set}-${runData.summary.provider}.json`);
  await writeFile(detailPath, JSON.stringify(runData.details, null, 2), "utf8");
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run eval/record-run.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts .gitignore eval/record-run.ts eval/record-run.test.ts
git commit -m "Add eval/record-run.ts for persisting eval run history"
```

---

### Task 2: Wire `recordRun` into `eval/run.ts`

**Files:**

- Modify: `eval/run.ts`

**Interfaces:**

- Consumes: `recordRun(runData: RunRecord, paths?: RecordPaths): Promise<void>`, `DetailRow`,
  `RunSummary`, `RunRecord` from `./record-run` (Task 1).
- Produces: nothing new for other tasks — this is the integration point, exercised by running the
  script directly (verified in Step 3 below, not a unit test).

- [ ] **Step 1: Add the import**

In `eval/run.ts`, add to the top of the file (after the existing imports):

```ts
import { recordRun, type DetailRow, type RunSummary } from "@/eval/record-run";
```

- [ ] **Step 2: Collect per-item detail rows and call `recordRun`**

Replace the entire body of `main()` from `const entries: ExpectedEntry[] = ...` through the end of
the `for` loop with:

```ts
const entries: ExpectedEntry[] = JSON.parse(await readFile(setPath, "utf8"));
let overallCorrect = 0;
let violationsCaught = 0;
let violationsTotal = 0;
let extractionErrors = 0;
const fieldStats = new Map<string, { correct: number; total: number }>();
const details: DetailRow[] = [];

for (const [index, entry] of entries.entries()) {
  if (delayMs > 0 && index > 0) await sleep(delayMs);
  const app = ApplicationDataSchema.parse(entry.application);
  const image = await readFile(path.join("eval", "samples", entry.file));

  // Fail per item, not per batch (architecture rule 9) — a single flaky cloud extraction (e.g. the
  // model returning invalid JSON even after the adapter's own retry) must not abort the remaining
  // entries, the same way a single bad label never aborts a real batch run.
  let extracted;
  try {
    extracted = await provider.extract(image, { filename: entry.file, mimeType: "image/png" });
  } catch (e) {
    extractionErrors++;
    console.log(`✗ ${entry.file} → ERROR: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  const result = verifyLabel(app, extracted);

  const overallOk = result.overall === entry.expected.overall;
  if (overallOk) overallCorrect++;
  details.push({
    file: entry.file,
    field: "__overall__",
    actual: result.overall,
    expectedOneOf: [entry.expected.overall],
    ok: overallOk,
    extractedValue: null,
    appValue: null,
  });

  for (const [field, accepted] of Object.entries(expectedFieldVerdicts(entry, app))) {
    const stats = fieldStats.get(field) ?? { correct: 0, total: 0 };
    stats.total++;
    const row = result.fields.find((f) => f.field === field);
    const ok = row !== undefined && accepted.includes(row.verdict);
    if (ok) stats.correct++;
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
    `${overallOk ? "✓" : "✗"} ${entry.file} → ${result.overall} (expected ${entry.expected.overall})${violationNote}`,
  );
}
```

This is a straight refactor of the existing loop body: the console-output logic and accuracy
counters are byte-for-byte the same, with a `details.push(...)` call added at each of the three
places a verdict is already being computed (overall, per-field, violation).

- [ ] **Step 3: Build the summary and call `recordRun` before the exit gate**

Immediately after the existing block that prints the summary (`console.log(\`overall verdict
accuracy: ...\`)`etc.) and before the`if (setName === "default" && ...)` gate check, insert:

```ts
const summary: RunSummary = {
  provider: provider.name,
  set: setName,
  entries: entries.length,
  overallCorrect,
  overallTotal: entries.length,
  perField: Object.fromEntries(fieldStats),
  violationsCaught,
  violationsTotal,
  extractionErrors,
};
await recordRun({ summary, details });
```

Placing this _before_ the gate check (not after) matters: the gate check can `process.exit(1)` on a
mock-tier regression, and a regression is exactly the kind of run that should still get recorded.

The full end of `main()` should now read (for reference — nothing below this point changes):

```ts
if (
  setName === "default" &&
  provider.name === "mock" &&
  (overallCorrect < entries.length || violationsCaught < violationsTotal || !fieldsPerfect)
) {
  console.error("\nFAIL: the mock tier must score 100% — a matcher regression.");
  process.exit(1);
}
process.exit(0); // terminate lingering tesseract worker threads (local-ocr keeps the event loop alive)
```

- [ ] **Step 4: Verify the console output is unchanged and history is written**

Run: `pnpm eval`
Expected: identical console output to before this task (13/13, 100%, 8/8 violations), exit code 0.

Then check the new files:

Run: `cat eval/history.jsonl` (or open it) — expect the file to exist with exactly one JSON line,
`"provider":"mock"`, `"set":"default"`, `"overallCorrect":13`.

Run: `cat eval/.results/default-mock.json` — expect a JSON array of detail rows, one entry per
field per eval item (plus `__overall__` and `__violation__` rows).

Run: `git status --short` — expect `eval/.results/` to **not** appear (gitignored by Task 1's
`.gitignore` change); expect `eval/history.jsonl` to appear as an untracked file (not yet committed
— that happens in Task 4, after the reader in Task 3 exists to verify it end-to-end).

- [ ] **Step 5: Run the full unit suite to confirm no regression**

Run: `pnpm test`
Expected: all green, including the 4 tests from Task 1.

- [ ] **Step 6: Commit**

```bash
git add eval/run.ts
git commit -m "Persist eval run summaries and per-item detail via recordRun"
```

(Do not `git add eval/history.jsonl` or `eval/.results/` here — see Step 4 above.)

---

### Task 3: `eval/print-history.ts` and the `pnpm eval:history` command

**Files:**

- Create: `eval/print-history.ts`
- Test: `eval/print-history.test.ts`
- Modify: `package.json` (new `eval:history` script)

**Interfaces:**

- Consumes: nothing from other tasks (reads `eval/history.jsonl` produced by Task 2 at runtime, but
  has no compile-time dependency on `record-run.ts`).
- Produces: `parseHistory(raw: string): HistoryEntry[]`, `filterHistory(entries: HistoryEntry[],
filters: { set?: string; provider?: string }): HistoryEntry[]`, `formatHistoryTable(entries:
HistoryEntry[], limit: number): string`, type `HistoryEntry` — none consumed by other tasks in
  this plan; exported for testability only.

- [ ] **Step 1: Write the failing tests**

Create `eval/print-history.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseHistory, filterHistory, formatHistoryTable, type HistoryEntry } from "@/eval/print-history";

const ENTRY_A: HistoryEntry = {
  timestamp: "2026-07-23T10:00:00.000Z",
  gitSha: "abc1234567",
  dirty: false,
  provider: "mock",
  set: "default",
  entries: 13,
  overallCorrect: 13,
  overallTotal: 13,
  perField: { brandName: { correct: 13, total: 13 } },
  violationsCaught: 8,
  violationsTotal: 8,
  extractionErrors: 0,
};

const ENTRY_B: HistoryEntry = {
  ...ENTRY_A,
  timestamp: "2026-07-23T11:00:00.000Z",
  provider: "local-ocr",
  set: "real-world",
  overallCorrect: 16,
  overallTotal: 46,
  dirty: true,
};

describe("parseHistory", () => {
  it("parses one JSON object per non-empty line", () => {
    const raw = `${JSON.stringify(ENTRY_A)}\n${JSON.stringify(ENTRY_B)}\n`;
    expect(parseHistory(raw)).toEqual([ENTRY_A, ENTRY_B]);
  });

  it("ignores blank lines", () => {
    const raw = `${JSON.stringify(ENTRY_A)}\n\n\n${JSON.stringify(ENTRY_B)}\n`;
    expect(parseHistory(raw)).toEqual([ENTRY_A, ENTRY_B]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseHistory("")).toEqual([]);
  });
});

describe("filterHistory", () => {
  const all = [ENTRY_A, ENTRY_B];

  it("returns everything when no filters are given", () => {
    expect(filterHistory(all, {})).toEqual(all);
  });

  it("filters by set", () => {
    expect(filterHistory(all, { set: "real-world" })).toEqual([ENTRY_B]);
  });

  it("filters by provider", () => {
    expect(filterHistory(all, { provider: "mock" })).toEqual([ENTRY_A]);
  });

  it("filters by both set and provider together", () => {
    expect(filterHistory(all, { set: "real-world", provider: "local-ocr" })).toEqual([ENTRY_B]);
    expect(filterHistory(all, { set: "real-world", provider: "mock" })).toEqual([]);
  });
});

describe("formatHistoryTable", () => {
  it("returns a placeholder message for no entries", () => {
    expect(formatHistoryTable([], 20)).toBe("No matching history entries found.");
  });

  it("includes provider, set, overall accuracy, and per-field stats", () => {
    const table = formatHistoryTable([ENTRY_A], 20);
    expect(table).toContain("mock/default");
    expect(table).toContain("overall 13/13 (100%)");
    expect(table).toContain("brandName 13/13");
  });

  it("marks a dirty working tree with a trailing asterisk on the short SHA", () => {
    const table = formatHistoryTable([ENTRY_B], 20);
    expect(table).toContain("abc1234*");
  });

  it("respects the limit by keeping only the most recent entries", () => {
    const table = formatHistoryTable([ENTRY_A, ENTRY_B], 1);
    expect(table).not.toContain("mock/default");
    expect(table).toContain("local-ocr/real-world");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run eval/print-history.test.ts`
Expected: FAIL — `Cannot find module './print-history'`.

- [ ] **Step 3: Implement `eval/print-history.ts`**

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface HistoryEntry {
  timestamp: string;
  gitSha: string | null;
  dirty: boolean | null;
  provider: string;
  set: string;
  entries: number;
  overallCorrect: number;
  overallTotal: number;
  perField: Record<string, { correct: number; total: number }>;
  violationsCaught: number;
  violationsTotal: number;
  extractionErrors: number;
}

export function parseHistory(raw: string): HistoryEntry[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HistoryEntry);
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
      const overallPct = e.overallTotal === 0 ? 100 : Math.round((e.overallCorrect / e.overallTotal) * 100);
      const violationPct = e.violationsTotal === 0 ? 100 : Math.round((e.violationsCaught / e.violationsTotal) * 100);
      const perField = Object.entries(e.perField)
        .map(([field, stat]) => `${field} ${stat.correct}/${stat.total}`)
        .join(" · ");
      return (
        `${e.timestamp}  ${sha}  ${e.provider}/${e.set}  ` +
        `overall ${e.overallCorrect}/${e.overallTotal} (${overallPct}%)  ` +
        `violations ${e.violationsCaught}/${e.violationsTotal} (${violationPct}%)\n  ${perField}`
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run eval/print-history.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Add the `pnpm eval:history` script**

In `package.json`, find:

```json
    "eval:real-world": "tsx eval/run.ts --set real-world --provider local-ocr",
```

Add immediately after it:

```json
    "eval:real-world": "tsx eval/run.ts --set real-world --provider local-ocr",
    "eval:history": "tsx eval/print-history.ts",
```

- [ ] **Step 6: Commit**

```bash
git add eval/print-history.ts eval/print-history.test.ts package.json
git commit -m "Add pnpm eval:history to read back recorded eval run history"
```

---

### Task 4: End-to-end verification and final commit

**Files:** `eval/history.jsonl` (committed for the first time; contains whatever real runs have
accumulated from Task 2's Step 4 plus this task's Step 1 below).

**Interfaces:** none.

- [ ] **Step 1: Full verification sweep**

Run in order, confirming each passes before moving to the next:

1. `pnpm test` — expect all green (including all 14 new eval tests across Tasks 1 and 3).
2. `pnpm typecheck` — expect clean (no config change needed; `tsconfig.json`'s `include` already
   covers `**/*.ts`, so `eval/record-run.ts` and `eval/print-history.ts` are picked up
   automatically).
3. `pnpm lint` — expect clean.
4. `pnpm eval` — expect `13/13 (100%)`, `8/8` violations, exit 0. Confirms `eval/history.jsonl` now
   has at least 2 lines (one from Task 2's Step 4, one from this run) and
   `eval/.results/default-mock.json` was overwritten (still 1 file, not 2 — same `(set, provider)`
   key).
5. `pnpm eval:real-world` — expect it to run to completion (this exercises `local-ocr`/tesseract
   against all real-world fixtures and takes noticeably longer than the mock run; that's expected,
   not a failure). Confirms `eval/history.jsonl` gains one more line with `"provider":"local-ocr"`,
   `"set":"real-world"`, and `eval/.results/real-world-local-ocr.json` is created.

- [ ] **Step 2: Verify the reader against real data**

Run: `pnpm eval:history`
Expected: prints every accumulated run (mock/default and local-ocr/real-world entries), most recent
last, each with a readable timestamp, short SHA, provider/set, overall accuracy, and per-field line.

Run: `pnpm eval:history --set real-world`
Expected: only the `local-ocr/real-world` line(s) print.

Run: `pnpm eval:history --provider mock`
Expected: only the `mock/default` line(s) print.

- [ ] **Step 3: Confirm gitignore is doing its job**

Run: `git status --short`
Expected: `eval/history.jsonl` listed as untracked (or modified, if Task 2's Step 4 run already
created it and this step's runs appended to it); `eval/.results/` does **not** appear anywhere in
the output.

- [ ] **Step 4: Commit the history log**

```bash
git add eval/history.jsonl
git commit -m "Record initial eval run history from local verification runs"
```

---

## Self-review notes (writing-plans skill)

- **Spec coverage:** Design → File formats (Task 1: `eval/history.jsonl` shape, `eval/.results/`
  shape), `eval/run.ts` changes (Task 2), `eval/record-run.ts` (Task 1), `eval/print-history.ts` →
  `pnpm eval:history` (Task 3), `package.json`/`.gitignore` (Tasks 1 & 3). Testing section → unit
  tests for `record-run.ts` (Task 1 Step 3, including the git-failure-degrades-gracefully case) and
  `print-history.ts` (Task 3 Step 1); manual verification of both `pnpm eval` and
  `pnpm eval:real-world`, confirming files created/gitignored correctly, confirming
  `pnpm eval:history` output (Task 4). File inventory → matches exactly (all "New" files created,
  all "Modified" files touched, all "Unchanged" files left alone). Non-goals → confirmed untouched
  (no new CI gate added, no diff/compare tool built, no rotation/pruning logic, no `app/` changes).
- **Placeholder scan:** none found — every step has literal, complete code or exact commands with
  stated expected output; no "TBD"/"similar to Task N"/"add error handling" placeholders.
- **Type consistency:** `RunRecord { summary: RunSummary; details: DetailRow[] }` and
  `RecordPaths { historyPath?; resultsDir? }` defined in Task 1, used identically in Task 2's
  `recordRun({ summary, details })` call (no `paths` argument passed, correctly relying on the
  function's own defaults) and in Task 1's own tests (with `paths` passed). `HistoryEntry` defined
  in Task 3, matches the shape `recordRun` (Task 1) actually writes (`timestamp`, `gitSha`, `dirty`
  spread first, then `...runData.summary`'s fields) field-for-field.
