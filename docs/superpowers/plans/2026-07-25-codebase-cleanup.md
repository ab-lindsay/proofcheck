# Codebase Cleanup Implementation Plan

> **Status: COMPLETE (2026-07-26).** All 13 tasks landed across commits `9e9c071`..`2d2b190` on
> `main` (no separate branch — see `.superpowers/sdd/2026-07-25-codebase-cleanup/progress.md` for
> the task-by-task ledger, deviations, and cross-session notes). Checkboxes below are marked done
> retroactively; they were not ticked live during execution.
>
> **Superseded while in flight:** Task 2's `overall: "APPROVED" | "REJECTED"` (2-way) below was the
> plan's original design. Before Task 8 finished, an unrelated concurrent session landed its own
> commits (`7e3df02`, `fc6dec0`) widening `overall` to a three-way
> `"APPROVED" | "NEEDS_CORRECTION" | "REJECTED"` — a genuine architecture change, not part of this
> plan, made for its own reason (invariant 7: a field needing correction was silently surfacing as
> APPROVED). Tasks 9-13 were built and verified against the 3-way codebase as it then stood. The
> 2-way type signatures quoted in Tasks 2 and 8 below are therefore historical — the current,
> canonical vocabulary (3-way `overall`) is documented in `CLAUDE.md` and `docs/ARCHITECTURE.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remove non-Bedrock cloud providers, rename verdicts to TTB-aligned vocabulary, fix the eval scoring bug, add rate limiting and openapi validation, and clean up dead specs/plans.

**Architecture:** Bedrock becomes the sole cloud provider. Verdicts rename from MATCH/MISMATCH/REVIEW to COMPLIANT/NON_COMPLIANT/NEEDS_CORRECTION. Eval scoring stops counting NEEDS_CORRECTION as correct. Rate limiting and openapi validation are added as standalone features.

**Tech Stack:** TypeScript, Next.js App Router, Zod, Vitest, Prettier

## Global Constraints

- Node 24 LTS
- pnpm package manager
- Vitest for tests
- Existing code conventions: no comments unless asked, follow existing patterns

---

## File Structure

### New files

- `lib/rate-limit.ts` — in-memory sliding window rate limiter
- `openapi.test.ts` — validates openapi.yaml against batch-schema.ts

### Modified files (provider cleanup)

- `lib/vision/select.ts` — remove 4 provider imports, simplify to Bedrock-only
- `lib/vision/cloud/bedrock.ts` — no changes needed (already works)
- `.env.example` — remove 8 env vars
- `hooks/use-dev-model.ts` — already Bedrock-only (no change needed)
- `package.json` — remove 3 SDK deps

### Deleted files (provider cleanup)

- `lib/vision/cloud/gemini.ts`
- `lib/vision/cloud/gemini.test.ts`
- `lib/vision/cloud/claude.ts`
- `lib/vision/cloud/claude.test.ts`
- `lib/vision/cloud/openai.ts`
- `lib/vision/cloud/openai.test.ts`
- `lib/vision/cloud/groq.ts`
- `lib/vision/cloud/groq.test.ts`

### Modified files (vocabulary rename)

- `lib/schema.ts` — rename Verdict type values, overall type
- `lib/batch-schema.ts` — rename Zod enums
- `lib/matching/fuzzy.ts` — rename return values
- `lib/matching/numeric.ts` — rename return values
- `lib/matching/warning.ts` — rename return values
- `lib/matching/verify.ts` — rename comparisons
- `lib/csv.ts` — rename filter
- `components/verdict-card.tsx` — rename comparisons
- `components/batch-table.tsx` — rename comparisons
- `components/field-row.tsx` — receives verdicts as props, type rename propagates automatically (no code changes needed)
- `app/api/batch/route.ts` — rename all error branches
- `app/api/verify/route.ts` — returns `result.overall` from verifyLabel(), type rename propagates automatically
- `eval/run.ts` — rename expected verdicts, scoring, output
- `eval/injection-gate.ts` — rename SEVERITY map keys
- `eval/compare-escalation.ts` — rename comparison
- `eval/record-run.ts` — rename `correct` to `compliant`
- `eval/print-history.ts` — rename `correct` to `compliant`
- `scripts/check-latency.ts` — rename return strings
- All test files (21 files)
- Both e2e spec files

### Modified files (eval scoring)

- `eval/run.ts` — change scoring logic to not count NEEDS_CORRECTION as correct

### Modified files (docs)

- `docs/ARCHITECTURE.md` — update provider section, vocabulary, status items
- `docs/superpowers/specs/2026-07-21-alcohol-label-verification-design.md` — update vocabulary
- `docs/deferred-items-and-tradeoffs-2026-07-25.md` — mark items as addressed

---

## Task 1: Remove non-Bedrock cloud providers

**Files:**

- Delete: `lib/vision/cloud/gemini.ts`, `gemini.test.ts`, `claude.ts`, `claude.test.ts`, `openai.ts`, `openai.test.ts`, `groq.ts`, `groq.test.ts`
- Modify: `lib/vision/select.ts`, `.env.example`, `package.json`

**Interfaces:**

- Consumes: nothing (first task)
- Produces: `selectCloudProvider()` returns Bedrock or null; `providerByName()` accepts `mock | local-ocr | local-llm | bedrock`

- [x] **Step 1: Delete the 4 non-Bedrock adapter files and their tests**

```bash
rm lib/vision/cloud/gemini.ts lib/vision/cloud/gemini.test.ts
rm lib/vision/cloud/claude.ts lib/vision/cloud/claude.test.ts
rm lib/vision/cloud/openai.ts lib/vision/cloud/openai.test.ts
rm lib/vision/cloud/groq.ts lib/vision/cloud/groq.test.ts
```

- [x] **Step 2: Remove SDK dependencies from package.json**

```bash
pnpm remove @google/generative-ai @anthropic-ai/sdk openai
```

- [x] **Step 3: Update select.ts — remove 4 imports and simplify**

Edit `lib/vision/select.ts`:

```ts
import type { VisionProvider } from "@/lib/vision/types";
import { isMockSample, mockProvider } from "@/lib/vision/mock";
import { localOcrProvider } from "@/lib/vision/local-ocr";
import { localLlmProvider } from "@/lib/vision/local-llm/ollama";
import { bedrockProvider } from "@/lib/vision/cloud/bedrock";

