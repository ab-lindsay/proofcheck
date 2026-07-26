# local-ocr Field-Selection Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `lib/vision/ocr-parser.ts`'s `classType` and `brandName` line-selection heuristics
from picking marketing/narrative text over real field content on real product photography, by
preferring a plausible short candidate over a long one and falling back to "not found" (→ REVIEW)
rather than guessing wrong.

**Architecture:** Two independent, pure-function changes inside `parseOcrText` — no new files, no
new dependencies, no change to the `local-ocr.ts` → `ocr-parser.ts` interface. `classType` switches
from "first keyword match wins" to "shortest keyword match wins." `brandName` gets a plausibility
filter (word count, comma check, small standardized-designation denylist) added to its existing
leftover-line candidate search.

**Tech Stack:** TypeScript, Vitest. No new libraries.

## Global Constraints

- No new dependencies, no I/O changes, no change to `parseOcrText`'s signature or the
  `local-ocr.ts` → `ocr-parser.ts` interface (spec Goals).
- `pnpm eval` (mock tier, default set) must stay `13/13 (100%)` overall, `8/8 (100%)` planted
  violations caught — any regression here is a matcher-side mistake, not an extraction one (spec
  Testing section).
- Only `classType` and `brandName` selection logic changes. `alcoholContent`, `netContents`,
  `nameAndAddress`, `countryOfOrigin`, `healthWarningStatement` selection is untouched (spec
  Non-goals — the eval data shows these are already solid).
- `lib/matching/*` is untouched — invariant #1 ("extraction proposes, matching disposes") holds.
- Heuristics must be structural/deterministic (word count, punctuation shape, a small documented
  denylist) — no new Tesseract output consumption (bounding boxes/confidence), no image
  preprocessing. That's explicitly out of scope (Phase 2, spec Non-goals).
- Test-first: write the failing test before the implementation, for every step below.
- Full spec: `docs/superpowers/specs/2026-07-23-local-ocr-field-selection-robustness-design.md`.

**Baseline to compare against after Task 3:** `pnpm eval:real-world` scored 10/42 (24%) overall;
brandName 11/42, classType 22/42 (recorded in the design spec's Motivation section).

**Note on concurrent work:** a separate, unrelated effort (Romance-language OCR support) has
already landed in `lib/vision/ocr-parser.ts` as of this plan being written (adds Romance-language
words to `CLASS_KEYWORDS`, adds the `COUNTRY_MARKERS` constant, extends the producer-line regex).
This plan's line numbers and code snippets below reflect that current state. If further unrelated
commits have landed in this file since, match by the surrounding code shown in each step (not
blindly by line number) before editing.

---

### Task 1: `classType` — shortest keyword match instead of first match

**Files:**

- Modify: `lib/vision/ocr-parser.ts`
- Test: `lib/vision/ocr-parser.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `wordCount(line: string): number` — a module-private helper in
  `lib/vision/ocr-parser.ts` (not exported), reused by Task 2.

- [ ] **Step 1: Write the failing test**

Add this constant and test to `lib/vision/ocr-parser.test.ts`, right after the existing
`"recognizes Portuguese producer and country phrasing"` test (before the closing `});` of the
`describe` block):

```ts
// Models a real failure: a Guinness can's OCR produced two separate marketing-copy lines before
// the real fields. Line 2 contains "beer" as an ordinary word, which used to win classType by
// appearing before "DRAUGHT STOUT" (the real, much shorter class/type designation on the same
// can). Line 1 contains no field keyword at all, so it used to win brandName by being the first
// unclaimed leftover line, ahead of "GUINNESS" (see Task 2). Verified against the current
// (pre-fix) parser: classType returns line 2 and brandName returns line 1 today.
const GUINNESS_STYLE_OCR = `UPON OPENING, THE FAMOUS SURGE MAKES ITS WAY
THROUGH THE BEER, CREATING THE PERFECT PINT
GUINNESS
DRAUGHT STOUT
4.1% alc./vol.
14.9 FL. OZ.`;

