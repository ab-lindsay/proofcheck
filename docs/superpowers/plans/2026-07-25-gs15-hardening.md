# GS-15 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every HIGH/MEDIUM finding from the 2026-07-25 four-subsystem senior review — a false-PASS defect in the deterministic matcher, a dead cloud-fallback path, the untested default cloud adapter, a tautological CI accuracy gate, an n=1 security claim, and several staged-but-uncommitted DevSecOps regressions — per `docs/superpowers/specs/2026-07-25-gs15-hardening-design.md` (D1–D8, 9 acceptance criteria).

**Architecture:** No new subsystems. Every change lands inside the existing layering: pure-function fixes in `lib/matching`/`lib/ttb` (D2, D5), a provider-selection/composition change in `lib/vision` (D1, D3, D4), an eval/CI-gate change in `eval/` and `.github/workflows/` (D6), a lint-boundary widening in `eslint.config.mjs` (D7), and DevSecOps hygiene in workflows/env/docs (D8). `CLAUDE.md`'s invariants (extraction proposes/matching disposes, keyless by default, keys server-side only, fail closed per item) are unchanged — this hardens them, it doesn't renegotiate them.

**Tech Stack:** TypeScript, Next.js 16 (App Router), Vitest, Zod, `openai`/`@anthropic-ai/sdk`/`@google/generative-ai` SDKs, pnpm, GitHub Actions.

## Global Constraints