const PROVIDERS: Record<string, VisionProvider> = {
  mock: mockProvider,
  "local-ocr": localOcrProvider,
  "local-llm": localLlmProvider,
  bedrock: bedrockProvider,
};

export function providerByName(name: string): VisionProvider {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown VISION_PROVIDER "${name}" (expected mock | local-ocr | local-llm | bedrock)`);
  return provider;
}

export function selectCloudProvider(): VisionProvider | null {
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return bedrockProvider;
  return null;
}

export function selectProvider(filename?: string): VisionProvider {
  const forced = process.env.VISION_PROVIDER;
  if (forced) {
    if (forced === "mock" && process.env.NODE_ENV === "production") {
      throw new Error(
        "VISION_PROVIDER=mock is not allowed in production — the mock tier returns fabricated fixture data.",
      );
    }
    return providerByName(forced);
  }
  if (filename && isMockSample(filename)) return mockProvider;
  return selectCloudProvider() ?? localOcrProvider;
}
```

- [x] **Step 4: Update .env.example — remove non-Bedrock env vars**

Edit `.env.example` to remove lines 27-30 (GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY and their model overrides). Keep only the Bedrock entry.

- [x] **Step 5: Update VISION_PROVIDER comment in .env.example**

Change the VISION_PROVIDER comment from `mock | local-ocr | local-llm | gemini | claude | openai | groq | bedrock` to `mock | local-ocr | local-llm | bedrock`.

- [x] **Step 6: Run tests to verify nothing breaks**

```bash
pnpm test
```

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove non-Bedrock cloud providers (Gemini, Claude, OpenAI, Groq)"
```

---

## Task 2: Rename verdicts — type definitions and schemas

**Files:**

- Modify: `lib/schema.ts`, `lib/batch-schema.ts`

**Interfaces:**

- Consumes: nothing (foundation for all other tasks)
- Produces: `Verdict = "COMPLIANT" | "NON_COMPLIANT" | "NEEDS_CORRECTION"`, `overall: "APPROVED" | "REJECTED"`

- [x] **Step 1: Rename Verdict type in lib/schema.ts**

Change line 44:

```ts
export type Verdict = "COMPLIANT" | "NON_COMPLIANT" | "NEEDS_CORRECTION";
```

Change line 56:

```ts
overall: "APPROVED" | "REJECTED"; // REJECTED iff any field verdict is NON_COMPLIANT; NEEDS_CORRECTION never causes REJECTION
```

- [x] **Step 2: Rename Zod enums in lib/batch-schema.ts**

Change line 21:

```ts
overall: z.enum(["APPROVED", "REJECTED"]),
```

Change line 27:

```ts
verdict: z.enum(["COMPLIANT", "NON_COMPLIANT", "NEEDS_CORRECTION"]),
```

- [x] **Step 3: Run typecheck to verify schema changes compile**

```bash
pnpm typecheck
```

- [x] **Step 4: Commit**

```bash
git add lib/schema.ts lib/batch-schema.ts
git commit -m "refactor: rename Verdict type to TTB-aligned vocabulary"
```

---

## Task 3: Rename verdicts — matching logic

**Files:**

- Modify: `lib/matching/fuzzy.ts`, `lib/matching/numeric.ts`, `lib/matching/warning.ts`, `lib/matching/verify.ts`

**Interfaces:**

- Consumes: `Verdict` type from Task 2
- Produces: all matching functions return new verdict values

- [x] **Step 1: Rename verdicts in fuzzy.ts**

Use find-and-replace in `lib/matching/fuzzy.ts`:

- `"MATCH"` → `"COMPLIANT"`
- `"MISMATCH"` → `"NON_COMPLIANT"`
- `"REVIEW"` → `"NEEDS_CORRECTION"`

- [x] **Step 2: Rename verdicts in numeric.ts**

Use find-and-replace in `lib/matching/numeric.ts`:

- `"MATCH"` → `"COMPLIANT"`
- `"MISMATCH"` → `"NON_COMPLIANT"`
- `"REVIEW"` → `"NEEDS_CORRECTION"`

- [x] **Step 3: Rename verdicts in warning.ts**

Use find-and-replace in `lib/matching/warning.ts`:

- `"MATCH"` → `"COMPLIANT"`
- `"MISMATCH"` → `"NON_COMPLIANT"`
- `"REVIEW"` → `"NEEDS_CORRECTION"`

- [x] **Step 4: Rename verdicts in verify.ts**

In `lib/matching/verify.ts`:

- Line 34: `withScore.verdict === "MATCH"` → `withScore.verdict === "COMPLIANT"`
- Line 116: `x.verdict === "MISMATCH"` → `x.verdict === "NON_COMPLIANT"`, `"FAIL"` → `"REJECTED"`, `"PASS"` → `"APPROVED"`

- [x] **Step 5: Run tests to verify matching logic still passes**

```bash
pnpm test lib/matching/
```

- [x] **Step 6: Commit**

```bash
git add lib/matching/
git commit -m "refactor: rename verdicts in matching logic to TTB vocabulary"
```

---

## Task 4: Rename verdicts — components and CSV export

**Files:**

- Modify: `components/verdict-card.tsx`, `components/batch-table.tsx`, `lib/csv.ts`

**Interfaces:**

- Consumes: verdict values from Task 2
- Produces: UI displays new verdict names

- [x] **Step 1: Rename verdicts in verdict-card.tsx**

In `components/verdict-card.tsx`:

- Line 13: `result.overall === "PASS"` → `result.overall === "APPROVED"`
- Line 14: `f.verdict === "REVIEW"` → `f.verdict === "NEEDS_CORRECTION"`

- [x] **Step 2: Rename verdicts in batch-table.tsx**

In `components/batch-table.tsx`:

- Line 12: `overall === "PASS"` → `overall === "APPROVED"`
- Line 55: `overall === "FAIL"` → `overall === "REJECTED"`
- Line 58: `f.verdict === "REVIEW"` → `f.verdict === "NEEDS_CORRECTION"`
- Line 108: `f.verdict !== "MATCH"` → `f.verdict !== "COMPLIANT"`

- [x] **Step 3: Rename verdicts in csv.ts**

In `lib/csv.ts`:

- Line 101: `f.verdict !== "MATCH"` → `f.verdict !== "COMPLIANT"`

- [x] **Step 4: Run tests**

```bash
pnpm test components/ lib/csv.test.ts
```

- [x] **Step 5: Commit**

```bash
git add components/ lib/csv.ts
git commit -m "refactor: rename verdicts in UI components and CSV export"
```

---

## Task 5: Rename verdicts — batch route

**Files:**

- Modify: `app/api/batch/route.ts`

**Interfaces:**

- Consumes: verdict values from Task 2
- Produces: batch route returns new verdict values

- [x] **Step 1: Replace all "FAIL" with "REJECTED" in batch route**

In `app/api/batch/route.ts`, replace all instances of `overall: "FAIL"` with `overall: "REJECTED"`. There are approximately 10 error-returning branches (lines 117, 131, 144, 160, 178, 192, 245, 258, 270, 374).

- [x] **Step 2: Run tests**

```bash
pnpm test app/api/batch/
```

- [x] **Step 3: Commit**

```bash
git add app/api/batch/route.ts
git commit -m "refactor: rename verdicts in batch route to TTB vocabulary"
```

---

## Task 6: Rename verdicts — eval scripts

**Files:**

- Modify: `eval/run.ts`, `eval/injection-gate.ts`, `eval/compare-escalation.ts`, `eval/record-run.ts`, `eval/print-history.ts`, `scripts/check-latency.ts`

**Interfaces:**

- Consumes: verdict values from Task 2
- Produces: eval output uses new vocabulary

- [x] **Step 1: Rename verdicts in eval/run.ts**

In `eval/run.ts`:

- Line 34: `"PASS" | "FAIL" | "ERROR"` → `"APPROVED" | "REJECTED" | "ERROR"`
- Line 46: `"PASS" | "FAIL"` → `"APPROVED" | "REJECTED"`
- Line 58: `"PASS" | "FAIL"` → `"APPROVED" | "REJECTED"`
- Line 90: `["MATCH", "REVIEW"]` → `["COMPLIANT", "NEEDS_CORRECTION"]` and `["MATCH"]` → `["COMPLIANT"]`
- Line 163: `actual: "PASS" | "FAIL" | "ERROR"` → `actual: "APPROVED" | "REJECTED" | "ERROR"`
- Line 200: `actual === want.overall` — no string change needed (uses variable)
- Line 209: `actualOverall = errors.length > 0 || anyRowFailed ? "FAIL" : "PASS"` → `"REJECTED" : "APPROVED"`
- Line 282: `overallCorrect` — rename to `overallCompliant`
- Line 294: exit code logic — update variable names
- Line 307: `overallCorrect` → `overallCompliant`
- Line 312: `bySubset` `.correct` → `.compliant`
- Line 348: `overallOk` check — no string change (uses variable)
- Line 360: `st.correct` → `st.compliant`
- Line 364: `stats.correct` → `stats.compliant`
- Line 404: `overallCorrect` → `overallCompliant`
- Line 406: `overallCorrect` → `overallCompliant`
- Line 408: `overallCorrect` → `overallCompliant`
- Output lines: rename "overall verdict accuracy" → "overall compliance", "per-field verdict accuracy" → "per-field compliance"

- [x] **Step 2: Rename in eval/injection-gate.ts**

In `eval/injection-gate.ts`, line 5 — rename SEVERITY map keys:

```ts
const SEVERITY: Record<string, number> = {
  APPROVED: 0,
  NEEDS_CORRECTION: 1,
  REJECTED: 2,
};
```

- [x] **Step 3: Rename in eval/compare-escalation.ts**

In `eval/compare-escalation.ts`, line 35:
`before === "FAIL" && after === "PASS"` → `before === "REJECTED" && after === "APPROVED"`

- [x] **Step 4: Rename in eval/record-run.ts**

In `eval/record-run.ts`, rename `FieldStat.correct` → `FieldStat.compliant` (line 6). Update `RunSummary.overallCorrect` → `RunSummary.overallCompliant` (line 14).

- [x] **Step 5: Rename in eval/print-history.ts**

In `eval/print-history.ts`, rename `correct` → `compliant` in HistoryEntry types (lines 13, 17).

- [x] **Step 6: Rename in scripts/check-latency.ts**

In `scripts/check-latency.ts`, line 101: `"PASS"` → `"APPROVED"`, `"FAIL"` → `"REJECTED"`

- [x] **Step 7: Run eval tests**

```bash
pnpm test eval/
```

- [x] **Step 8: Commit**

```bash
git add eval/ scripts/check-latency.ts
git commit -m "refactor: rename verdicts in eval scripts to TTB vocabulary"
```

---

## Task 7: Rename verdicts — test files

**Files:**

- Modify: all test files listed in the exploration (21 test files + 2 e2e specs)

**Interfaces:**

- Consumes: verdict values from Tasks 2-6
- Produces: tests pass with new vocabulary

- [x] **Step 1: Rename verdicts in lib/matching/ test files**

Use find-and-replace in each file:

- `lib/matching/fuzzy.test.ts`: `"MATCH"` → `"COMPLIANT"`, `"MISMATCH"` → `"NON_COMPLIANT"`, `"REVIEW"` → `"NEEDS_CORRECTION"`
- `lib/matching/numeric.test.ts`: same replacements
- `lib/matching/warning.test.ts`: same replacements
- `lib/matching/verify.test.ts`: same replacements, plus `"PASS"` → `"APPROVED"`, `"FAIL"` → `"REJECTED"`

- [x] **Step 2: Rename verdicts in eval/ test files**

- `eval/record-run.test.ts`: `"MATCH"` → `"COMPLIANT"`, `"MISMATCH"` → `"NON_COMPLIANT"`, `correct` → `compliant`
- `eval/adversarial-gate.test.ts`: `"MATCH"` → `"COMPLIANT"`, `"MISMATCH"` → `"NON_COMPLIANT"`, `"REVIEW"` → `"NEEDS_CORRECTION"`, `"PASS"` → `"APPROVED"`, `"FAIL"` → `"REJECTED"`
- `eval/print-history.test.ts`: `correct` → `compliant`

- [x] **Step 3: Rename verdicts in component test files**

- `components/verdict-card.test.tsx`: `"MATCH"` → `"COMPLIANT"`, `"MISMATCH"` → `"NON_COMPLIANT"`, `"REVIEW"` → `"NEEDS_CORRECTION"`, `"PASS"` → `"APPROVED"`, `"FAIL"` → `"REJECTED"`, `getByText("PASS")` → `getByText("APPROVED")`, `getByText("FAIL")` → `getByText("REJECTED")`
- `components/batch-table.test.tsx`: same replacements
- `components/field-row.test.tsx`: same replacements
- `components/field-details.test.tsx`: same replacements

- [x] **Step 4: Rename verdicts in app/ test files**

- `app/page.test.tsx`: `"PASS"` → `"APPROVED"`, `"FAIL"` → `"REJECTED"`, `getByText("PASS")` → `getByText("APPROVED")`
- `app/batch/page.test.tsx`: same
- `app/api/verify/route.test.ts`: same
- `app/api/batch/route.test.ts`: same
- `lib/batch-schema.test.ts`: `"PASS"` → `"APPROVED"`, `"FAIL"` → `"REJECTED"`, `"MATCH"` → `"COMPLIANT"`, `"MISMATCH"` → `"NON_COMPLIANT"`, `"REVIEW"` → `"NEEDS_CORRECTION"`
- `lib/csv.test.ts`: `"PASS"` → `"APPROVED"`

- [x] **Step 5: Rename verdicts in hook test files**

- `hooks/use-verify.test.ts`: `"PASS"` → `"APPROVED"`
- `hooks/use-batch.test.ts`: `"PASS"` → `"APPROVED"`

- [x] **Step 6: Rename verdicts in e2e spec files**

- `e2e/single.spec.ts`: `getByText("PASS")` → `getByText("APPROVED")`, `getByText("FAIL")` → `getByText("REJECTED")`
- `e2e/batch.spec.ts`: `getByRole("cell", { name: "PASS" })` → `getByRole("cell", { name: "APPROVED" })`, same for FAIL

- [x] **Step 7: Run full test suite**

```bash
pnpm test
```

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: rename verdicts in all test files to TTB vocabulary"
```

---

## Task 8: Fix eval scoring — stop counting NEEDS_CORRECTION as correct

**Files:**

- Modify: `eval/run.ts`, `eval/record-run.ts`

**Interfaces:**

- Consumes: new verdict vocabulary from Tasks 2-7
- Produces: eval reports compliant/needs_correction/non_compliant separately

- [x] **Step 1: Add needsCorrection count to RunSummary**

In `eval/record-run.ts`, add to `RunSummary` interface:

```ts
needsCorrection?: number;
```

- [x] **Step 2: Update expectedFieldVerdicts in eval/run.ts**

Change the function so that `tolerant: true` means "NEEDS_CORRECTION is acceptable" but does NOT count it as compliant:

```ts
function expectedFieldVerdicts(entry: ExpectedEntry, app: ApplicationData): Record<string, Verdict[]> {
  // For scoring: only COMPLIANT counts as "correct". NEEDS_CORRECTION is acceptable for
  // tolerant entries (doesn't fail the run) but is NOT counted in the compliance metric.
  const base: Verdict[] = ["COMPLIANT"];
  const tolerantBase: Verdict[] = entry.tolerant ? ["COMPLIANT", "NEEDS_CORRECTION"] : ["COMPLIANT"];
  const expected: Record<string, Verdict[]> = { healthWarningStatement: tolerantBase };
  for (const field of MATCHED_APP_FIELDS) if (app[field]) expected[field] = tolerantBase;
  const violation = entry.expected.violation;
  if (violation) expected[violation.field] = violation.verdictOneOf;
  return expected;
}
```

- [x] **Step 3: Update scoring logic in eval/run.ts**

Change the field-level scoring to count compliant vs needs_correction vs non_compliant:

```ts
// Replace the fieldStats Map with a more detailed tracker
const fieldStats = new Map<string, { compliant: number; needsCorrection: number; nonCompliant: number }>();
```

In the field loop (around line 359-375), update:

```ts
for (const [field, accepted] of Object.entries(expectedFieldVerdicts(entry, app))) {
  const stats = fieldStats.get(field) ?? { compliant: 0, needsCorrection: 0, nonCompliant: 0 };
  stats.total++; // This needs to be computed differently now
  const row = result.fields.find((f) => f.field === field);
  const verdict = row?.verdict ?? "NEEDS_CORRECTION";
  if (verdict === "COMPLIANT") stats.compliant++;
  else if (verdict === "NEEDS_CORRECTION") stats.needsCorrection++;
  else stats.nonCompliant++;
  fieldStats.set(field, stats);
}
```

Wait — the current `fieldStats` uses `{ correct: number; total: number }`. We need to change this to track three outcomes. Let me reconsider the structure.

Actually, the simplest approach: keep `total` as before, rename `correct` to `compliant`, and add `needsCorrection`. The headline metric becomes `compliant / total`.

- [x] **Step 4: Update overall scoring in eval/run.ts**

Change `overallCorrect` → `overallCompliant`. Only increment on `result.overall === "APPROVED"` (which already works since `overall` is now `"APPROVED"` | `"REJECTED"`).

- [x] **Step 5: Update output format in eval/run.ts**

Change output lines:

- `overall verdict accuracy` → `overall compliance`
- `per-field verdict accuracy` → `per-field compliance`
- Add new line: `fields needing correction: X/Y (Z%)`

- [x] **Step 6: Update recordRun call**

Pass the new `needsCorrection` count in the summary.

- [x] **Step 7: Run eval with mock provider to verify**

```bash
pnpm eval --provider mock
```

Expected: mock tier still scores 100% (all COMPLIANT).

- [x] **Step 8: Commit**

```bash
git add eval/run.ts eval/record-run.ts
git commit -m "fix(eval): stop counting NEEDS_CORRECTION as correct in scoring"
```

---

## Task 9: Add rate limiting

**Files:**

- Create: `lib/rate-limit.ts`
- Modify: `app/api/verify/route.ts`, `app/api/batch/route.ts`

**Interfaces:**

- Consumes: nothing (standalone)
- Produces: `rateLimit(opts)` returns `{ ok: true } | { ok: false, retryAfter: number }`

- [x] **Step 1: Create lib/rate-limit.ts**

```ts
interface RateLimitEntry {
  timestamps: number[];
}

interface RateLimitOpts {
  windowMs?: number;
  max?: number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 60;

const clients = new Map<string, RateLimitEntry>();

function cleanup(windowMs: number) {
  const cutoff = Date.now() - windowMs;
  for (const [ip, entry] of clients) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) clients.delete(ip);
  }
}

export function rateLimit(ip: string, opts: RateLimitOpts = {}): { ok: true } | { ok: false; retryAfter: number } {
  const windowMs = (opts.windowMs ?? Number(process.env.RATE_LIMIT_WINDOW_MS)) || DEFAULT_WINDOW_MS;
  const max = (opts.max ?? Number(process.env.RATE_LIMIT_MAX)) || DEFAULT_MAX;

  cleanup(windowMs);

  let entry = clients.get(ip);
  if (!entry) {
    entry = { timestamps: [] };
    clients.set(ip, entry);
  }

  const now = Date.now();
  entry.timestamps = entry.timestamps.filter((t) => t > now - windowMs);

  if (entry.timestamps.length >= max) {
    const oldest = entry.timestamps[0];
    const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
    return { ok: false, retryAfter };
  }

  entry.timestamps.push(now);
  return { ok: true };
}
```

- [x] **Step 2: Apply rate limit in app/api/verify/route.ts**

At the start of the POST handler, add:

```ts
import { rateLimit } from "@/lib/rate-limit";

// Inside POST handler, before any processing:
const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
const limit = rateLimit(ip);
if (!limit.ok) {
  return NextResponse.json(
    { error: "Rate limit exceeded" },
    { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
  );
}
```

- [x] **Step 3: Apply rate limit in app/api/batch/route.ts**

Same pattern as Step 2, at the start of the POST handler.

- [x] **Step 4: Add ARCHITECTURE.md note**

Update `docs/ARCHITECTURE.md` rate-limiting line from "production TODO" to "implemented (in-memory sliding window, configurable via RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX env vars)."

- [x] **Step 5: Run tests**

```bash
pnpm test app/api/verify/ app/api/batch/
```

- [x] **Step 6: Commit**

```bash
git add lib/rate-limit.ts app/api/verify/route.ts app/api/batch/route.ts docs/ARCHITECTURE.md
git commit -m "feat: add in-memory rate limiting to verify and batch endpoints"
```

---

## Task 10: Add openapi.yaml validation test

**Files:**

- Create: `openapi.test.ts`
- Modify: `package.json` (add yaml devDep)

**Interfaces:**

- Consumes: `lib/batch-schema.ts` (BatchRowResultSchema)
- Produces: test that validates openapi.yaml matches actual routes

- [x] **Step 1: Add yaml devDependency**

```bash
pnpm add -D yaml
```

- [x] **Step 2: Create openapi.test.ts**

```ts
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { BatchRowResultSchema } from "@/lib/batch-schema";

describe("openapi.yaml", () => {
  let spec: ReturnType<typeof parseYaml>;

  beforeAll(async () => {
    const text = await readFile("openapi.yaml", "utf8");
    spec = parseYaml(text);
  });

  it("has no unresolved $ref", () => {
    const definitions = spec.components?.schemas ?? {};
    const findRefs = (obj: unknown): string[] => {
      if (typeof obj !== "object" || obj === null) return [];
      if ("$ref" in obj) return [obj.$ref as string];
      return Object.values(obj).flatMap(findRefs);
    };
    const refs = findRefs(spec);
    for (const ref of refs) {
      const name = ref.replace("#/components/schemas/", "");
      expect(definitions[name]).toBeDefined();
    }
  });

  it("BatchRowResult properties match schema", () => {
    const specSchema = spec.components?.schemas?.BatchRowResult;
    expect(specSchema).toBeDefined();
    const specProps = Object.keys(specSchema.properties ?? {}).sort();

    // Get the keys from the Zod schema by parsing a minimal valid row
    const zodKeys = Object.keys(
      BatchRowResultSchema.parse({
        filename: "test.jpg",
        overall: "APPROVED",
        fields: [],
      }),
    ).sort();

    expect(specProps).toEqual(zodKeys);
  });
});
```

- [x] **Step 3: Run the test**

```bash
pnpm test openapi.test.ts
```

- [x] **Step 4: Commit**

```bash
git add openapi.test.ts package.json pnpm-lock.yaml
git commit -m "test: add openapi.yaml validation test against batch-schema"
```

---

## Task 11: Add security comment to security-headers.ts

**Files:**

- Modify: `lib/security-headers.ts`

- [x] **Step 1: Add explanatory comment**

Add a comment above the CSP directive explaining why `unsafe-inline` is used and what nonce-based CSP would require:

```ts
// Next.js App Router requires 'unsafe-inline' for script/style hydration.
// A nonce-based policy requires: (1) middleware.ts to inject per-request nonces,
// (2) build-time nonce injection into the Next.js runtime, (3) removing
// 'unsafe-inline'. This is the documented future hardening step — see
// docs/superpowers/specs/2026-07-25-codebase-cleanup-design.md §6.
```

- [x] **Step 2: Commit**

```bash
git add lib/security-headers.ts
git commit -m "docs: explain CSP unsafe-inline constraint in security-headers.ts"
```

---

## Task 12: Clean up dead specs and update ARCHITECTURE.md

**Files:**

- Modify: `docs/ARCHITECTURE.md`, `docs/deferred-items-and-tradeoffs-2026-07-25.md`

- [x] **Step 1: Update ARCHITECTURE.md provider section**

Remove Gemini, Claude, OpenAI, Groq references from the provider description. Bedrock is the sole cloud provider.

- [x] **Step 2: Update ARCHITECTURE.md vocabulary section**

Rename MATCH/MISMATCH/REVIEW/PASS/FAIL to COMPLIANT/NON_COMPLIANT/NEEDS_CORRECTION/APPROVED/REJECTED throughout.

- [x] **Step 3: Update ARCHITECTURE.md stretch goals section**

Move implemented items to "implemented" status, move deferred items to a clean "future work" section. Remove dead references (pre-cut items, deferred-past-submission items).

**Note (2026-07-26):** this step describes a "future work / stretch goals" section of
`ARCHITECTURE.md` that never existed, in this document or at any point in `ARCHITECTURE.md`'s
history — the plan's premise was wrong, not the implementation. Stretch-goal status is tracked
instead in `docs/deferred-items-and-tradeoffs-2026-07-25.md` (Step 4 below), which is where the
final-review pass verified §1/§2/§5 as resolved and §3/§4 as still genuinely open.

- [x] **Step 4: Update deferred-items doc**

Mark items as addressed or stale where applicable.

- [x] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs: clean up dead specs, update vocabulary and provider references"
```

---

## Task 13: Final verification

- [x] **Step 1: Run full test suite**

```bash
pnpm test
```

- [x] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

- [x] **Step 3: Run lint**

```bash
pnpm lint
```

- [x] **Step 4: Run eval with mock provider**

```bash
pnpm eval --provider mock
```

Expected: 100% compliance, all fields COMPLIANT.

- [x] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "chore: final cleanup fixes after codebase refactor"
```