it("classType prefers the short designation line over a longer line that incidentally contains the same keyword (Guinness-style)", () => {
  const r = parseOcrText(GUINNESS_STYLE_OCR, 0.9);
  expect(r.classType.value).toBe("DRAUGHT STOUT");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts -t "classType prefers the short designation line"`
Expected: FAIL — `r.classType.value` is `"THROUGH THE BEER, CREATING THE PERFECT PINT"` (the
first, longer, keyword-matching line), not `"DRAUGHT STOUT"`.

- [ ] **Step 3: Implement the minimal code change**

In `lib/vision/ocr-parser.ts`, add a `wordCount` helper right after the `COUNTRY_MARKERS` constant
(currently ending at line 13, right before `export function parseOcrText`):

```ts
// Real TTB class/type declarations are short standalone designations ("BOURBON WHISKEY", "DRAUGHT
// STOUT"); marketing prose that incidentally contains a class keyword runs much longer. Prefer the
// shortest matching line over the first — OCR reading order is not a reliable signal here.
const wordCount = (line: string) => line.trim().split(/\s+/).filter(Boolean).length;
```

Then change the `classLine` selection (currently `lines.find((l) => CLASS_KEYWORDS.test(l) &&
!/GOVERNMENT/i.test(l)) ?? null;`) to:

```ts
const classLine =
  lines
    .filter((l) => CLASS_KEYWORDS.test(l) && !/GOVERNMENT/i.test(l))
    .sort((a, b) => wordCount(a) - wordCount(b))[0] ?? null;
```

(`Array.prototype.sort` is stable in Node/V8, so ties keep their original top-to-bottom order —
matching today's tie-breaking behavior when only one line matches.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts`
Expected: PASS, all tests in the file — including every pre-existing test (none of them have more
than one `CLASS_KEYWORDS`-matching line, so this change is a no-op for all of them; confirm none
broke). This was verified end-to-end against the actual codebase while writing this plan, including
a check that the failing-test step genuinely fails for the stated reason and the passing-test step
genuinely passes after the code change below — not just reasoned about.

- [ ] **Step 5: Commit**

```bash
git add lib/vision/ocr-parser.ts lib/vision/ocr-parser.test.ts
git commit -m "Prefer shortest classType match over first match in local-ocr parser"
```

---

### Task 2: `brandName` — plausibility filter over leftover-line candidates

**Files:**

- Modify: `lib/vision/ocr-parser.ts`
- Test: `lib/vision/ocr-parser.test.ts`

**Interfaces:**

- Consumes: `wordCount(line: string): number` from Task 1 (`lib/vision/ocr-parser.ts`);
  `GUINNESS_STYLE_OCR` test constant from Task 1 (`lib/vision/ocr-parser.test.ts`).
- Produces: `BRAND_DENYLIST: RegExp` — a module-private constant in `lib/vision/ocr-parser.ts`
  (not exported).

- [ ] **Step 1: Write the failing tests**

Add these two tests to `lib/vision/ocr-parser.test.ts`, right after the
`"classType prefers the short designation line..."` test added in Task 1:

```ts
it("brandName rejects a long comma-bearing marketing line and falls through to the real brand line (Guinness-style)", () => {
  const r = parseOcrText(GUINNESS_STYLE_OCR, 0.9);
  expect(r.brandName.value).toBe("GUINNESS");
});

it("brandName does not fall back to a standardized designation like BOTTLED IN BOND when the real brand line is absent (Old-Tub-style)", () => {
  // Real OCR of a large stylized brand title is sometimes dropped entirely, leaving only a
  // standardized federal designation as the sole short, comma-free "leftover" candidate line.
  const oldTubStyleOcr = [
    "BOTTLED IN BOND",
    "KENTUCKY STRAIGHT BOURBON WHISKEY",
    "50% ALC./VOL. 100 PROOF",
    "750 mL",
    "Distilled and bottled by James B. Beam Distilling Co., Clermont, KY",
  ].join("\n");
  const r = parseOcrText(oldTubStyleOcr, 0.9);
  expect(r.brandName.value).toBeNull();
  expect(r.brandName.present).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts -t "brandName"`
Expected: both new tests FAIL. The Guinness-style test gets `"UPON OPENING, THE FAMOUS SURGE MAKES
ITS WAY"` back as `brandName.value` instead of `"GUINNESS"`. The Old-Tub-style test gets
`"BOTTLED IN BOND"` back instead of `null`.

- [ ] **Step 3: Implement the minimal code change**

In `lib/vision/ocr-parser.ts`, add a `BRAND_DENYLIST` constant right after the `wordCount` helper
added in Task 1:

```ts
// Standardized federal/industry designations that commonly survive OCR when the real (often large,
// stylized) brand title gets dropped entirely — observed on real bottles where OCR skipped the
// brand and left one of these behind as the only short, comma-free "leftover" candidate line.
const BRAND_DENYLIST = /\b(?:bottled in bond|sour mash|single barrel|small batch|cask strength)\b/i;
```

Then change the `brandLine` selection. Current code:

```ts
// The brand sits above the warning. Only consider lines before the warning block so that when the
// brand line is absent (OCR often drops a large bold title), brandLine falls to null — a "not found"
// REVIEW — instead of grabbing a warning-body line like "women should not drink...". Anchor on the
// first GOVERNMENT line (not "GOVERNMENT WARNING") so a header split across two OCR lines still bounds.
const warningStart = lines.findIndex((l) => /GOVERNMENT/i.test(l));
const preWarningLines = warningStart >= 0 ? lines.slice(0, warningStart) : lines;
const brandLine =
  preWarningLines.find(
    (l) =>
      l !== classLine &&
      l !== alcoholLine &&
      l !== netLine &&
      l !== producerLine &&
      l.length >= 3 &&
      !/GOVERNMENT/i.test(l) &&
      !new RegExp(COUNTRY_MARKERS, "i").test(l),
  ) ?? null;
```

New code (adds a plausibility filter — word count, comma, denylist — to the same candidate search,
and documents why):

```ts
// The brand sits above the warning. Only consider lines before the warning block so that when the
// brand line is absent (OCR often drops a large bold title), brandLine falls to null — a "not found"
// REVIEW — instead of grabbing a warning-body line like "women should not drink...". Anchor on the
// first GOVERNMENT line (not "GOVERNMENT WARNING") so a header split across two OCR lines still bounds.
// Beyond the exclusions above, a leftover line must also look brand-shaped: real brand/fanciful
// names are short (<=6 words) and comma-free, so a longer or comma-bearing line is almost always
// marketing copy, not a brand — reject it rather than guess. BRAND_DENYLIST catches the remaining
// case where a standardized designation (not marketing copy) is left over because the real brand
// was dropped by OCR entirely.
const warningStart = lines.findIndex((l) => /GOVERNMENT/i.test(l));
const preWarningLines = warningStart >= 0 ? lines.slice(0, warningStart) : lines;
const brandLine =
  preWarningLines.find(
    (l) =>
      l !== classLine &&
      l !== alcoholLine &&
      l !== netLine &&
      l !== producerLine &&
      l.length >= 3 &&
      wordCount(l) <= 6 &&
      !l.includes(",") &&
      !BRAND_DENYLIST.test(l) &&
      !/GOVERNMENT/i.test(l) &&
      !new RegExp(COUNTRY_MARKERS, "i").test(l),
  ) ?? null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts`
Expected: PASS, every test in the file — including all pre-existing tests (re-check
`"does not misclassify a brand that contains a class-keyword substring"` and
`"does not fabricate a brand from the warning body when the brand line is absent"` specifically,
since they're the closest existing coverage to this change; both should still pass unmodified since
their candidate lines are all either ≤6 words with no comma and not denylisted, or already excluded
by the pre-existing field-equality checks). Verified end-to-end while writing this plan: all 18
tests (15 pre-existing + 3 new across Tasks 1–2) pass with the Task 1 + Task 2 code changes applied
together.

- [ ] **Step 5: Commit**

```bash
git add lib/vision/ocr-parser.ts lib/vision/ocr-parser.test.ts
git commit -m "Filter implausible leftover lines out of local-ocr brandName selection"
```

---

### Task 3: Verify against the full suite and the real-world eval, report the delta

**Files:** none (verification only — no commit at the end of this task).

**Interfaces:** none.

- [ ] **Step 1: Full unit suite**

Run: `pnpm test`
Expected: all green, no regressions outside `lib/vision/ocr-parser.test.ts`. (Confirmed in scoping
for this plan: `parseOcrText`/`CLASS_KEYWORDS` are only referenced from `lib/vision/ocr-parser.ts`,
`lib/vision/local-ocr.ts`, and `lib/vision/ocr-parser.test.ts` — no other test file exercises this
code path.)

- [ ] **Step 2: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 3: Mock-tier eval (must not regress)**

Run: `pnpm eval`
Expected: `overall verdict accuracy: 13/13 (100%)`, `planted violations caught: 8/8 (100%)`. If this
regresses, stop — it means one of the two changes altered behavior on the synthetic default set,
which the Global Constraints section says must not happen; do not proceed to Step 4 until fixed.

- [ ] **Step 4: Real-world eval (report the delta, not a gate)**

Run: `pnpm eval:real-world`
Record the new `overall verdict accuracy` and the `brandName`/`classType` entries from
`per-field verdict accuracy`, and compare against the baseline recorded in this plan's Global
Constraints section (10/42 = 24% overall; brandName 11/42; classType 22/42). Report the before/after
numbers — this is the actual deliverable for this plan, per the design spec: observability, not a
pass/fail gate. No code or doc changes required based on the result; if the numbers are still poor,
that's the documented trigger for a Phase 2 follow-up (bounding-box/font-size line scoring), not a
reason to keep expanding this plan's denylist.

Note: the entry count may be higher than 42 by the time this task runs — the concurrent
Romance-language OCR effort (see the "Note on concurrent work" above) adds its own fixtures to
`eval/expected-real-world.json`. That's expected and unrelated to this plan; don't chase failures
on entries this plan didn't touch (e.g. non-English label fixtures) — compare like-for-like on the
brandName/classType numbers, which is what this plan actually changes.

---

## Self-review notes (writing-plans skill)

- **Spec coverage:** Motivation → Tasks 1–2 fix the two root causes identified. Goals → Task 1
  (classType shortest-match), Task 2 (brandName plausibility filter + REVIEW fallback), both pure/
  deterministic/no new deps. Non-goals → confirmed untouched (no bbox/confidence consumption, no
  preprocessing, no other field's selection logic, no `lib/matching` changes — none of the tasks
  touch those areas). Testing section → Task 1/2 Steps 1–4 cover all four listed cases (classType
  shortest-match, brandName comma/length rejection with fallback, brandName denylist rejection,
  existing tests keep passing); Task 3 covers the `pnpm eval` / `pnpm eval:real-world` verification.
  File inventory → matches (`ocr-parser.ts`, `ocr-parser.test.ts` only).
- **Placeholder scan:** none found — every step has literal code/commands, no "TBD"/"add error
  handling"/"similar to Task N" placeholders.
- **Type consistency:** `wordCount(line: string): number` signature is identical everywhere it's
  referenced (Task 1 definition, Task 2 Interfaces/usage). `BRAND_DENYLIST: RegExp` likewise.