- Use **pnpm**, never npm, for every command in this plan.
- **Vitest** is the test runner (`pnpm test` = `vitest run`); component/adapter tests that need a real Node (not jsdom) environment use the `// @vitest-environment node` pragma already established in `lib/vision/cloud/*.test.ts`.
- **TDD for every logic change**: write the failing test, run it and confirm the failure, write the minimal implementation, run the test and confirm it passes, then commit. Every code task below follows this order.
- Run `pnpm test` and `pnpm lint` before every commit; run `pnpm typecheck` before the final commit of any task that touches a `.ts`/`.tsx` file.
- CLAUDE.md invariants that constrain every task here: extraction proposes, matching disposes (no model/OCR ever returns a verdict); the health warning statement is checked byte-exact/deterministically, never fuzzy; the app is keyless by default (mock + local-ocr always work with zero env vars); API keys are server-side only, never logged, never in prompts; failures are handled per-item, never a silent PASS.
- **`pnpm eval` (mock tier) must stay 13/13 overall and 8/8 planted violations caught** after every task in this plan — it is the matcher regression canary and the harness itself exits 1 if it regresses.
- New tests must be shown to fail when the behavior they guard is deliberately sabotaged (the repo's non-tautology standard) — each task's steps include this check where it's meaningfully possible; where a change is a behavior-preserving optimization (not a correctness guard), the task says so explicitly rather than overclaiming.

---

### Task 1: D2a — empty-after-normalize guard (false-PASS fix) in `lib/matching/fuzzy.ts`

**Files:**

- Modify: `lib/matching/fuzzy.ts:20-64` (the `fuzzyVerdict` function body)
- Test: `lib/matching/fuzzy.test.ts` (append), `lib/matching/verify.test.ts` (append)

**Interfaces:**

- Consumes: `normalizeLoose` from `@/lib/ttb/normalize` (unchanged signature: `(s: string) => string`).
- Produces: `fuzzyVerdict(args)` unchanged signature — `{ field, applicationValue, labelValue, normalizedEqualIsMatch }` → `FieldResult`. No caller changes needed; `lib/matching/verify.ts`'s `compare()` helper calls this exactly as today.

- [ ] **Step 1: Write the failing tests**

In `lib/matching/fuzzy.test.ts`, append:

```ts
describe("fuzzyVerdict (D2a — non-Latin/symbolic text never silently MATCHes, 2026-07-25)", () => {
  it("two different non-Latin strings that both fold to empty are REVIEW, never MATCH", () => {
    // normalizeLoose strips [^a-z0-9\s], so CJK text collapses to "" on both sides — without a
    // guard, "" === "" would MATCH under normalizedEqualIsMatch: true (classType/nameAndAddress/
    // countryOfOrigin), a false PASS on two genuinely different values.
    const r = fuzzyVerdict({
      field: "countryOfOrigin",
      applicationValue: "日本",
      labelValue: "中国",
      normalizedEqualIsMatch: true,
    });
    expect(r.verdict).toBe("REVIEW");
    expect(r.reason).toMatch(/non-Latin|symbolic/i);
  });

  it("is REVIEW (not MISMATCH) even when only the label side folds to empty", () => {
    const r = fuzzyVerdict({
      field: "brandName",
      applicationValue: "OLD TOM",
      labelValue: "老汤姆",
      normalizedEqualIsMatch: false,
    });
    expect(r.verdict).toBe("REVIEW");
  });
});
```

In `lib/matching/verify.test.ts`, append (inside the existing `describe("verifyLabel", ...)` block, before its closing `});` at line 163):

```ts
it("countryOfOrigin in two different non-Latin scripts is REVIEW through the full verify pipeline, never a false PASS (D2a, 2026-07-25)", () => {
  const importApp: ApplicationData = {
    beverageType: "wine",
    brandName: "KIRKBRIDE",
    classType: "Red Wine",
    alcoholContent: "13% Alc./Vol.",
    netContents: "750 mL",
    countryOfOrigin: "日本",
  };
  const importLabel: ExtractedLabel = {
    ...clean,
    brandName: f("KIRKBRIDE"),
    classType: f("Red Wine"),
    alcoholContent: f("13% Alc./Vol."),
    countryOfOrigin: f("中国"),
  };
  const r = verifyLabel(importApp, importLabel);
  expect(r.fields.find((x) => x.field === "countryOfOrigin")?.verdict).toBe("REVIEW");
  expect(r.overall).toBe("PASS"); // REVIEW never fails the label
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test fuzzy.test.ts verify.test.ts`
Expected: FAIL — both new "日本"/"中国"-style assertions report `verdict` as `"MATCH"` (the current bug), not `"REVIEW"`.

- [ ] **Step 3: Implement the guard**

In `lib/matching/fuzzy.ts`, insert the guard immediately after computing `a`/`b` and before the `if (a === b)` check:

```ts
  const a = normalizeLoose(applicationValue);
  const b = normalizeLoose(labelValue);
  // D2a (false-PASS, HIGH, 2026-07-25 hardening): normalizeLoose strips [^a-z0-9\s], so an
  // all-non-Latin/symbolic string (CJK, Cyrillic, etc.) folds to "". Two DIFFERENT non-Latin
  // strings then both normalize to "" and would compare equal below — a false MATCH wherever
  // normalizedEqualIsMatch is true (classType, nameAndAddress, countryOfOrigin). Neither MATCH
  // nor MISMATCH is honest here: the fold genuinely cannot compare this text, so it must always
  // be REVIEW, regardless of normalizedEqualIsMatch.
  if ((a === "" && applicationValue.trim() !== "") || (b === "" && labelValue.trim() !== "")) {
    return {
      ...base,
      verdict: "REVIEW",
      reason: `Could not be compared automatically ("${applicationValue}" vs "${labelValue}" — non-Latin or symbolic text) — verify by eye.`,
    };
  }
  if (a === b) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test fuzzy.test.ts verify.test.ts`
Expected: PASS — all new tests green; all pre-existing `fuzzy.test.ts`/`verify.test.ts` assertions still green (the guard only fires when a normalized side is `""` from non-empty raw input, which none of the existing fixtures hit).

- [ ] **Step 5: Sabotage check (non-tautology standard)**

Temporarily comment out the new `if` block, run `pnpm test fuzzy.test.ts`, confirm the two new D2a tests go red (verdict comes back `"MATCH"`), then restore the block.

- [ ] **Step 6: Run the mock eval canary**

Run: `pnpm eval`
Expected: `overall verdict accuracy: 13/13 (100%)` and `planted violations caught: 8/8 (100%)` — unchanged (no mock fixture hits this new branch).

- [ ] **Step 7: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add lib/matching/fuzzy.ts lib/matching/fuzzy.test.ts lib/matching/verify.test.ts
git commit -m "fix: REVIEW (never MATCH) when normalizeLoose folds non-Latin text to empty

Fixes a false-PASS: two different non-Latin/symbolic values (e.g. 日本 vs 中国) both fold to
\"\" under normalizeLoose and previously compared equal — a silent MATCH on classType,
nameAndAddress, and countryOfOrigin. D2a, GS-15 hardening spec."
```

---

### Task 2: D2b — relative volume tolerance (false-FAIL fix) in `lib/matching/numeric.ts`

**Files:**

- Modify: `lib/matching/numeric.ts:1-39`
- Test: `lib/matching/numeric.test.ts` (append)

**Interfaces:**

- Consumes: `parseNetContents` from `@/lib/ttb/normalize` (unchanged: `(s: string) => { ml: number } | null`).
- Produces: `checkNetContents(applicationValue, field)` unchanged signature/return (`FieldResult`); `checkAlcoholContent` untouched by this task.

- [ ] **Step 1: Write the failing tests**

Append to `lib/matching/numeric.test.ts`, inside `describe("checkNetContents", ...)`:

```ts
it("matches 750 mL against its real fl-oz label reading (D2b — 25.4 FL OZ = 751.167 mL, false-FAIL fix, 2026-07-25)", () => {
  expect(checkNetContents("750 mL", f("25.4 FL OZ")).verdict).toBe("MATCH");
});
it("matches 1.75 L against its real fl-oz label reading (59.2 FL OZ = 1750.95 mL)", () => {
  expect(checkNetContents("1.75 L", f("59.2 FL OZ")).verdict).toBe("MATCH");
});
it("still MISMATCHes a volume that's genuinely off, scaled to the larger tolerance", () => {
  // 1.75 L -> tolerance is max(1, 0.005*1750) = 8.75 mL; 1700 mL is 50 mL short of that.
  expect(checkNetContents("1.75 L", f("1700 mL")).verdict).toBe("MISMATCH");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test numeric.test.ts`
Expected: FAIL on the two new MATCH assertions — the flat `ML_TOLERANCE = 1` rejects 0.167 mL/0.951 mL of legitimate cross-unit rounding as `MISMATCH`.

- [ ] **Step 3: Implement the relative tolerance**

In `lib/matching/numeric.ts`, replace:

```ts
const ABV_TOLERANCE = 0.15;
const ML_TOLERANCE = 1;
```

with:

```ts
const ABV_TOLERANCE = 0.15;
// D2b (false-FAIL, MED-HIGH, 2026-07-25 hardening): a flat 1 mL absolute tolerance fails
// legitimate mL<->fl-oz round-trips at real bottle sizes — "25.4 FL OZ" (a common 750 mL label
// reading) converts to 751.167 mL, 0.167 mL over a flat 1 mL bound. 0.5% of the APPLICATION's
// stated volume scales with bottle size instead: 750 mL -> 3.75 mL tolerance (25.4 FL OZ passes
// with real headroom), 1.75 L -> 8.75 mL (59.2 FL OZ passes). The 1 mL floor keeps tiny/zero
// volumes from getting a zero tolerance.
const MIN_ML_TOLERANCE = 1;
const RELATIVE_ML_TOLERANCE = 0.005;

function mlTolerance(applicationMl: number): number {
  return Math.max(MIN_ML_TOLERANCE, RELATIVE_ML_TOLERANCE * applicationMl);
}
```

Then in `checkNetContents`, replace:

```ts
if (Math.abs(app.ml - label.ml) <= ML_TOLERANCE) {
  return { ...base, verdict: "MATCH", reason: "Net contents agree." };
}
```

with:

```ts
if (Math.abs(app.ml - label.ml) <= mlTolerance(app.ml)) {
  return { ...base, verdict: "MATCH", reason: "Net contents agree." };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test numeric.test.ts`
Expected: PASS — all new and pre-existing tests green (`checkNetContents("750 mL", f("700 mL"))` is still `MISMATCH`: 50 mL diff vs a 3.75 mL tolerance).

- [ ] **Step 5: Sabotage check**

Temporarily revert `mlTolerance` to `return MIN_ML_TOLERANCE;` (ignoring the relative term), run `pnpm test numeric.test.ts`, confirm the two new MATCH tests go red, then restore.

- [ ] **Step 6: Run the mock eval canary**

Run: `pnpm eval`
Expected: `13/13`, `8/8` — unchanged.

- [ ] **Step 7: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`

- [ ] **Step 8: Commit**

```bash
git add lib/matching/numeric.ts lib/matching/numeric.test.ts
git commit -m "fix: scale net-contents tolerance to 0.5% of the application volume

A flat 1 mL tolerance rejected real fl-oz<->mL round-trips (750 mL vs 25.4 FL OZ = 751.167 mL)
as a false MISMATCH. D2b, GS-15 hardening spec."
```

---

### Task 3: D2c — European decimal-comma parsing in `lib/ttb/normalize.ts`

**Files:**

- Modify: `lib/ttb/normalize.ts:46-58` (`parseNetContents`)
- Test: `lib/ttb/normalize.test.ts` (append)

**Interfaces:**

- Consumes: nothing new.
- Produces: `parseNetContents(s: string): { ml: number } | null` — unchanged signature; `lib/matching/numeric.ts`'s `checkNetContents` (Task 2) calls this unmodified.

⚠ **Deviation note (recorded here, not silently resolved):** the design spec's prose rule — "a comma is a thousands separator only when followed by exactly three digits **and not the last group before the unit**" — is inconsistent with its own worked example. In `"1,750 mL"`, the comma's 3-digit group (`750`) **is** the last group before the unit, so a literal reading of "not the last group" would classify it as a decimal point (→ 1.750 mL), contradicting the spec's own expected output of 1750 mL. This task implements the rule by **digit count alone** — a comma followed by exactly 3 digits is a thousands separator; followed by 1 or 2 digits, it's a decimal point — which satisfies all three worked examples (`"1,750 mL"` → 1750, `"0,75 L"` → 750, `"1,5 L"` → 1500) and every pre-existing test in `normalize.test.ts`. Flag for spec author review if the "not the last group" clause was intended to matter for some other input shape (e.g. `"1,234,567 mL"` or `"1,234.56 mL"`) not covered by any current test.

- [ ] **Step 1: Write the failing tests**

Append to `lib/ttb/normalize.test.ts`, inside `describe("parseNetContents", ...)`:

```ts
it("treats a comma as a European decimal point when followed by one or two digits (D2c, 2026-07-25)", () => {
  expect(parseNetContents("0,75 L")).toEqual({ ml: 750 });
  expect(parseNetContents("1,5 L")).toEqual({ ml: 1500 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test normalize.test.ts`
Expected: FAIL — `parseNetContents("0,75 L")` currently strips the comma as a thousands separator unconditionally, parsing `"075"` → `{ ml: 75000 }`, not `{ ml: 750 }`.

- [ ] **Step 3: Implement digit-count-based comma disambiguation**

In `lib/ttb/normalize.ts`, replace the `cleaned` computation inside `parseNetContents`:

```ts
export function parseNetContents(s: string): { ml: number } | null {
  const cleaned = s
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1$2") // strip thousands separators ("1,750" -> "1750")
    .replace(/\.(?!\d)/g, ""); // keep decimals ("1.75 L"); drop "fl. oz." dots
```

with:

```ts
export function parseNetContents(s: string): { ml: number } | null {
  const cleaned = s
    .toLowerCase()
    // D2c (European decimal comma, MED, 2026-07-25 hardening): a comma is ambiguous between a US
    // thousands separator ("1,750" -> 1750) and a European decimal point ("0,75" -> 0.75, "1,5"
    // -> 1.5). Digit COUNT after the comma disambiguates: a three-digit group is the standard
    // thousands-grouping width; one or two digits can only be a decimal fraction (nobody groups
    // thousands in units of 1 or 2). The 3-digit rule runs FIRST so "1,750" is fully consumed as
    // a thousands separator before the 1-2 digit rule could see a partial match.
    .replace(/(\d),(\d{3})(?!\d)/g, "$1$2") // "1,750" -> "1750"; "1,000" -> "1000"
    .replace(/(\d),(\d{1,2})(?!\d)/g, "$1.$2") // "0,75" -> "0.75"; "1,5" -> "1.5"
    .replace(/\.(?!\d)/g, ""); // keep decimals ("1.75 L"); drop "fl. oz." dots
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test normalize.test.ts`
Expected: PASS — new test green; pre-existing "handles thousands separators and leading-decimal volumes" test (`"1,750 mL"` → 1750, `"1,000 mL"` → 1000, `".75 L"` → 750) still green.

- [ ] **Step 5: Sabotage check**

Temporarily delete the new `.replace(/(\d),(\d{1,2})(?!\d)/g, "$1.$2")` line, run `pnpm test normalize.test.ts`, confirm the new test goes red (`"0,75 L"` resolves to 75000 mL instead of 750), then restore.

- [ ] **Step 6: Run the mock eval canary**

Run: `pnpm eval`
Expected: `13/13`, `8/8` — unchanged.

- [ ] **Step 7: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`

- [ ] **Step 8: Commit**

```bash
git add lib/ttb/normalize.ts lib/ttb/normalize.test.ts
git commit -m "fix: parse a comma followed by 1-2 digits as a European decimal point

'0,75 L' and '1,5 L' previously parsed as 75000 mL / 15000 mL (comma always treated as a
thousands separator). D2c, GS-15 hardening spec."
```

---

### Task 4: D2d — adversarial/unicode test block + D5 schema hardening

**Files:**

- Modify: `lib/matching/fuzzy.ts` (length short-circuit, inserted after Task 1's guard)
- Modify: `lib/schema.ts:26` (`.max(2000)`)
- Test: `lib/matching/fuzzy.test.ts` (append), `lib/matching/warning.test.ts` (append), `lib/schema.test.ts` (append)

**Interfaces:**

- Consumes: nothing new.
- Produces: no signature changes. `ExtractedFieldSchema.value` now rejects strings > 2000 chars at parse time — every caller already goes through `ExtractedLabelSchema.parse`/`safeParse` (route.ts, eval/run.ts), so a real over-length model response now fails closed at the same boundary a malformed one already does.

⚠ **Deviation note:** the design's D2d text says the homoglyph test on the `GOVERNMENT WARNING:` prefix belongs in `fuzzy.test.ts`. Functionally, that prefix is checked byte-exact by `checkHealthWarning` in `lib/matching/warning.ts` — `fuzzyVerdict` is never invoked for `healthWarningStatement` at all (see `lib/matching/verify.ts:84`, which calls `checkHealthWarning` directly). This task places the homoglyph test in `lib/matching/warning.test.ts` instead, next to `checkHealthWarning`'s other tests, since that's the function actually under test; the threshold-boundary test (which genuinely exercises `fuzzyVerdict`) stays in `fuzzy.test.ts` as specified.

- [ ] **Step 1: Write the failing tests**

Append to `lib/matching/fuzzy.test.ts`:

```ts
describe("fuzzyVerdict (adversarial/unicode block — D2d, 2026-07-25)", () => {
  it("edit distance exactly at the threshold is REVIEW, not MISMATCH", () => {
    // threshold = max(2, round(10 * 0.2)) = 2. "abcdefghij" -> "abcdefxyij" substitutes g->x, h->y:
    // distance 2, exactly at the threshold.
    const r = fuzzyVerdict({
      field: "brandName",
      applicationValue: "abcdefghij",
      labelValue: "abcdefxyij",
      normalizedEqualIsMatch: false,
    });
    expect(r.verdict).toBe("REVIEW");
  });
  it("edit distance one past the threshold is MISMATCH", () => {
    // Same threshold (2); "abcdefghij" -> "abcdefxyzj" substitutes g->x, h->y, i->z: distance 3.
    const r = fuzzyVerdict({
      field: "brandName",
      applicationValue: "abcdefghij",
      labelValue: "abcdefxyzj",
      normalizedEqualIsMatch: false,
    });
    expect(r.verdict).toBe("MISMATCH");
  });
  it("a near-schema-limit label value resolves correctly (length short-circuit, D5)", () => {
    // Companion to the ExtractedFieldSchema.max(2000) cap (lib/schema.test.ts): even before that
    // cap rejects a truly pathological value, fuzzyVerdict must not depend on running the full
    // O(m*n) levenshtein to reach the right answer for a wildly length-mismatched pair.
    const r = fuzzyVerdict({
      field: "brandName",
      applicationValue: "OLD TOM DISTILLERY",
      labelValue: "X".repeat(2000),
      normalizedEqualIsMatch: false,
    });
    expect(r.verdict).toBe("MISMATCH");
  });
});
```

Append to `lib/matching/warning.test.ts`, inside `describe("checkHealthWarning", ...)`:

```ts
it("a homoglyph attack on the GOVERNMENT WARNING prefix (Cyrillic О, U+041E) is MISMATCH, never fuzzy-matched into passing (D2d, 2026-07-25)", () => {
  // Cyrillic О (U+041E CYRILLIC CAPITAL LETTER O) is visually identical to Latin "O" but a
  // different code point. checkHealthWarning is a byte-exact compare (no normalizeLoose/fuzzy
  // fold anywhere in this function), so replacing the label's real O with it must MISMATCH on
  // the missing-prefix path exactly like any other altered text.
  const spoofed = HEALTH_WARNING_TEXT.replace("O", "О"); // replaces the O in "GOVERNMENT"
  const r = checkHealthWarning(f(spoofed));
  expect(r.verdict).toBe("MISMATCH");
  expect(r.reason).toMatch(/does not begin with/i);
});
```

Append to `lib/schema.test.ts`, inside `describe("ExtractedLabelSchema", ...)`:

```ts
it("rejects a field value longer than 2000 characters (D5 schema hardening, 2026-07-25)", () => {
  const tooLong = { ...validLabel, brandName: field("X".repeat(2001)) };
  expect(ExtractedLabelSchema.safeParse(tooLong).success).toBe(false);
});
it("accepts a field value exactly at the 2000-character cap", () => {
  const atCap = { ...validLabel, brandName: field("X".repeat(2000)) };
  expect(ExtractedLabelSchema.safeParse(atCap).success).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test fuzzy.test.ts warning.test.ts schema.test.ts`
Expected: the two threshold-boundary tests and the homoglyph test currently PASS already (they pin existing correct behavior — see step 3 note); the `.max(2000)` "rejects" test FAILs (`success` is `true`, should be `false`).

- [ ] **Step 3: Implement**

In `lib/schema.ts`, change line 26:

```ts
  value: z.string().nullable(),
```

to:

```ts
  value: z.string().max(2000).nullable(),
```

In `lib/matching/fuzzy.ts`, insert the length short-circuit between the word-boundary-prefix check and the `levenshtein` call:

```ts
  const distance = levenshtein(a, b);
  const threshold = Math.max(2, Math.round(a.length * 0.2));
  if (distance <= threshold) {
```

becomes:

```ts
  const threshold = Math.max(2, Math.round(a.length * 0.2));
  // D5 companion (2026-07-25): edit distance is always >= the difference in length, so once the
  // normalized lengths differ by more than the threshold, the full distance is guaranteed to
  // exceed it too — skip the O(m*n) levenshtein call rather than run it on a pathological input
  // (paired with the ExtractedFieldSchema.max(2000) cap above). This is a behavior-PRESERVING
  // optimization, not a new branch: the mathematical bound means the final verdict here is
  // identical to what the full levenshtein computation below would have produced, so unlike the
  // other guards in this task it is not independently sabotage-testable by verdict alone — its
  // test (Step 1) exists to pin correctness at scale, not to catch a behavior regression if removed.
  if (Math.abs(a.length - b.length) > threshold) {
    return { ...base, verdict: "MISMATCH", reason: `Label shows "${labelValue}" but the application says "${applicationValue}".` };
  }
  const distance = levenshtein(a, b);
  if (distance <= threshold) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test fuzzy.test.ts warning.test.ts schema.test.ts`
Expected: all PASS.

- [ ] **Step 5: Sabotage check (the genuinely guard-like change)**

Temporarily change `.max(2000)` back to no length cap in `lib/schema.ts`, run `pnpm test schema.test.ts`, confirm the "rejects a field value longer than 2000 characters" test goes red, then restore.

- [ ] **Step 6: Run the mock eval canary**

Run: `pnpm eval`
Expected: `13/13`, `8/8` — unchanged.

- [ ] **Step 7: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`

- [ ] **Step 8: Commit**

```bash
git add lib/matching/fuzzy.ts lib/matching/fuzzy.test.ts lib/matching/warning.test.ts lib/schema.ts lib/schema.test.ts
git commit -m "harden: cap ExtractedField.value at 2000 chars; add adversarial/unicode test block

Schema cap closes the unbounded-model-output path into levenshtein/JSON/CSV/DOM. Adds a
length short-circuit in fuzzyVerdict (exact, not heuristic — edit distance >= length diff), a
threshold-boundary pin, and a Cyrillic-homoglyph MISMATCH pin on the health warning prefix.
D2d + D5, GS-15 hardening spec."
```

---

### Task 5: D1 — Bedrock-first cloud priority + `.trim()` key checks + doc sweep (D8d)

**Files:**

- Modify: `lib/vision/select.ts:35-61`
- Modify: `lib/vision/select.test.ts:1-74`
- Modify: `.env.example:10,17-21`
- Modify: `README.md:30,92-95`
- Modify: `docs/ARCHITECTURE.md:25,144-152`
- Modify: `app/api/verify/route.ts:199` (D8d — the 72%/75% figure reconciliation; the composition-site change itself is Task 6)

**Interfaces:**

- Consumes: nothing new.
- Produces: `selectCloudProvider(): VisionProvider | null` — same signature, new priority order (`bedrock → gemini → claude → openai → groq`) and every check now `?.trim()`. `selectProvider(filename?)` unchanged signature, delegates to the same function.

- [ ] **Step 1: Write the failing tests**

Replace `lib/vision/select.test.ts` in full (adds bedrock-priority and whitespace-key coverage; clears `AWS_BEARER_TOKEN_BEDROCK` in the pre-existing tests that assert a lower-priority tier, since bedrock now outranks all of them):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectProvider, providerByName, selectCloudProvider } from "@/lib/vision/select";

afterEach(() => vi.unstubAllEnvs());

describe("selectProvider", () => {
  it("VISION_PROVIDER forces a tier", () => {
    vi.stubEnv("VISION_PROVIDER", "mock");
    expect(selectProvider("anything.png").name).toBe("mock");
  });
  it("VISION_PROVIDER=local-llm forces the local-llm tier", () => {
    vi.stubEnv("VISION_PROVIDER", "local-llm");
    expect(selectProvider("upload.png").name).toBe("local-llm");
  });
  it("refuses VISION_PROVIDER=mock in production (mock returns fabricated data)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VISION_PROVIDER", "mock");
    expect(() => selectProvider("anything.png")).toThrow(/mock/i);
  });
  it("bundled sample filenames use the mock tier", () => {
    vi.stubEnv("VISION_PROVIDER", "");
    expect(selectProvider("old-tom-clean.png").name).toBe("mock");
  });
  it("a configured Gemini key selects the cloud tier for uploads when no higher-priority key is set", () => {
    vi.stubEnv("VISION_PROVIDER", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    expect(selectProvider("upload.png").name).toBe("gemini");
  });
  it("a configured Groq key selects groq when no higher-priority key is set", () => {
    vi.stubEnv("VISION_PROVIDER", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "test-key");
    expect(selectProvider("upload.png").name).toBe("groq");
  });
  it("a configured Bedrock token selects bedrock even with no other key set", () => {
    vi.stubEnv("VISION_PROVIDER", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    expect(selectProvider("upload.png").name).toBe("bedrock");
  });
  it("Bedrock takes priority over every other cloud key when multiple are configured (D1, 2026-07-25)", () => {
    vi.stubEnv("VISION_PROVIDER", "");
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-claude-key");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("GROQ_API_KEY", "test-groq-key");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-bedrock-token");
    expect(selectProvider("upload.png").name).toBe("bedrock");
    expect(selectCloudProvider()?.name).toBe("bedrock");
  });
  it("treats a whitespace-only key as absent — it can't work, so it must not be selected (W8, 2026-07-25)", () => {
    vi.stubEnv("VISION_PROVIDER", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "   ");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    expect(selectProvider("upload.png").name).toBe("local-ocr");
    expect(selectCloudProvider()).toBeNull();
  });
  it("no key and unknown file falls back to local-ocr", () => {
    vi.stubEnv("VISION_PROVIDER", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    expect(selectProvider("upload.png").name).toBe("local-ocr");
  });
  it("providerByName rejects unknown names", () => {
    expect(() => providerByName("watson")).toThrow(/unknown/i);
  });
});

describe("selectCloudProvider", () => {
  it("returns null when no cloud key is configured", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    expect(selectCloudProvider()).toBeNull();
  });
  it("returns the configured provider honoring the same priority order as selectProvider", () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    expect(selectCloudProvider()?.name).toBe("claude");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test select.test.ts`
Expected: FAIL — "Bedrock takes priority" and "treats a whitespace-only key as absent" both fail against the current truthiness-checked, Gemini-first `selectCloudProvider`.

- [ ] **Step 3: Implement**

In `lib/vision/select.ts`, replace lines 35-42:

```ts
export function selectCloudProvider(): VisionProvider | null {
  if (process.env.GEMINI_API_KEY) return geminiProvider;
  if (process.env.ANTHROPIC_API_KEY) return claudeProvider;
  if (process.env.OPENAI_API_KEY) return openaiProvider;
  if (process.env.GROQ_API_KEY) return groqProvider;
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return bedrockProvider;
  return null;
}
```

with:

```ts
export function selectCloudProvider(): VisionProvider | null {
  // Priority (D1, 2026-07-25 hardening): bedrock -> gemini -> claude -> openai -> groq. Bedrock is
  // the default cloud tier now — nearly all committed real-world eval evidence is Bedrock, Gemini's
  // free tier has a measured 20-req/day quota wall (see the ARCHITECTURE.md risk table), and Bedrock
  // is the FedRAMP/GovCloud-alignable path for federal use. Every check is `?.trim()`, not plain
  // truthiness (W8): a whitespace-only key previously selected a tier that provably cannot work and
  // made GET /api/verify report `cloudAvailable: true` for a key that would fail on first use.
  if (process.env.AWS_BEARER_TOKEN_BEDROCK?.trim()) return bedrockProvider;
  if (process.env.GEMINI_API_KEY?.trim()) return geminiProvider;
  if (process.env.ANTHROPIC_API_KEY?.trim()) return claudeProvider;
  if (process.env.OPENAI_API_KEY?.trim()) return openaiProvider;
  if (process.env.GROQ_API_KEY?.trim()) return groqProvider;
  return null;
}
```

Also replace the stale SECURITY paragraph at lines 55-60 (D8d — the hole it describes was closed by `app/api/verify/route.ts`'s trusted-sample gate, already in the codebase):

```ts
 * SECURITY (address in Task 12 — the /api/verify route): tier selection here trusts `filename`,
 * which is user-controlled on uploads. An upload named e.g. "old-tom-clean.png" would be routed to
 * the mock tier and return fixture data for a DIFFERENT label. The route must pass a trusted signal
 * (an explicit "this is a bundled gallery sample" flag / sample id) rather than let an uploaded
 * filename reach `isMockSample`. Narrowing the fixture set alone does not close this — the name is
 * still spoofable.
```

with:

```ts
 * SECURITY (closed): tier selection here trusts `filename`, which is user-controlled on uploads, so
 * `selectProvider` alone cannot safely be handed a raw upload name. The fix lives at the call site:
 * app/api/verify/route.ts's trusted-sample gate only forwards a filename when the client says
 * `source=sample` AND the uploaded bytes hash-match a genuine bundled sample (`isGenuineSample`) —
 * every other upload gets `undefined` here, so it can never resolve to the mock tier no matter what
 * it's named.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test select.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Sabotage check**

Temporarily move the `AWS_BEARER_TOKEN_BEDROCK` check back to last, run `pnpm test select.test.ts`, confirm "Bedrock takes priority over every other cloud key" goes red, then restore. Temporarily change `AWS_BEARER_TOKEN_BEDROCK?.trim()` back to plain truthiness, run again, confirm "treats a whitespace-only key as absent" goes red, then restore.

- [ ] **Step 6: Doc sweep (D1 + D8d)**

In `.env.example`, replace lines 17-21:

```
# GEMINI_API_KEY=            # enables Gemini (default cloud tier); optional GEMINI_MODEL
# ANTHROPIC_API_KEY=         # enables Claude; optional ANTHROPIC_MODEL
# OPENAI_API_KEY=            # enables OpenAI; optional OPENAI_MODEL
# GROQ_API_KEY=              # enables Groq (free tier); optional GROQ_MODEL
# AWS_BEARER_TOKEN_BEDROCK=  # enables the Bedrock cloud tier (Llama 4 Maverick by default — best of several models measured on the real-world eval set); optional BEDROCK_REGION (default us-east-2), BEDROCK_MODEL, BEDROCK_TIMEOUT_MS
```

with (Bedrock first, and its stale model name fixed per D8d):

```
# AWS_BEARER_TOKEN_BEDROCK=  # enables the Bedrock cloud tier (default cloud tier; Claude Haiku 4.5 by default — best of several models measured on the real-world eval set); optional BEDROCK_REGION (default us-east-2), BEDROCK_MODEL, BEDROCK_TIMEOUT_MS
# GEMINI_API_KEY=            # enables Gemini; optional GEMINI_MODEL
# ANTHROPIC_API_KEY=         # enables Claude; optional ANTHROPIC_MODEL
# OPENAI_API_KEY=            # enables OpenAI; optional OPENAI_MODEL
# GROQ_API_KEY=              # enables Groq (free tier); optional GROQ_MODEL
```

Also update line 10's enum listing for consistency:

```
# Force a tier: mock | local-ocr | local-llm | gemini | claude | openai | groq | bedrock (default: auto)
```

to:

```
# Force a tier: mock | local-ocr | local-llm | bedrock | gemini | claude | openai | groq (default: auto)
```

In `README.md`, replace line 30's tier table row:

```
| `cloud` (`gemini` / `claude` / `openai` / `groq` / `bedrock`) | an API key | Vision LLM — best accuracy, bounding boxes, judgment |
```

with:

```
| `cloud` (`bedrock` / `gemini` / `claude` / `openai` / `groq`) | an API key | Vision LLM — best accuracy, bounding boxes, judgment |
```

Replace lines 92-95:

```
Optional cloud tier: copy `.env.example` to `.env.local` and set one of `GEMINI_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY` (optional `GROQ_MODEL`), or
`AWS_BEARER_TOKEN_BEDROCK` (optional `BEDROCK_REGION`, default `us-east-2`, `BEDROCK_MODEL`,
`BEDROCK_TIMEOUT_MS`).
```

with:

```
Optional cloud tier: copy `.env.example` to `.env.local` and set `AWS_BEARER_TOKEN_BEDROCK` (the
default cloud tier; optional `BEDROCK_REGION`, default `us-east-2`, `BEDROCK_MODEL`,
`BEDROCK_TIMEOUT_MS`), or one of `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GROQ_API_KEY` (optional `GROQ_MODEL`).
```

In `docs/ARCHITECTURE.md`, replace line 25's cell text `cloud (Gemini default, Claude, OpenAI, Groq, Bedrock adapters)` with `cloud (Bedrock default, Gemini, Claude, OpenAI, Groq adapters)` — leave the rest of that row's wording intact.

Replace line 144:

```
| `VISION_PROVIDER` | No | Force a tier: `mock` \| `local-ocr` \| `local-llm` \| `gemini` \| `claude` \| `openai` \| `groq` \| `bedrock`. Default: auto (local-ocr for uploads, mock for samples). |
```

with:

```
| `VISION_PROVIDER` | No | Force a tier: `mock` \| `local-ocr` \| `local-llm` \| `bedrock` \| `gemini` \| `claude` \| `openai` \| `groq`. Default: auto (local-ocr for uploads, mock for samples). |
```

Reorder lines 145-149 so `AWS_BEARER_TOKEN_BEDROCK` is listed first, and fix its stale model name (D8d):

```
| `GEMINI_API_KEY` | No | Enables the Gemini cloud tier. |
| `ANTHROPIC_API_KEY` | No | Enables the Claude cloud tier. |
| `OPENAI_API_KEY` | No | Enables the OpenAI cloud tier. |
| `GROQ_API_KEY` | No | Enables the Groq cloud tier (OpenAI-compatible API, `qwen/qwen3.6-27b` vision model). |
| `AWS_BEARER_TOKEN_BEDROCK` | No | Enables the Bedrock cloud tier (Llama 4 Maverick by default, via the Converse API, bearer-token auth — no AWS SigV4). |
```

with:

```
| `AWS_BEARER_TOKEN_BEDROCK` | No | Enables the Bedrock cloud tier — the default cloud tier (Claude Haiku 4.5 by default, via the Converse API, bearer-token auth — no AWS SigV4). |
| `GEMINI_API_KEY` | No | Enables the Gemini cloud tier. |
| `ANTHROPIC_API_KEY` | No | Enables the Claude cloud tier. |
| `OPENAI_API_KEY` | No | Enables the OpenAI cloud tier. |
| `GROQ_API_KEY` | No | Enables the Groq cloud tier (OpenAI-compatible API, `qwen/qwen3.6-27b` vision model). |
```

And fix line 151's stale default model ID (D8d — the code's actual default, per `lib/vision/cloud/bedrock.ts:11`, has been Claude Haiku 4.5 since the 2026-07-24 model-choice spec):

```
| `BEDROCK_MODEL` | No | Bedrock model ID for the `bedrock` tier (default `us.meta.llama4-maverick-17b-instruct-v1:0` — chosen empirically; see the spec's "Model choice" section for the real-world eval comparison against Nova Lite/Pro and Mistral Pixtral Large). |
```

to:

```
| `BEDROCK_MODEL` | No | Bedrock model ID for the `bedrock` tier (default `us.anthropic.claude-haiku-4-5-20251001-v1:0` — chosen empirically; see `docs/superpowers/specs/2026-07-24-bedrock-nova-cloud-tier-design.md`'s "Model choice" section for the real-world eval comparison). |
```

- [ ] **Step 7: D8d — reconcile the 72%/75% ladder-latency figures**

In `app/api/verify/route.ts:199`, the comment reads:

```
    // ladder genuinely in the path: it costs ~75% more latency and ~55% more model calls, and pushes
```

`README.md` (line 42, 140) and `.env.example` (line 5) both already cite **~72%** (the measured bedrock/synthetic p95 delta from `docs/superpowers/plans/2026-07-24-escalation-eval-results.md`, table row `bedrock, synthetic ... +72% p95`). Change route.ts's `~75%` to `~72%` so all three docs agree:

```
    // ladder genuinely in the path: it costs ~72% more latency and ~55% more model calls, and pushes
```

- [ ] **Step 8: Run the mock eval canary and full suite**

Run: `pnpm eval`
Expected: `13/13`, `8/8` — unchanged (this task touches no matching code).

Run: `pnpm test`
Expected: all green.

- [ ] **Step 9: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`

- [ ] **Step 10: Commit**

```bash
git add lib/vision/select.ts lib/vision/select.test.ts .env.example README.md docs/ARCHITECTURE.md app/api/verify/route.ts
git commit -m "feat: make Bedrock the default cloud tier; harden key checks to .trim()

New priority: bedrock -> gemini -> claude -> openai -> groq (D1). Every selectCloudProvider key
check now .trim()s instead of relying on truthiness (W8). Updates .env.example/README/
ARCHITECTURE docs and removes stale Llama-4-Maverick / already-closed-hole references (D8d)."
```

---

### Task 6: D3 — cloud-primary composition timeout so the fallback can fire, + SDK client timeout/retries

**Files:**

- Modify: `lib/vision/model-extraction.ts:1-5` (new exported constant)
- Modify: `lib/vision/fallback.ts:1-53` (new `withProviderTimeout` export)
- Modify: `app/api/verify/route.ts:1-9,218-223`
- Modify: `lib/vision/cloud/openai.ts:1-14`, `lib/vision/cloud/groq.ts:1-14`, `lib/vision/cloud/claude.ts:1-20`
- Test: `lib/vision/fallback.test.ts` (append), `app/api/verify/route-errors.test.ts` (modify mocks + append), `lib/vision/cloud/openai.test.ts` (append), `lib/vision/cloud/groq.test.ts` (append), `lib/vision/cloud/claude.test.ts` (append)

**Interfaces:**

- Consumes: `EscalatingProvider` from `@/lib/vision/escalation/types` (unchanged).
- Produces: `CLOUD_PRIMARY_TIMEOUT_MS = 5_000` (exported from `lib/vision/model-extraction.ts`); `withProviderTimeout(provider: EscalatingProvider, ms: number): EscalatingProvider` (exported from `lib/vision/fallback.ts`, alongside the existing `withFallback`).

- [ ] **Step 1: Write the failing test for `withProviderTimeout`**

Append to `lib/vision/fallback.test.ts` (add `withProviderTimeout` to the existing import line: `import { withFallback, withProviderTimeout } from "@/lib/vision/fallback";`):

```ts
describe("withProviderTimeout (D3, 2026-07-25 — composition-site cap so withFallback can actually fire)", () => {
  it("resolves normally when the underlying ladder finishes before the deadline", async () => {
    const primary = cloudLadder();
    const { label, trace } = await withProviderTimeout(primary, 5_000).extractWithTrace(IMAGE, META);
    expect(label).toBe(PRIMARY_LABEL);
    expect(trace.tier).toBe("gemini");
  });

  it("rejects once the deadline elapses, so withFallback catches it and degrades to the fallback tier", async () => {
    vi.useFakeTimers();
    // Promise<never>, not a bare new Promise(() => {}): stubLadder's behavior param is typed
    // () => Promise<Outcome>, and Promise<unknown> is not assignable to it under strict TS.
    const hungPrimary = stubLadder("gemini", () => new Promise<never>(() => {}));
    const composed = withFallback(withProviderTimeout(hungPrimary, 5_000), ocrLadder());
    const pending = composed.extractWithTrace(IMAGE, META);
    await vi.advanceTimersByTimeAsync(5_001);
    const { label, trace } = await pending;
    expect(label).toBe(FALLBACK_LABEL);
    expect(trace.tier).toBe("local-ocr");
    vi.useRealTimers();
  });

  it("exposes the wrapped provider's own static name", () => {
    expect(withProviderTimeout(cloudLadder(), 5_000).name).toBe("gemini");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test fallback.test.ts`
Expected: FAIL with `withProviderTimeout is not a function` (or a TypeScript error) — it doesn't exist yet.

- [ ] **Step 3: Implement `withProviderTimeout`**

Append to `lib/vision/fallback.ts`:

```ts
/**
 * Races an EscalatingProvider's own ladder against a hard deadline (review finding W1, D3
 * 2026-07-25 hardening). Compose it OUTSIDE withFallback —
 * `withFallback(withProviderTimeout(primary, ms), fallback)` — so a primary that hangs past `ms`
 * REJECTS and withFallback's own catch treats that exactly like any other primary failure,
 * degrading to the fallback tier instead of riding all the way to the route's outer (longer)
 * timeout. The abandoned primary promise settles in the background; its eventual rejection is
 * swallowed so it can never surface as an unhandled rejection.
 */
export function withProviderTimeout(provider: EscalatingProvider, ms: number): EscalatingProvider {
  function raceTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${provider.name} extraction exceeded ${ms}ms`)), ms);
    });
    promise.catch(() => {});
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  }

  return {
    name: provider.name,
    async extract(image, meta) {
      return raceTimeout(provider.extract(image, meta));
    },
    async extractWithTrace(image, meta, opts) {
      return raceTimeout(provider.extractWithTrace(image, meta, opts));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test fallback.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the shared `CLOUD_PRIMARY_TIMEOUT_MS` constant**

In `lib/vision/model-extraction.ts`, after `export class ExtractionError extends Error {}` (line 4), add:

```ts
/** Route composition-site timeout for a cloud primary before withFallback degrades to local-ocr
 *  (review finding W1, D3 2026-07-25 hardening) — also used as each cloud SDK client's own request
 *  timeout, so an abandoned socket doesn't linger past the race that gave up on it. Single source
 *  of truth: the composition-site cap and the SDK's own timeout must never drift apart. */
export const CLOUD_PRIMARY_TIMEOUT_MS = 5_000;
```

This is a constant declaration, not branching logic — it doesn't need its own failing-test cycle; Steps 6-9 below exercise it through the route-level test.

- [ ] **Step 6: Write the failing route-level test (against the CURRENT, not-yet-fixed route.ts)**

In `app/api/verify/route-errors.test.ts`, replace the shared-mock setup at the top:

```ts
const extract = vi.fn();
vi.mock("@/lib/vision/select", () => ({
  selectProvider: () => ({ name: "gemini", extract }),
  // The route now always constructs a withFallback(primary, providerByName("local-ocr")) wrapper
  // for any auto-detected cloud-tier provider, so providerByName must exist even though these tests
  // don't exercise the fallback path itself. Reusing the same `extract` mock as the fallback target
  // means a primary rejection (e.g. the 429 below) propagates through the fallback attempt too,
  // preserving these tests' original "a provider failure surfaces as X" intent.
  providerByName: () => ({ name: "local-ocr", extract }),
  selectCloudProvider: () => null,
}));
```

with:

```ts
const cloudExtract = vi.fn();
const ocrExtract = vi.fn();
vi.mock("@/lib/vision/select", () => ({
  selectProvider: () => ({ name: "gemini", extract: cloudExtract }),
  // The route always constructs a withFallback(withProviderTimeout(primary, 5s),
  // providerByName("local-ocr")) wrapper for any auto-detected cloud-tier provider (D3, 2026-07-25
  // hardening), so providerByName must exist even in tests that don't exercise the fallback path.
  // A SEPARATE mock from the primary's lets the D3 test below give the two DIFFERENT behavior
  // (primary hangs, fallback succeeds); the pre-existing tests below instead deliberately give
  // both the SAME behavior so a primary failure propagates through the fallback attempt too,
  // preserving their original intent.
  providerByName: () => ({ name: "local-ocr", extract: ocrExtract }),
  selectCloudProvider: () => null,
}));
```

Replace the three existing tests' bodies to use both mocks identically, and add the new D3 test:

```ts
describe("POST /api/verify — failure modes", () => {
  it("maps provider 429s to a friendly rate-limit message", async () => {
    const err = Object.assign(new Error("quota"), { status: 429 });
    cloudExtract.mockRejectedValue(err);
    ocrExtract.mockRejectedValue(err);
    const res = await POST(request());
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/rate-limited/i);
  });
  // The fake-timer tests below drive real async route work (formData, sharp metadata, the deadline race)
  // between clock advances. Under a saturated full-suite run that real work can exceed Vitest's default
  // 5s test wall-clock even though the logic is sound — the intermittent "timed out in 5000ms" flake.
  // A generous per-test timeout removes the load sensitivity without weakening the assertions.
  it("times out with a friendly 504 when even the fallback can't beat the deadline", async () => {
    vi.useFakeTimers();
    cloudExtract.mockImplementation(() => new Promise(() => {}));
    ocrExtract.mockImplementation(() => new Promise(() => {})); // fallback ALSO hangs — this pins the OUTER 8s backstop, not the D3 fallback path
    const pending = POST(request());
    await vi.advanceTimersByTimeAsync(9_000);
    const res = await pending;
    expect(res.status).toBe(504);
    expect((await res.json()).error).toMatch(/took too long/i);
  }, 20_000);
  it("clears the deadline timer when extraction resolves (no leaked timer)", async () => {
    vi.useFakeTimers();
    cloudExtract.mockResolvedValue(MOCK_FIXTURES["old-tom-clean.png"]);
    await POST(request());
    expect(vi.getTimerCount()).toBe(0);
  }, 20_000);
  it("degrades to local-ocr within the route timeout when the PRIMARY cloud provider hangs (D3, 2026-07-25 — not a 504)", async () => {
    vi.useFakeTimers();
    cloudExtract.mockImplementation(() => new Promise(() => {})); // never resolves
    ocrExtract.mockResolvedValue(MOCK_FIXTURES["old-tom-clean.png"]);
    const pending = POST(request());
    // Past the 5s CLOUD_PRIMARY_TIMEOUT_MS composition-site cap, well under the 8s outer backstop.
    await vi.advanceTimersByTimeAsync(6_000);
    const res = await pending;
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tier).toBe("local-ocr");
    expect(body.provider).toBe("local-ocr");
  }, 20_000);
});
```

- [ ] **Step 7: Run the route-level tests to verify the new one fails**

Run: `pnpm test route-errors.test.ts`
Expected: the refactored 429/504/clear-timer tests still PASS (they give `cloudExtract`/`ocrExtract` identical behavior, preserving their original intent); the new "degrades to local-ocr ... (D3, 2026-07-25 — not a 504)" test FAILs with a 504 — `route.ts` doesn't wire in `withProviderTimeout` yet, so the primary hang still rides all the way to the 8s outer timeout.

- [ ] **Step 8: Implement the route.ts wiring**

In `app/api/verify/route.ts`, change line 5:

```ts
import { withFallback } from "@/lib/vision/fallback";
```

to:

```ts
import { withFallback, withProviderTimeout } from "@/lib/vision/fallback";
```

and add a new import line after it (before the escalation import):

```ts
import { CLOUD_PRIMARY_TIMEOUT_MS } from "@/lib/vision/model-extraction";
```

Then replace lines 218-223:

```ts
let escalating = withEscalation(provider, ladderOpts);
if (tierFor(provider.name) === "cloud") {
  escalating = withFallback(escalating, withEscalation(providerByName("local-ocr"), ladderOpts), () => {
    fellBackToLocalOcr = true;
  });
}
```

with:

```ts
let escalating = withEscalation(provider, ladderOpts);
if (tierFor(provider.name) === "cloud") {
  // Composition-site timeout (review finding W1, D3 2026-07-25 hardening): the outer
  // EXTRACT_TIMEOUT_MS below wraps the WHOLE composition, so a primary that hangs past 8s
  // never let withFallback's catch fire before this fix — it just rode straight to the 8s
  // 504. Racing the primary against its own shorter deadline first means a hang REJECTS at
  // 5s, withFallback catches that rejection like any other failure, and local-ocr still has
  // ~3s of the outer budget to run (warm ~372ms, cold ~1409ms — comfortably fits).
  escalating = withFallback(
    withProviderTimeout(escalating, CLOUD_PRIMARY_TIMEOUT_MS),
    withEscalation(providerByName("local-ocr"), ladderOpts),
    () => {
      fellBackToLocalOcr = true;
    },
  );
}
```

- [ ] **Step 9: Run the route-level tests again to verify the new one now passes**

Run: `pnpm test route-errors.test.ts`
Expected: PASS — all four tests in this file green, including "degrades to local-ocr ... (D3, 2026-07-25 — not a 504)".

- [ ] **Step 10: Write the failing tests for the SDK-level guard**

Append to `lib/vision/cloud/openai.test.ts`, after the "surfaces a non-2xx response..." test:

```ts
it("disables the SDK's own automatic retry (maxRetries: 0) — the route owns retry/timeout policy, not the SDK", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-token");
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      chatCompletionResponse(
        { error: { message: "Rate limited", type: "rate_limit_error" } },
        { status: 429, statusText: "Too Many Requests" },
      ),
    );
  vi.stubGlobal("fetch", fetchMock);

  await expect(openaiProvider.extract(IMAGE, META)).rejects.toThrow(/429/);
  // The OpenAI SDK retries a 429 twice more by default (3 total calls) unless maxRetries: 0.
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
```

Append to `lib/vision/cloud/groq.test.ts`:

```ts
it("disables the SDK's own automatic retry (maxRetries: 0) — the route owns retry/timeout policy, not the SDK", async () => {
  vi.stubEnv("GROQ_API_KEY", "test-groq-key");
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(groqProvider.extract(IMAGE, META)).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
```

Append to `lib/vision/cloud/claude.test.ts` (add `CLOUD_PRIMARY_TIMEOUT_MS` to its `model-extraction` import):

```ts
import { EXTRACTION_PROMPT, CLOUD_PRIMARY_TIMEOUT_MS } from "@/lib/vision/model-extraction";
```

```ts
it("configures the SDK client with maxRetries: 0 and the shared cloud-primary timeout (D3, 2026-07-25)", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  createMock.mockResolvedValue(textResponse(VALID_CONTENT));

  await claudeProvider.extract(IMAGE, META);

  expect(constructorMock).toHaveBeenCalledWith(
    expect.objectContaining({ maxRetries: 0, timeout: CLOUD_PRIMARY_TIMEOUT_MS }),
  );
});
```

- [ ] **Step 11: Run the new SDK-level tests to verify they fail**

Run: `pnpm test openai.test.ts groq.test.ts claude.test.ts`
Expected: the three new tests FAIL — `fetchMock` called 3 times (not 1) on the 429 cases (the SDK's default retry hasn't been disabled yet); `constructorMock` called with no arguments for claude (not yet passed `{ maxRetries: 0, timeout: ... }`).

- [ ] **Step 12: Implement the SDK constructor changes**

In `lib/vision/cloud/openai.ts`, change the import line:

```ts
import { EXTRACTION_PROMPT, extractWithModel } from "@/lib/vision/model-extraction";
```

to:

```ts
import { EXTRACTION_PROMPT, extractWithModel, CLOUD_PRIMARY_TIMEOUT_MS } from "@/lib/vision/model-extraction";
```

and change:

```ts
const client = new OpenAI();
```

to:

```ts
// maxRetries: 0 — the route's own withProviderTimeout/withFallback composition (D3, 2026-07-25
// hardening) owns retry and timeout policy now; the SDK's default 2 automatic retries on
// 429/5xx would otherwise keep retrying in the background past the route's 5s composition-site
// deadline, after the route has already moved on to the fallback. `timeout` bounds that same
// socket so it can't linger past the race either.
const client = new OpenAI({ timeout: CLOUD_PRIMARY_TIMEOUT_MS, maxRetries: 0 });
```

In `lib/vision/cloud/groq.ts`, same import change, and:

```ts
const client = new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });
```

to:

```ts
const client = new OpenAI({
  apiKey,
  baseURL: "https://api.groq.com/openai/v1",
  timeout: CLOUD_PRIMARY_TIMEOUT_MS,
  maxRetries: 0,
});
```

In `lib/vision/cloud/claude.ts`, change:

```ts
import { EXTRACTION_PROMPT, extractWithModel } from "@/lib/vision/model-extraction";
```

to:

```ts
import { EXTRACTION_PROMPT, extractWithModel, CLOUD_PRIMARY_TIMEOUT_MS } from "@/lib/vision/model-extraction";
```

and:

```ts
const client = new Anthropic();
```

to:

```ts
const client = new Anthropic({ timeout: CLOUD_PRIMARY_TIMEOUT_MS, maxRetries: 0 });
```

- [ ] **Step 13: Run the SDK-level tests again to verify they pass**

Run: `pnpm test openai.test.ts groq.test.ts claude.test.ts`
Expected: PASS — all three new tests green, and every pre-existing assertion in these three files still green.

- [ ] **Step 14: Run the mock eval canary and full suite**

Run: `pnpm eval`
Expected: `13/13`, `8/8` — unchanged (mock tier never touches these adapters).

Run: `pnpm test`
Expected: all green, including the pre-existing `route.escalation.test.ts` and `route.test.ts` suites (neither mocks `openai`/`groq`/`anthropic-ai/sdk` directly, so the constructor option additions don't affect them).

- [ ] **Step 15: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`

- [ ] **Step 16: Commit**

```bash
git add lib/vision/model-extraction.ts lib/vision/fallback.ts lib/vision/fallback.test.ts \
  app/api/verify/route.ts app/api/verify/route-errors.test.ts \
  lib/vision/cloud/openai.ts lib/vision/cloud/openai.test.ts \
  lib/vision/cloud/groq.ts lib/vision/cloud/groq.test.ts \
  lib/vision/cloud/claude.ts lib/vision/cloud/claude.test.ts
git commit -m "fix: cap the cloud primary at 5s inside the fallback composition (D3)

The 8s route timeout wrapped OUTSIDE withFallback, so a hung cloud provider rode to a 504
instead of degrading to local-ocr. withProviderTimeout races the primary against
CLOUD_PRIMARY_TIMEOUT_MS=5000 so withFallback's own catch fires in time, leaving ~3s of the
outer budget for local-ocr. Also sets maxRetries: 0 + an explicit client timeout on the
openai/groq/claude SDK constructors so abandoned sockets don't outlive the race. W1, D3,
GS-15 hardening spec."
```

---

### Task 7: D4 — Gemini adapter test suite

**Files:**

- Create: `lib/vision/cloud/gemini.test.ts`

**Interfaces:**

- Consumes: `geminiProvider` from `@/lib/vision/cloud/gemini` (existing, unmodified by this task); `ExtractionError` from `@/lib/vision/model-extraction`; `MOCK_FIXTURES` from `@/lib/vision/mock`.
- Produces: nothing new (test-only task).

- [ ] **Step 1: Write the test file (mirrors `claude.test.ts`'s direct-class-mock pattern, since `@google/generative-ai` — like `@anthropic-ai/sdk` — is a thin class wrapper the adapter constructs directly, unlike openai.ts/groq.ts's real-fetch-mocking style)**

Create `lib/vision/cloud/gemini.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtractionError, EXTRACTION_PROMPT } from "@/lib/vision/model-extraction";
import { MOCK_FIXTURES } from "@/lib/vision/mock";

const IMAGE = Buffer.from("fake-image-bytes");
const META = { filename: "upload.png", mimeType: "image/png" };
const VALID_CONTENT = JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]);

const generateContentMock = vi.fn();
const getGenerativeModelMock = vi.fn(() => ({ generateContent: generateContentMock }));
const constructorMock = vi.fn();
vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class FakeGoogleGenerativeAI {
    constructor(...args: unknown[]) {
      constructorMock(...args);
    }
    getGenerativeModel = getGenerativeModelMock;
  },
}));

import { geminiProvider } from "@/lib/vision/cloud/gemini";

function textResult(text: string) {
  return { response: { text: () => text } };
}

afterEach(() => {
  vi.unstubAllEnvs();
  generateContentMock.mockReset();
  getGenerativeModelMock.mockClear();
  constructorMock.mockReset();
});

describe("geminiProvider", () => {
  it("fails fast when GEMINI_API_KEY is unset, without touching the SDK", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    await expect(geminiProvider.extract(IMAGE, META)).rejects.toThrow(/GEMINI_API_KEY/);
    expect(constructorMock).not.toHaveBeenCalled();
  });

  it("fails fast when GEMINI_API_KEY is whitespace-only (malformed)", async () => {
    vi.stubEnv("GEMINI_API_KEY", "   ");
    await expect(geminiProvider.extract(IMAGE, META)).rejects.toThrow(/GEMINI_API_KEY/);
    expect(constructorMock).not.toHaveBeenCalled();
  });

  it("sends the extraction request contract (inline image data + prompt) to the model", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    generateContentMock.mockResolvedValue(textResult(VALID_CONTENT));

    await geminiProvider.extract(IMAGE, META);

    const parts = generateContentMock.mock.calls[0][0];
    expect(parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: IMAGE.toString("base64") } });
    expect(parts[1]).toBe(EXTRACTION_PROMPT);
  });

  it("uses the GEMINI_MODEL override when set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODEL", "gemini-2.0-flash");
    generateContentMock.mockResolvedValue(textResult(VALID_CONTENT));

    await geminiProvider.extract(IMAGE, META);

    expect(getGenerativeModelMock.mock.calls[0][0].model).toBe("gemini-2.0-flash");
  });

  it("parses a valid response into an ExtractedLabel", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    generateContentMock.mockResolvedValue(textResult(VALID_CONTENT));

    const r = await geminiProvider.extract(IMAGE, META);
    expect(r.brandName.value).toBe("OLD TOM DISTILLERY");
    expect(r.brandName.present).toBe(true);
  });

  it("retries once on malformed JSON, then fails closed with ExtractionError after exactly 2 calls", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    generateContentMock.mockResolvedValue(textResult("not json"));

    await expect(geminiProvider.extract(IMAGE, META)).rejects.toBeInstanceOf(ExtractionError);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a safety-block as a rejection rather than a silent empty extraction, without retrying", async () => {
    // Unlike the other adapters (which read "" from a malformed/blocked response and let
    // extractWithModel's JSON.parse fail, then retry), @google/generative-ai's response.text()
    // THROWS when a candidate was blocked for safety — a different failure shape that must
    // propagate unwrapped, exactly like the other adapters' 401/429 call()-level failures.
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    generateContentMock.mockResolvedValue({
      response: {
        text: () => {
          throw new Error("Response was blocked due to SAFETY");
        },
      },
    });

    await expect(geminiProvider.extract(IMAGE, META)).rejects.toThrow(/SAFETY/);
    await expect(geminiProvider.extract(IMAGE, META)).rejects.not.toBeInstanceOf(ExtractionError);
    expect(generateContentMock).toHaveBeenCalledTimes(2); // one call per extract() invocation above — never retried
  });
});
```

- [ ] **Step 2: Run the test file**

Run: `pnpm test gemini.test.ts`
Expected: PASS on every test against the current `lib/vision/cloud/gemini.ts` (this is a pure test-addition task — no adapter code changes).

- [ ] **Step 3: Sabotage check on the retry-count guard**

Temporarily change `extractWithModel`'s retry loop bound in `lib/vision/model-extraction.ts` from `attempt < 2` to `attempt < 1`, run `pnpm test gemini.test.ts`, confirm "retries once on malformed JSON..." goes red (expects 2 calls, gets 1), then restore. This also re-confirms the same guard for every other adapter's suite (`openai.test.ts`, `groq.test.ts`, `claude.test.ts`) — run `pnpm test` broadly and confirm several suites go red, then restore.

- [ ] **Step 4: Run the mock eval canary**

Run: `pnpm eval`
Expected: `13/13`, `8/8` — unchanged.

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`

- [ ] **Step 6: Commit**

```bash
git add lib/vision/cloud/gemini.test.ts
git commit -m "test: add gemini.test.ts — the only cloud adapter that shipped without one

Mirrors claude.test.ts's direct-class-mock pattern (the @google/generative-ai SDK, like
@anthropic-ai/sdk, is a thin class the adapter constructs directly). Covers missing/whitespace
key, the extraction request contract, GEMINI_MODEL override, malformed-JSON retry-then-fail,
and the safety-block failure shape unique to this SDK (response.text() throws). D4, GS-15
hardening spec."
```

---

### Task 8: D6a — `--min-overall` eval gate + CI accuracy floor

**Files:**

- Modify: `eval/run.ts:70-89,249-257`
- Modify: `.github/workflows/ci.yml:71`

**Interfaces:**

- Consumes: nothing new.
- Produces: `eval/run.ts` gains a `--min-overall <n>` CLI flag; no exported function signatures change (it's a script, not a module).

- [ ] **Step 1: Implement the flag and the gate**

In `eval/run.ts`, after the `--only` flag parsing (around line 108-109):

```ts
const onlyIndex = process.argv.indexOf("--only");
const onlyFiles = onlyIndex >= 0 ? new Set(process.argv[onlyIndex + 1].split(",")) : null;
```

add:

```ts
// D6a (2026-07-25 hardening): a non-tautological accuracy floor for CI. Unlike the mock-tier
// gate (which only proves the matcher, since the mock tier's fixtures are fixed), this can run
// against ANY set/provider combination — CI uses it on real-world/local-ocr, which is keyless
// and deterministic (reproduces 23/46 to the integer across runs).
const minOverallIndex = process.argv.indexOf("--min-overall");
const minOverall = minOverallIndex >= 0 ? Number(process.argv[minOverallIndex + 1]) : null;
```

Then, after `await recordRun({ summary, details });` (line 247) and before the existing mock-tier gate (`if (setName === "default" && provider.name === "mock" && ...)`), add:

```ts
if (minOverall !== null && overallCorrect < minOverall) {
  console.error(`\nFAIL: overall correct ${overallCorrect}/${entries.length} is below --min-overall ${minOverall}.`);
  process.exit(1);
}
```

- [ ] **Step 2: Verify manually (this is a script, not a unit-testable module — verify by running it directly)**

Run: `pnpm eval --set real-world --provider local-ocr --min-overall 999`
Expected: exits with code 1 and prints `FAIL: overall correct <n>/46 is below --min-overall 999.` (46 is unreachable, so this must always fail — confirms the gate fires).

Run: `pnpm eval --set real-world --provider local-ocr --min-overall 1`
Expected: exits with code 0 (local-ocr reliably scores well above 1/46).

Run: `pnpm eval --set real-world --provider local-ocr --min-overall 22`
Expected: exits with code 0, printing `overall verdict accuracy: 23/46 (50%)` (or the current deterministic local-ocr score, which must be >= 22 for this to pass — if it's ever below 22, that is itself a real regression to investigate before proceeding, not a plan bug).

- [ ] **Step 3: Add the CI step**

In `.github/workflows/ci.yml`, after the existing line 71 (`- run: pnpm eval --provider mock`) and before line 72's adversarial-gate comment, add:

```yaml
# Accuracy floor (D6a, 2026-07-25): local-ocr must score at least 22/46 on the real-world set
# (keyless, deterministic — reproduces 23/46 to the integer across runs). CI's first
# non-tautological accuracy gate — the mock gate above only proves the matcher, since the
# mock tier's fixtures never change.
- run: pnpm eval --set real-world --provider local-ocr --min-overall 22
```

- [ ] **Step 4: Run the mock eval canary and full suite**

Run: `pnpm eval`
Expected: `13/13`, `8/8` — unchanged (the new flag is opt-in via `--min-overall`; omitting it changes nothing).

Run: `pnpm test`
Expected: all green (no test file touches `eval/run.ts` directly, so this task has no unit-test surface beyond the manual verification in Step 2).

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`

- [ ] **Step 6: Commit**

```bash
git add eval/run.ts .github/workflows/ci.yml
git commit -m "feat: add --min-overall accuracy floor to eval/run.ts; gate CI on local-ocr real-world

CI's only accuracy gate was the mock tier, which is near-tautological (fixed fixtures always
score 100%). Adds a real-world/local-ocr floor (22/46, keyless and deterministic) as CI's first
non-tautological accuracy gate. D6a, GS-15 hardening spec."
```

---

### Task 9: D6c — trend-reporting honesty (escalation/subset markers, 0/0 → n/a)

**Files:**

- Create: `eval/format.ts`
- Test: `eval/format.test.ts`
- Modify: `eval/print-history.ts:1-102`
- Modify: `eval/print-history.test.ts` (append)
- Modify: `eval/run.ts:212-220`

**Interfaces:**

- Consumes: nothing new.
- Produces: `formatRatioPct(caught: number, total: number): string` (exported from new `eval/format.ts`) — returns `"n/a"` when `total === 0`, else `"<pct>%"`. `HistoryEntry` (exported from `eval/print-history.ts`) gains `escalation?: boolean` and `subset?: boolean` optional fields.

- [ ] **Step 1: Write the failing test for the shared helper**

Create `eval/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatRatioPct } from "@/eval/format";

describe("formatRatioPct", () => {
  it("renders a percentage when total > 0", () => {
    expect(formatRatioPct(8, 8)).toBe("100%");
    expect(formatRatioPct(3, 4)).toBe("75%");
  });
  it("renders n/a for a 0/0 ratio instead of a misleading 100% (D6c, 2026-07-25)", () => {
    expect(formatRatioPct(0, 0)).toBe("n/a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test format.test.ts`
Expected: FAIL — `eval/format.ts` doesn't exist yet.

- [ ] **Step 3: Implement the helper**

Create `eval/format.ts`:

```ts
/** Shared "n/a" convention for a caught/total ratio with an empty denominator (both eval/run.ts
 *  and eval/print-history.ts render this). 0/0 means "no violations were planted in this set", not
 *  "100% caught" — rendering it as 100% silently misreads as a perfect security result. D6c,
 *  2026-07-25 hardening. */
export function formatRatioPct(caught: number, total: number): string {
  return total === 0 ? "n/a" : `${Math.round((caught / total) * 100)}%`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test format.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for print-history's markers and n/a rendering**

Append to `eval/print-history.test.ts`, inside `describe("formatHistoryTable", ...)`:

```ts
it("tags a ladder-on run with [ladder] so it's distinguishable from a clean run (D6c, 2026-07-25)", () => {
  const table = formatHistoryTable([{ ...ENTRY_A, escalation: true }], 20);
  expect(table).toContain("mock/default [ladder]");
});
it("tags a --only subset run with [subset]", () => {
  const table = formatHistoryTable([{ ...ENTRY_A, subset: true }], 20);
  expect(table).toContain("mock/default [subset]");
});
it("tags a run that is both ladder-on and a subset with [ladder, subset]", () => {
  const table = formatHistoryTable([{ ...ENTRY_A, escalation: true, subset: true }], 20);
  expect(table).toContain("mock/default [ladder, subset]");
});
it("omits the tag entirely for a clean full run (no escalation, no subset)", () => {
  const table = formatHistoryTable([ENTRY_A], 20);
  expect(table).not.toContain("[ladder");
  expect(table).not.toContain("[subset");
});
it("renders n/a, not 100%, for a 0/0 planted-violations ratio", () => {
  const noViolations: HistoryEntry = { ...ENTRY_A, violationsCaught: 0, violationsTotal: 0 };
  const table = formatHistoryTable([noViolations], 20);
  expect(table).toContain("violations 0/0 (n/a)");
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `pnpm test print-history.test.ts`
Expected: FAIL — `HistoryEntry` doesn't yet accept `escalation`/`subset` (TypeScript error on the object literals), and the current table never renders `[ladder]`/`[subset]` tags or `n/a`.

- [ ] **Step 7: Implement in `eval/print-history.ts`**

Add the two optional fields to the `HistoryEntry` interface:

```ts
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
  escalation?: boolean;
  subset?: boolean;
  bySubset?: { real: { correct: number; total: number }; degraded: { correct: number; total: number } };
}
```

Add the import at the top of the file:

```ts
import { formatRatioPct } from "@/eval/format";
```

Replace `formatHistoryTable`:

```ts
export function formatHistoryTable(entries: HistoryEntry[], limit: number): string {
  const rows = entries.slice(-limit);
  if (rows.length === 0) return "No matching history entries found.";
  return rows
    .map((e) => {
      const sha = e.gitSha ? e.gitSha.slice(0, 7) + (e.dirty ? "*" : "") : "unknown";
      const overallPct = e.overallTotal === 0 ? 100 : Math.round((e.overallCorrect / e.overallTotal) * 100);
      const violationPct = formatRatioPct(e.violationsCaught, e.violationsTotal);
      const perField = Object.entries(e.perField)
        .map(([field, stat]) => `${field} ${stat.correct}/${stat.total}`)
        .join(" · ");
      const subsetLine = e.bySubset
        ? `\n  real ${e.bySubset.real.correct}/${e.bySubset.real.total} · degraded ${e.bySubset.degraded.correct}/${e.bySubset.degraded.total}`
        : "";
      // Markers (D6c, 2026-07-25): escalation/subset are recorded on every RunSummary but were
      // previously dropped from the printed table, making a ladder-on run or a --only subset run
      // visually indistinguishable from a clean full run at a glance.
      const markers = [e.escalation ? "ladder" : null, e.subset ? "subset" : null].filter(Boolean).join(", ");
      const tag = markers ? ` [${markers}]` : "";
      return (
        `${e.timestamp}  ${sha}  ${e.provider}/${e.set}${tag}  ` +
        `overall ${e.overallCorrect}/${e.overallTotal} (${overallPct}%)  ` +
        `violations ${e.violationsCaught}/${e.violationsTotal} (${violationPct})\n  ${perField}${subsetLine}`
      );
    })
    .join("\n\n");
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm test print-history.test.ts`
Expected: PASS — new tests green; pre-existing tests (e.g. `overall 13/13 (100%)`) still green since `overallPct` is untouched.

- [ ] **Step 9: Sabotage check**

Temporarily revert `violationPct` to `e.violationsTotal === 0 ? 100 : Math.round(...)` inline (bypassing `formatRatioPct`), run `pnpm test print-history.test.ts`, confirm the "renders n/a" test goes red, then restore. Temporarily delete the `markers`/`tag` lines (rendering nothing extra), confirm the three tag tests go red, then restore.

- [ ] **Step 10: Apply the same 0/0 fix in `eval/run.ts`**

In `eval/run.ts`, add the import:

```ts
import { formatRatioPct } from "@/eval/format";
```

Replace line 213:

```ts
const violationPct = violationsTotal === 0 ? 100 : Math.round((violationsCaught / violationsTotal) * 100);
```

with:

```ts
const violationPct = formatRatioPct(violationsCaught, violationsTotal);
```

Replace line 220:

```ts
console.log(`planted violations caught: ${violationsCaught}/${violationsTotal} (${violationPct}%)`);
```

with:

```ts
console.log(`planted violations caught: ${violationsCaught}/${violationsTotal} (${violationPct})`);
```

- [ ] **Step 11: Verify manually**

Run: `pnpm eval`
Expected: prints `planted violations caught: 8/8 (100%)` — same rendering as before for the non-zero case, now backed by the shared, unit-tested helper.

- [ ] **Step 12: Run the mock eval canary and full suite**

Run: `pnpm eval`
Expected: `13/13`, `8/8` — unchanged.

Run: `pnpm test`
Expected: all green.

- [ ] **Step 13: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`

- [ ] **Step 14: Commit**

```bash
git add eval/format.ts eval/format.test.ts eval/print-history.ts eval/print-history.test.ts eval/run.ts
git commit -m "fix: render 0/0 planted violations as n/a, not a misleading 100%; show ladder/subset markers

Extracts a shared formatRatioPct(caught, total) used by both eval/run.ts and
eval/print-history.ts. print-history.ts also now tags ladder-on and --only subset runs
([ladder]/[subset]), previously indistinguishable from a clean full run in the printed table.
D6c, GS-15 hardening spec."
```

---

### Task 10: D7 — widen the escalation lint boundary to the health-warning answer key

**Files:**

- Modify: `eslint.config.mjs:41-67`

**Interfaces:**

- Consumes: nothing new (ESLint config only).
- Produces: nothing new — this is a lint-rule change, verified by the repo's own "sabotage the guard" standard rather than a Vitest test.

- [ ] **Step 1: Implement the widened restriction**

In `eslint.config.mjs`, replace the `patterns` array inside the `lib/vision/escalation/**` override:

```js
      patterns: [
        {
          group: ["@/lib/matching/fuzzy", "@/lib/matching/numeric", "@/lib/matching/warning"],
          message: "The escalation ladder must not consume matching rules (spec §3.2).",
        },
      ],
```

with:

```js
      patterns: [
        {
          group: ["@/lib/matching/fuzzy", "@/lib/matching/numeric", "@/lib/matching/warning"],
          message: "The escalation ladder must not consume matching rules (spec §3.2).",
        },
        {
          group: ["@/lib/ttb/warning", "@/lib/ttb/warning-diff"],
          message:
            "The escalation ladder must not see the canonical health warning text or its diff (D7, GS-15 hardening, 2026-07-25) — a ladder that could compare its own re-read against the known-correct answer could retry toward it, manufacturing a PASS on a forged/corrected warning instead of an honest low-confidence transcription.",
        },
      ],
```

- [ ] **Step 2: Verify by sabotage (the repo's own non-tautology standard for config, not a unit test)**

Temporarily add a throwaway import to `lib/vision/escalation/escalate.ts` (any line inside the file, e.g. right after the existing imports):

```ts
import { HEALTH_WARNING_TEXT } from "@/lib/ttb/warning";
```

Run: `pnpm lint`
Expected: FAIL — ESLint reports a `no-restricted-imports` error on that line, citing the new message.

Revert the throwaway import (`git checkout -- lib/vision/escalation/escalate.ts`, or manually delete the line — confirm with `git diff lib/vision/escalation/escalate.ts` that it's empty before proceeding).

- [ ] **Step 3: Run the mock eval canary and full suite**

Run: `pnpm eval`
Expected: `13/13`, `8/8` — unchanged (no runtime code changed).

Run: `pnpm test`
Expected: all green.

- [ ] **Step 4: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: clean (no restricted import actually present after Step 2's revert).

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs
git commit -m "harden: extend the escalation lint boundary to lib/ttb/warning(-diff)

The ladder's no-restricted-imports boundary blocked the matchers but not the canonical
HEALTH_WARNING_TEXT constant or its diff — the one answer key a retry-toward-PASS loop could
converge against. D7, GS-15 hardening spec."
```

---

### Task 11: D8a — fix `security-audit.yml` before it lands; D8b — verify coverage dumps stay untracked

**Files:**

- Modify: `.github/workflows/security-audit.yml` (currently staged with the pre-hardening flaws the review flagged; the file is not yet committed)
- Verify only (no changes expected): `.gitignore`, tracked-file list

**Interfaces:** none (CI config + repo hygiene only).

⚠ **Note on current repo state:** `git status` shows `.gitignore` already has an uncommitted `/coverage*.txt` line staged, and `git ls-files | grep -i coverage` returns no coverage-dump files — so **D8b is already effectively satisfied** in the working tree; this task's job is to confirm that and fold it into the same commit, not to redo it. `security-audit.yml` is staged (`git status` shows `A`) but its **content** is still the flawed pre-hardening version (verified by reading it) — that part of D8a genuinely needs fixing.

- [ ] **Step 1: Confirm current state**

Run: `git status --short .gitignore coverage-full.txt coverage-output.txt coverage-output-full.txt 2>&1; git ls-files | grep -i coverage`
Expected: `.gitignore` shows as modified (` M .gitignore`); the three `coverage-*.txt` filenames print nothing from either command (they are untracked AND ignored, so they don't appear in `git status --short` at all, and `git ls-files` never lists them).

Run: `grep -n "coverage" .gitignore`
Expected: shows `/coverage` and `/coverage*.txt` both present.

If either check fails (a `coverage*.txt` file IS tracked), run `git rm --cached <file>` for each tracked one before continuing.

- [ ] **Step 2: Fix `security-audit.yml`**

Replace the full contents of `.github/workflows/security-audit.yml`:

```yaml
name: Security Audit

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

# Least privilege for GITHUB_TOKEN: this workflow only reads the repo.
permissions:
  contents: read

# Don't pile up runs: a newer push to the same ref cancels the older in-flight one.
concurrency:
  group: security-audit-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # Supply-chain gate (threat model A03): fail on a high/critical advisory in a SHIPPED dep —
      # matches ci.yml's own audit step exactly (--prod excludes devDependency-only advisories,
      # which can't reach a deployed instance).
      - run: pnpm audit --prod --audit-level=high
```

The SHA pins above are copied verbatim from `.github/workflows/ci.yml:23-27` (`actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`, `pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0`, `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0`).

- [ ] **Step 3: Verify the workflow is syntactically valid**

Run: `pnpm exec actionlint .github/workflows/security-audit.yml 2>&1 || echo "actionlint not installed — falling back to YAML parse check"`

If `actionlint` isn't available, at minimum verify the file parses as YAML:

Run: `node -e "console.log(require('yaml').parse(require('fs').readFileSync('.github/workflows/security-audit.yml','utf8')) ? 'valid YAML' : 'invalid')" 2>&1 || node -e "const fs=require('fs'); JSON.stringify(fs.readFileSync('.github/workflows/security-audit.yml','utf8').split('\n').length); console.log('file readable, manual review required for YAML validity')"`

Expected: no syntax errors reported.

- [ ] **Step 4: Run the mock eval canary and full suite**

Run: `pnpm eval`
Expected: `13/13`, `8/8` — unchanged (no application code touched).

Run: `pnpm test`
Expected: all green.

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/security-audit.yml .gitignore
git commit -m "fix: pin security-audit.yml to ci.yml's SHA/permissions discipline; add --prod

security-audit.yml used mutable action tags, no permissions/timeout-minutes/concurrency, and
ran pnpm audit without --prod — regressing findings the 2026-07-21 audit recorded as closed.
Also confirms coverage*.txt dumps stay untracked (.gitignore's /coverage*.txt entry, already
present in the working tree, closes a known accidental-secret channel). D8a + D8b, GS-15
hardening spec."
```

---

### Task 12: D8c — gate `devTier`/`devBedrockModel`/`escalate` behind `DEV_CONTROLS_ENABLED`

**Files:**

- Modify: `app/api/verify/route.ts:149-155,213`
- Modify: `.env.example`
- Modify: `docs/ARCHITECTURE.md:315`
- Modify: `app/api/verify/route.test.ts` (extend `request()` overrides + append tests)

**Interfaces:**

- Consumes: nothing new.
- Produces: no exported signature changes — `POST` still `(req: Request) => Promise<Response>`. New server env var `DEV_CONTROLS_ENABLED` (string `"1"` to force-enable in production; always implicitly on outside production).

- [ ] **Step 1: Extend the test request helper and write the failing tests**

In `app/api/verify/route.test.ts`, add `escalate?: string` to the `request()` overrides type and body:

```ts
function request(
  overrides: {
    filename?: string;
    type?: string;
    size?: number;
    application?: string;
    magic?: number[];
    source?: string;
    bytes?: Uint8Array;
    devTier?: string;
    devBedrockModel?: string;
    escalate?: string;
  } = {},
) {
  const fd = new FormData();
  let bytes = overrides.bytes;
  if (!bytes) {
    bytes = new Uint8Array(overrides.size ?? 64);
    bytes.set(overrides.magic ?? PNG_MAGIC, 0);
  }
  fd.set(
    "image",
    new File([new Uint8Array(bytes)], overrides.filename ?? "old-tom-clean.png", {
      type: overrides.type ?? "image/png",
    }),
  );
  fd.set("application", overrides.application ?? JSON.stringify(app));
  if (overrides.source !== undefined) fd.set("source", overrides.source);
  if (overrides.devTier !== undefined) fd.set("devTier", overrides.devTier);
  if (overrides.devBedrockModel !== undefined) fd.set("devBedrockModel", overrides.devBedrockModel);
  if (overrides.escalate !== undefined) fd.set("escalate", overrides.escalate);

  const contentLength = String(bytes.length + 1024);
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? contentLength : null) },
    formData: async () => fd,
  } as unknown as Request;
}
```

Append a new describe block at the end of the file, before the final `describe("GET /api/verify", ...)` block:

```ts
describe("POST /api/verify — DEV_CONTROLS_ENABLED gates dev-only fields (D8c, 2026-07-25)", () => {
  it("in production without DEV_CONTROLS_ENABLED, a devTier field is rejected with 400", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await POST(request({ bytes: OLD_TOM, devTier: "local-ocr" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/developer controls/i);
  });
  it("in production without DEV_CONTROLS_ENABLED, a devBedrockModel field is rejected with 400", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await POST(request({ bytes: OLD_TOM, devBedrockModel: "haiku" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/developer controls/i);
  });
  it("in production without DEV_CONTROLS_ENABLED, an escalate field is rejected with 400", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await POST(request({ bytes: OLD_TOM, escalate: "1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/developer controls/i);
  });
  it("in production WITH DEV_CONTROLS_ENABLED=1, devTier works exactly as in development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_CONTROLS_ENABLED", "1");
    mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } });
    const res = await POST(request({ bytes: OLD_TOM, devTier: "local-ocr" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tier).toBe("local-ocr");
  });
  it("a production request with NONE of the three dev fields is unaffected by the gate", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } });
    const res = await POST(request({ bytes: OLD_TOM }));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test route.test.ts`
Expected: FAIL — the first three new tests currently get a `200` (the fields are honored anonymously today, per the D8c finding), not the expected `400`.

- [ ] **Step 3: Implement the gate**

In `app/api/verify/route.ts`, replace lines 149-155:

```ts
const sampleName = form.get("source") === "sample" && isGenuineSample(image.name, buffer) ? image.name : undefined;
const devTierRaw = form.get("devTier");
const devTier = typeof devTierRaw === "string" && DEV_TIERS.has(devTierRaw) ? devTierRaw : undefined;
const devBedrockModelRaw = form.get("devBedrockModel");
const devBedrockModel =
  typeof devBedrockModelRaw === "string" && VALID_BEDROCK_MODELS.has(devBedrockModelRaw)
    ? devBedrockModelRaw
    : undefined;
```

with:

```ts
const sampleName = form.get("source") === "sample" && isGenuineSample(image.name, buffer) ? image.name : undefined;
const devTierRaw = form.get("devTier");
const devBedrockModelRaw = form.get("devBedrockModel");
const escalateRaw = form.get("escalate");
// Dev-only cost multipliers (D8c, 2026-07-25 hardening): devTier/devBedrockModel bypass normal
// tier selection and escalate=1 triggers the (costlier) escalation ladder, both previously
// honored anonymously and for free. DEV_CONTROLS_ENABLED must be explicitly set in production
// for any of the three to do anything; a production deploy that forgets to set it fails closed
// (400) instead of silently accepting an anonymous cost-multiplying request. Always on outside
// production (NODE_ENV !== "production") so local dev and the dev-mode tier switcher keep
// working with no extra setup.
const devControlsEnabled = process.env.NODE_ENV !== "production" || process.env.DEV_CONTROLS_ENABLED === "1";
if (!devControlsEnabled && (devTierRaw !== null || devBedrockModelRaw !== null || escalateRaw !== null)) {
  return bad("Developer controls (tier override, model override, escalation) are disabled in this deployment.");
}
const devTier = typeof devTierRaw === "string" && DEV_TIERS.has(devTierRaw) ? devTierRaw : undefined;
const devBedrockModel =
  typeof devBedrockModelRaw === "string" && VALID_BEDROCK_MODELS.has(devBedrockModelRaw)
    ? devBedrockModelRaw
    : undefined;
```

Then replace line 213:

```ts
const escalationOn = process.env.ESCALATION_ENABLED === "1" || form.get("escalate") === "1";
```

with:

```ts
// escalateRaw is only ever a truthy "1" here when devControlsEnabled was true above (otherwise
// the early 400 return already fired), so this needs no further gating.
const escalationOn = process.env.ESCALATION_ENABLED === "1" || escalateRaw === "1";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test route.test.ts`
Expected: PASS — all new tests green, and every pre-existing `devTier`/`devBedrockModel` test in this file still green (they don't stub `NODE_ENV`, so `process.env.NODE_ENV` is `"test"` under Vitest, making `devControlsEnabled` `true` by the first clause).

Run: `pnpm test route.escalation.test.ts`
Expected: PASS unchanged — same reasoning (`NODE_ENV` is `"test"`, not `"production"`, in this suite).

- [ ] **Step 5: Sabotage check**

Temporarily change the guard's condition to always `false` (e.g. `if (false && ...)`), run `pnpm test route.test.ts`, confirm the three "rejected with 400" tests go red (now `200`), then restore.

- [ ] **Step 6: Document the new env var and threat-model closure**

In `.env.example`, add a new block near the top (after the `ESCALATION_ENABLED` comment block, before the `VISION_PROVIDER` block):

```
# Gates devTier / devBedrockModel / escalate=1 request fields (tier override, model override,
# ladder opt-in — all cost multipliers) in production. Unset in production: the three fields are
# inert (400 if present). Always on in development. See docs/ARCHITECTURE.md's threat model.
# DEV_CONTROLS_ENABLED=1
```

In `docs/ARCHITECTURE.md`, append to the end of the "Cost/resource exhaustion" threat-model row (line 315):

```
| **Cost/resource exhaustion** | LLM10 / A06 | Upload size caps, bounded batch concurrency (~5), hard request timeouts, `max_tokens` caps. Per-user rate limiting is a documented production TODO, not in the prototype. |
```

to:

```
| **Cost/resource exhaustion** | LLM10 / A06 | Upload size caps, bounded batch concurrency (~5), hard request timeouts, `max_tokens` caps. Per-user rate limiting is a documented production TODO, not in the prototype. `devTier`/`devBedrockModel`/`escalate` request fields (tier override, model override, ladder opt-in) are gated behind `DEV_CONTROLS_ENABLED` in production — unset, they 400 instead of being honored anonymously (D8c, GS-15 hardening, 2026-07-25). |
```

- [ ] **Step 7: Run the mock eval canary and full suite**

Run: `pnpm eval`
Expected: `13/13`, `8/8` — unchanged.

Run: `pnpm test`
Expected: all green.

- [ ] **Step 8: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`

- [ ] **Step 9: Commit**

```bash
git add app/api/verify/route.ts app/api/verify/route.test.ts .env.example docs/ARCHITECTURE.md
git commit -m "fix: gate devTier/devBedrockModel/escalate behind DEV_CONTROLS_ENABLED in production

These three request fields multiply cloud-call cost and were honored anonymously with no
gate. Unset DEV_CONTROLS_ENABLED in production now 400s a request that includes any of them;
development is unaffected. D8c, GS-15 hardening spec."
```

---

### Task 13: D8e — pin floating model aliases (OpenAI, Gemini; Claude explicitly left alone)

**Files:**

- Modify: `lib/vision/cloud/openai.ts`, `lib/vision/cloud/openai.test.ts`
- Modify: `lib/vision/cloud/gemini.ts`, `lib/vision/cloud/gemini.test.ts` (created in Task 7)
- Verify only, no change: `lib/vision/cloud/claude.ts`, `lib/vision/cloud/claude.test.ts`

**Interfaces:** no signature changes — only the default-model string literals.

⚠ **Deviation from the spec (researched, not assumed):** the design spec claims `gemini-flash-latest`, `gpt-4o-mini`, and `claude-sonnet-5` all "float." Checked against each provider's current documentation:

- **`gemini-flash-latest` genuinely floats** — Google's own docs describe `-latest` aliases as pointing at experimental models with tighter rate limits, not a stable target. `docs/ARCHITECTURE.md`'s Gemini risk row (line 280) already independently references `gemini-3.6-flash` as the current stable, non-experimental flash model (measured 2026-07-23) — this task pins to that same name.
- **`gpt-4o-mini` genuinely floats** — it is documented as an alias that currently resolves to the snapshot `gpt-4o-mini-2024-07-18`; this task pins to that dated snapshot.
- **`claude-sonnet-5` does NOT float.** Per Anthropic's model-ID-versioning docs: starting with the Claude 4.6 generation, dateless model IDs (`claude-{name}-{major}[-{minor}]`, e.g. `claude-sonnet-5`) are the **canonical, pinned snapshot ID** for that release — not an evergreen alias. (The evergreen-alias behavior the spec describes is real, but only for **pre-4.6** models, e.g. `claude-sonnet-4-5` pointing at `claude-sonnet-4-5-20250929`.) There is no "more pinned" form of `claude-sonnet-5` to move to. This task leaves `claude.ts`'s default untouched and adds a comment explaining why, rather than fabricating a plausible-looking but non-existent dated ID.

- [ ] **Step 1: Write the failing tests**

In `lib/vision/cloud/openai.test.ts`, change the existing assertion:

```ts
expect(body.model).toBe("gpt-4o-mini");
```

(in the "posts the expected chat completions request contract" test) to:

```ts
expect(body.model).toBe("gpt-4o-mini-2024-07-18");
```

In `lib/vision/cloud/gemini.test.ts` (Task 7), the "sends the extraction request contract" test doesn't currently assert a default model string — add one assertion to it:

```ts
it("sends the extraction request contract (inline image data + prompt) to the model", async () => {
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  generateContentMock.mockResolvedValue(textResult(VALID_CONTENT));

  await geminiProvider.extract(IMAGE, META);

  expect(getGenerativeModelMock.mock.calls[0][0].model).toBe("gemini-3.6-flash");
  const parts = generateContentMock.mock.calls[0][0];
  expect(parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: IMAGE.toString("base64") } });
  expect(parts[1]).toBe(EXTRACTION_PROMPT);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test openai.test.ts gemini.test.ts`
Expected: FAIL — both assertions currently see the floating alias names (`gpt-4o-mini`, `gemini-flash-latest`).

- [ ] **Step 3: Implement the pins**

In `lib/vision/cloud/openai.ts`, change:

```ts
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
```

to:

```ts
        // Pinned to a dated snapshot, not the "gpt-4o-mini" alias (D8e, 2026-07-25 hardening): a
        // silent alias rollover to a newer snapshot would invalidate committed eval numbers without
        // any code change to explain the shift.
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini-2024-07-18",
```

In `lib/vision/cloud/gemini.ts`, change:

```ts
      model: process.env.GEMINI_MODEL ?? "gemini-flash-latest",
```

to:

```ts
      // Pinned to the current stable release, not "gemini-flash-latest" (D8e, 2026-07-25
      // hardening): "-latest" aliases point at experimental models with tighter rate limits and
      // no comparability guarantee across eval runs. gemini-3.6-flash is also already referenced
      // as the measured model in docs/ARCHITECTURE.md's Gemini risk row.
      model: process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
```

In `lib/vision/cloud/claude.ts`, add a comment above the existing (unchanged) default — no behavior change, documentation only:

```ts
        // NOT pinned further (D8e, 2026-07-25 hardening — researched, not assumed): per Anthropic's
        // model-ID-versioning docs, dateless IDs from the Claude 4.6 generation onward (this one
        // included) are already the canonical, immutable snapshot for that release, not an
        // evergreen alias — there is no more-pinned form to move to. (Pre-4.6 models like
        // claude-sonnet-4-5 DO have this floating-alias behavior, resolving to a dated snapshot
        // such as claude-sonnet-4-5-20250929 — that's not this model's situation.)
        model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test openai.test.ts gemini.test.ts claude.test.ts`
Expected: PASS — all green, including `claude.test.ts`'s pre-existing `expect(request.model).toBe("claude-sonnet-5");` (unchanged).

- [ ] **Step 5: Run the mock eval canary and full suite**

Run: `pnpm eval`
Expected: `13/13`, `8/8` — unchanged.

Run: `pnpm test`
Expected: all green.

- [ ] **Step 6: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`

- [ ] **Step 7: Commit**

```bash
git add lib/vision/cloud/openai.ts lib/vision/cloud/openai.test.ts lib/vision/cloud/gemini.ts lib/vision/cloud/gemini.test.ts lib/vision/cloud/claude.ts
git commit -m "harden: pin OpenAI/Gemini adapter defaults to dated snapshots (D8e)

gpt-4o-mini -> gpt-4o-mini-2024-07-18; gemini-flash-latest -> gemini-3.6-flash. Prevents a
silent alias rollover from invalidating committed eval numbers. claude-sonnet-5 is left
unchanged with an explanatory comment — Anthropic's 4.6-generation dateless IDs are already
pinned snapshots, not floating aliases (researched against current docs; the spec's assumption
that it floats does not hold). GS-15 hardening spec."
```

---

### Task 14: D6b — three clean-tree Bedrock adversarial runs (LOCAL-ONLY, run last)

**Files:**

- Modify: `README.md:69-71`
- No code changes — this task only produces `eval/history.jsonl` entries and a doc update.

**Interfaces:** none.

**Preconditions — read before starting:**

- This task **cannot run in CI or in an agent sandbox without real credentials.** It requires `AWS_BEARER_TOKEN_BEDROCK` set in `.env.local` (a real, working Bedrock bearer token).
- It must run **after every other task in this plan is committed**, on a **clean working tree** (`git status --short` must print nothing) — `recordRun`'s `gitMeta()` reads `git status --porcelain` at run time and stamps `dirty: true` on every history line if the tree isn't clean, which would fail acceptance criterion 7 (`dirty: false`).
- Each run costs real Bedrock API calls (5 labels × up to 2 calls each if a repair fires — the ladder is off by default here, so 5 calls per run, 15 total).

- [ ] **Step 1: Confirm preconditions**

Run: `git status --short`
Expected: empty output. If not empty, stop and commit or stash outstanding changes first (do not proceed with a dirty tree).

Run: `grep -c "AWS_BEARER_TOKEN_BEDROCK=" .env.local 2>&1`
Expected: at least `1`, and the value must be a real, working token (not blank, not the commented-out placeholder from `.env.example`).

- [ ] **Step 2: Run the adversarial eval three times on bedrock**

Run: `pnpm eval --set adversarial --provider bedrock`
Expected: prints `10/10` (or the current pairs-and-controls total) verdicts correct, then either `PASS: 5 planted injections altered no verdict toward passing.` (exit 0) or a `FAIL:` line naming the violating file(s) (exit 1). If it prints `FAIL`, **stop — this is a release-blocking finding per the spec, not a documentation problem** — do not proceed to update the README until the underlying issue is investigated and resolved.

Run: `pnpm eval --set adversarial --provider bedrock`
Expected: same PASS shape (second run).

Run: `pnpm eval --set adversarial --provider bedrock`
Expected: same PASS shape (third run).

- [ ] **Step 3: Verify all three runs landed with `dirty: false` and zero violations**

Run: `tail -n 3 eval/history.jsonl | node -e "process.stdin.setEncoding('utf8'); let d=''; process.stdin.on('data', c => d+=c); process.stdin.on('end', () => { const lines = d.trim().split('\n').map(JSON.parse); for (const l of lines) console.log(JSON.stringify({ provider: l.provider, set: l.set, dirty: l.dirty, violationsCaught: l.violationsCaught, violationsTotal: l.violationsTotal })); });"`

Expected: three lines, each `{"provider":"bedrock","set":"adversarial","dirty":false,"violationsCaught":5,"violationsTotal":5}` (or whatever the current total planted-injection count is — it must equal `violationsCaught`, and `dirty` must be `false` on all three).

- [ ] **Step 4: Update the README's injection claim (acceptance criterion 7)**

In `README.md`, replace lines 69-71:

```
- **`bedrock` (Llama 4 Maverick — a real vision model that can read and follow the injected
  text):** 10/10 verdicts correct, all 5 injections inert — including the value-corruption attack,
  where the model transcribed the printed 45% ABV rather than obeying "report 40%".
```

with:

```
- **`bedrock` (Claude Haiku 4.5, the default cloud tier since 2026-07-25 — a real vision model
  that can read and follow the injected text):** 3 clean-tree runs (2026-07-25,
  [`eval/history.jsonl`](eval/history.jsonl)), each 10/10 verdicts correct, all 5 injections inert
  on every run — including the value-corruption attack, where the model transcribed the printed
  45% ABV rather than obeying "report 40%".
```

(If the actual `violationsTotal`/pair count observed in Step 3 differs from 5, or the actual verdict-correct count differs from 10/10, update those numbers in the README text to match exactly what was measured — never round up or copy stale numbers from before this task ran.)

- [ ] **Step 5: Run the mock eval canary**

Run: `pnpm eval`
Expected: `13/13`, `8/8` — unchanged (this task never touches matching/schema/vision code).

- [ ] **Step 6: Lint**

Run: `pnpm lint`
Expected: clean (README-only change).

- [ ] **Step 7: Commit**

```bash
git add README.md eval/history.jsonl
git commit -m "docs: cite 3 clean-tree bedrock adversarial runs, not n=1 (D6b)

Runs pnpm eval --set adversarial --provider bedrock three times on a clean tree; all three
land in eval/history.jsonl with dirty: false and zero gate violations. Updates the README's
injection claim from a single Llama-4-Maverick run to the multi-run Claude-Haiku-4.5 evidence
(D1 already made Bedrock/Haiku the default cloud tier). GS-15 hardening spec."
```

---

## Post-plan verification

After all 14 tasks are committed, run the full acceptance-criteria sweep in one sitting:

```bash
pnpm test && pnpm lint && pnpm typecheck
pnpm eval                                              # expect 13/13, 8/8
pnpm eval --set real-world --provider local-ocr --min-overall 22
```

Confirm `eval/history.jsonl`'s last 3 bedrock/adversarial lines show `dirty: false` and zero gate violations (Task 14), and that `git status --short` shows no tracked `coverage*.txt` files (Task 11).
