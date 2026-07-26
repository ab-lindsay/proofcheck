# local-ocr Field-Selection Robustness, Phase 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five structural, evidence-backed selection bugs in `lib/vision/ocr-parser.ts` —
`brandName` picking post-cutoff marketing copy, `nameAndAddress` returning the bare producer verb
phrase, `classType` having no vocabulary for common varietals/beer styles, `alcoholContent`
accepting any `%`-line regardless of context, and `healthWarningStatement`'s fallback swallowing
trailing barcodes/URLs — each verified independently against `pnpm eval:real-world`.

**Architecture:** Five independent, pure-function changes inside `parseOcrText`, each scoped to one
field's selection logic, each landed and verified before the next starts. No new files, no new
dependencies, no change to the `local-ocr.ts` → `ocr-parser.ts` interface. A sixth, code-free task
runs the full verification sweep and records the final delta via the (already-merged)
`pnpm eval:history` tooling.

**Tech Stack:** TypeScript, Vitest. No new libraries.

## Global Constraints

- No new dependencies, no I/O changes, no change to `parseOcrText`'s signature or the
  `local-ocr.ts` → `ocr-parser.ts` interface (spec Goals).
- `pnpm eval` (mock tier, default set) must stay `13/13 (100%)` overall, `8/8 (100%)` planted
  violations caught — any regression here is a matcher-side mistake, not an extraction one (spec
  Testing section).
- Only `brandName`, `nameAndAddress`, `classType`, `alcoholContent`, and `healthWarningStatement`
  selection logic changes. `netContents` and `countryOfOrigin` selection is untouched (spec
  Non-goals — no fixable pattern found in the evidence for these two).
- `lib/matching/*` is untouched — invariant #1 ("extraction proposes, matching disposes") holds.
  `lib/vision/local-ocr.ts`, `eval/expected.json`, `eval/expected-real-world.json`, the
  `ExtractedLabel` schema, the `/api/verify` contract, `eval/record-run.ts`, `eval/print-history.ts`,
  and `eval/run.ts` are all untouched (spec File inventory).
- Heuristics must be structural/deterministic (word count, line adjacency, keyword co-occurrence,
  punctuation shape) — no new Tesseract output consumption (bounding boxes/confidence), no image
  preprocessing (spec Non-goals).
- Test-first: write the failing test before the implementation, for every step below.
- After each task, run `pnpm eval:real-world` then `pnpm eval:history --set real-world --provider
local-ocr --limit 2` to report the delta from the immediately-preceding run — this is how the
  now-merged eval-history tooling replaces hand-copying numbers into commit messages.
- **Baseline** (recorded in the spec's Motivation section, current as of this plan being written):
  `pnpm eval:real-world` scores 16/46 (35%) overall. Per-field: brandName 26/46, classType 30/46,
  healthWarningStatement 39/46, alcoholContent 40/46, netContents 44/46, nameAndAddress 27/36,
  countryOfOrigin 10/10. Planted violations 5/5.
- Full spec: `docs/superpowers/specs/2026-07-23-local-ocr-field-selection-phase-2-design.md`.

---

### Task 1: `brandName` — positional restriction to before the first structured field

**Files:**

- Modify: `lib/vision/ocr-parser.ts`
- Test: `lib/vision/ocr-parser.test.ts`

**Interfaces:**

- Consumes: existing `classLine`, `alcoholLine`, `netLine`, `producerLine`, `wordCount`,
  `BRAND_NOISE`, `BRAND_DENYLIST`, `COUNTRY_MARKERS` — all already defined earlier in
  `parseOcrText`/module scope; nothing new consumed.
- Produces: nothing new consumed by later tasks — this task only narrows `brandLine`'s candidate
  search.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `lib/vision/ocr-parser.test.ts`, in the `brandName`-related section (near
the existing Phase 1 brandName tests):

```ts
it("brandName still finds the real brand line when it appears before the first structured field", () => {
  const text = ["REAL BRAND", "BOURBON WHISKEY", "50% ALC./VOL.", "750 mL", "GOVERNMENT WARNING: text."].join("\n");
  const r = parseOcrText(text, 0.9);
  expect(r.brandName.value).toBe("REAL BRAND");
});

it("brandName resolves to null instead of a leftover line that appears after the first structured field (Old-Tub-style)", () => {
  // Models the real Old Tub failure: OCR dropped the actual brand entirely, leaving "100 PROOF 100
  // PROOF" (rejected by the existing digit-noise filter) and, after that, "KENTUCKY STRAIGHT" (a
  // truncated designation fragment) as the next unclaimed leftover line. Before this fix, the
  // parser fell through to "KENTUCKY STRAIGHT" as a confidently-wrong brand; after this fix, it
  // isn't even considered, because it appears after the first structured field (alcoholLine).
  const text = [
    "100 PROOF 100 PROOF",
    "BOURBON WHISKEY",
    "50% ALC./VOL.",
    "KENTUCKY STRAIGHT",
    "750 mL",
    "GOVERNMENT WARNING: text.",
  ].join("\n");
  const r = parseOcrText(text, 0.9);
  expect(r.brandName.value).toBeNull();
  expect(r.brandName.present).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts -t "brandName resolves to null instead of a leftover line"`
Expected: FAIL — `r.brandName.value` is `"KENTUCKY STRAIGHT"`, not `null` (the first test in Step 1
already passes today — it's the second one that's new behavior).

- [ ] **Step 3: Implement the minimal code change**

In `lib/vision/ocr-parser.ts`, find the brandLine section (currently):

```ts
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
      !BRAND_NOISE.test(l) &&
      !BRAND_DENYLIST.test(l) &&
      !/GOVERNMENT/i.test(l) &&
      !new RegExp(COUNTRY_MARKERS, "i").test(l),
  ) ?? null;
```

Change it to:

```ts
const warningStart = lines.findIndex((l) => /GOVERNMENT/i.test(l));
let preWarningLines = warningStart >= 0 ? lines.slice(0, warningStart) : lines;
// Real labels put the brand first — it's the largest, most prominent text, typically the very
// first line. Everything after the first structured field (alcohol content, net contents, or the
// producer line) is increasingly likely to be marketing copy, not a missed brand. classLine is
// excluded from this cutoff because some labels print the class/type designation as a header
// above the brand.
const structuredFieldIndices = [alcoholLine, netLine, producerLine]
  .filter((l): l is string => l !== null)
  .map((l) => lines.indexOf(l));
const firstStructuredFieldIndex = structuredFieldIndices.length > 0 ? Math.min(...structuredFieldIndices) : -1;
if (firstStructuredFieldIndex >= 0) {
  preWarningLines = preWarningLines.slice(0, firstStructuredFieldIndex);
}
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
      !BRAND_NOISE.test(l) &&
      !BRAND_DENYLIST.test(l) &&
      !/GOVERNMENT/i.test(l) &&
      !new RegExp(COUNTRY_MARKERS, "i").test(l),
  ) ?? null;
```

(Only the `const preWarningLines` → `let preWarningLines` change and the new
`structuredFieldIndices`/`firstStructuredFieldIndex`/slice block are new; the `brandLine` candidate
predicate itself is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts`
Expected: PASS, every test in the file — including all pre-existing tests. This change was already
verified empirically in-session before being written into this plan: applied in isolation, it moved
`pnpm eval:real-world` brandName from 26/46 to 30/46 with every other field's count unchanged and the
mock-tier gate unaffected. Confirm the same here.

- [ ] **Step 5: Verify against the full suite and real-world eval**

Run: `pnpm test` — expect all green, no regressions outside `lib/vision/ocr-parser.test.ts`.
Run: `pnpm eval` — expect `13/13 (100%)`, `8/8 (100%)` violations caught. If this regresses, stop —
fix before proceeding.
Run: `pnpm eval:real-world` — expect brandName `30/46`, every other field unchanged from the
baseline in Global Constraints.
Run: `pnpm eval:history --set real-world --provider local-ocr --limit 2` — confirm the newest entry
shows the improved brandName count against the previous entry.

- [ ] **Step 6: Commit**

```bash
git add lib/vision/ocr-parser.ts lib/vision/ocr-parser.test.ts
git commit -m "Restrict brandName candidates to before the first structured field"
```

---

### Task 2: `nameAndAddress` — next-line fallback when the producer verb phrase stands alone

**Files:**

- Modify: `lib/vision/ocr-parser.ts`
- Test: `lib/vision/ocr-parser.test.ts`

**Interfaces:**

- Consumes: existing `PRODUCER_VERB`, `producerLine`, `producerMatch`, `lines` — all already
  defined earlier in `parseOcrText`.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `lib/vision/ocr-parser.test.ts`, near the existing `nameAndAddress` tests:

```ts
it("nameAndAddress falls back to the next line when the producer verb phrase has nothing after it on its own line (Old-Tub-style)", () => {
  const text = [
    "OLD TUB",
    "BOURBON WHISKEY",
    "50% ALC./VOL.",
    "Distilled and Bottled by",
    "James B. Beam Distilling Co., Clermont, KY",
    "750 mL",
    "GOVERNMENT WARNING: text.",
  ].join("\n");
  const r = parseOcrText(text, 0.9);
  expect(r.nameAndAddress.value).toBe("James B. Beam Distilling Co., Clermont, KY");
});

it("nameAndAddress still captures same-line text when the verb phrase and name share a line (regression check)", () => {
  const text = [
    "BUFFALO TRACE",
    "BOURBON WHISKEY",
    "45% ALC./VOL.",
    "Distilled and Bottled by Buffalo Trace Distillery Inc, Frankfort, KY",
    "750 mL",
    "GOVERNMENT WARNING: text.",
  ].join("\n");
  const r = parseOcrText(text, 0.9);
  expect(r.nameAndAddress.value).toBe("Buffalo Trace Distillery Inc, Frankfort, KY");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts -t "nameAndAddress falls back to the next line"`
Expected: FAIL — `r.nameAndAddress.value` is `"Distilled and Bottled by"` (the bare verb phrase),
not `"James B. Beam Distilling Co., Clermont, KY"`. The second test in Step 1 already passes today.

- [ ] **Step 3: Implement the minimal code change**

In `lib/vision/ocr-parser.ts`, find the producer/nameAndAddress section (currently):

```ts
const producerLine = lines.find((l) => new RegExp(PRODUCER_VERB, "i").test(l) || /\bco\.,/i.test(l)) ?? null;
const producerMatch = producerLine ? producerLine.match(new RegExp(`(?:${PRODUCER_VERB})\\s+(.+)$`, "i")) : null;
const nameAndAddressValue = producerMatch ? producerMatch[1].trim() : producerLine;
```

Change it to:

```ts
const producerLine = lines.find((l) => new RegExp(PRODUCER_VERB, "i").test(l) || /\bco\.,/i.test(l)) ?? null;
const producerMatch = producerLine ? producerLine.match(new RegExp(`(?:${PRODUCER_VERB})\\s+(.+)$`, "i")) : null;
// Real photos often OCR the producer verb phrase ("Distilled and Bottled by") and the company
// name/address onto separate lines. When the verb phrase is the whole line (producerMatch finds
// nothing after it) and it matched via the verb-phrase branch (not the "Co.," branch, where the
// whole line already IS the name), fall back to the next OCR line as the value instead of
// returning the bare verb phrase.
const producerIsVerbPhraseOnly =
  producerLine !== null && producerMatch === null && new RegExp(PRODUCER_VERB, "i").test(producerLine);
const producerNextLine = producerIsVerbPhraseOnly ? lines[lines.indexOf(producerLine) + 1] : undefined;
const nameAndAddressValue = producerMatch ? producerMatch[1].trim() : (producerNextLine ?? producerLine);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 5: Verify against the full suite and real-world eval**

Run: `pnpm test` — expect all green.
Run: `pnpm eval` — expect `13/13 (100%)`, `8/8 (100%)`.
Run: `pnpm eval:real-world` — expect nameAndAddress improved from `27/36` (other fields at their
Task 1 post-fix values: brandName `30/46`, everything else unchanged).
Run: `pnpm eval:history --set real-world --provider local-ocr --limit 2` — confirm the delta.

- [ ] **Step 6: Commit**

```bash
git add lib/vision/ocr-parser.ts lib/vision/ocr-parser.test.ts
git commit -m "Fall back to the next line when nameAndAddress's producer verb phrase stands alone"
```

---

### Task 3: `classType` — expand `CLASS_KEYWORDS` vocabulary

**Files:**

- Modify: `lib/vision/ocr-parser.ts`
- Test: `lib/vision/ocr-parser.test.ts`

**Interfaces:**

- Consumes: existing `CLASS_KEYWORDS` constant, existing shortest-match-wins `classLine` selection
  (unchanged, from Phase 1) — this task only widens the regex, not the selection algorithm.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Add this test to `lib/vision/ocr-parser.test.ts`, near the existing `classType` tests:

```ts
it("classType prefers a newly-recognized varietal line over marketing prose containing an unrelated class keyword (Kunde-style)", () => {
  const text = [
    "LA CREMA",
    "Kunde, a beloved wine-growing visionary, who planted the vineyard with her husband,",
    "CHARDONNAY",
    "13.5% Alc/Vol",
    "750 mL",
  ].join("\n");
  const r = parseOcrText(text, 0.9);
  expect(r.classType.value).toBe("CHARDONNAY");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts -t "classType prefers a newly-recognized varietal line"`
Expected: FAIL — `r.classType.value` is the long marketing-prose line (the only line currently
matching `CLASS_KEYWORDS`, via "wine" inside "wine-growing"), not `"CHARDONNAY"`.

- [ ] **Step 3: Implement the minimal code change**

In `lib/vision/ocr-parser.ts`, find the `CLASS_KEYWORDS` constant (currently):

```ts
const CLASS_KEYWORDS =
  /\b(?:whisk(?:e)?y|bourbon|rye|vodka|gin|rum|tequila|brandy|wine|ale|lager|beer|stout|porter|liqueur|vin|vino|vinho|rouge|tinto|rosso|blanc|blanco|bianco|branco)\b/i;
```

Change it to:

```ts
const CLASS_KEYWORDS =
  /\b(?:whisk(?:e)?y|bourbon|rye|vodka|gin|rum|tequila|brandy|wine|ale|lager|beer|stout|porter|liqueur|vin|vino|vinho|rouge|tinto|rosso|blanc|blanco|bianco|branco|chardonnay|cabernet|merlot|pinot|sauvignon|zinfandel|syrah|shiraz|malbec|riesling|grenache|tempranillo|sangiovese|moscato|muscat|ros[eé]|champagne|prosecco|m[aä]rzen|ipa|pilsner|amber|wheat|saison)\b/i;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts`
Expected: PASS, every test in the file — including every pre-existing test. Pay particular attention
to any existing test whose fixture text contains a word that is now a keyword substring match
(e.g. a brand or address line containing "amber" or "wheat") — if one breaks, that's a real
false-positive this expansion introduced and needs investigating (not silently working around), not
a test to weaken.

- [ ] **Step 5: Verify against the full suite and real-world eval**

Run: `pnpm test` — expect all green.
Run: `pnpm eval` — expect `13/13 (100%)`, `8/8 (100%)`.
Run: `pnpm eval:real-world` — expect classType improved from `30/46` (other fields at their
prior post-fix values).
Run: `pnpm eval:history --set real-world --provider local-ocr --limit 2` — confirm the delta. Per
the spec's Risks section, if classType's number is flat or negative (the broader vocabulary causing
new false positives elsewhere outweighing the fix), stop and report rather than proceeding to Task 4
— don't chase a specific target number, just report what happened.

- [ ] **Step 6: Commit**

```bash
git add lib/vision/ocr-parser.ts lib/vision/ocr-parser.test.ts
git commit -m "Expand CLASS_KEYWORDS with common varietals and beer styles"
```

---

### Task 4: `alcoholContent` — require ABV context alongside a bare `%`

**Files:**

- Modify: `lib/vision/ocr-parser.ts`
- Test: `lib/vision/ocr-parser.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `ABV_CONTEXT: RegExp` — a module-private constant in `lib/vision/ocr-parser.ts` (not
  exported), used only by the `alcoholLine` selection in this task.

- [ ] **Step 1: Write the failing tests**

Add these three tests to `lib/vision/ocr-parser.test.ts`, near the existing `alcoholContent` tests:

```ts
it("alcoholContent rejects a %-line with no ABV context and falls through to the real ABV line (La-Crema-style)", () => {
  const text = [
    "LA CREMA",
    "CHARDONNAY",
    "AGED MINIMUM OF 9 MONTHS IN 100% FRENCH OAK",
    "13.5% Alc/Vol",
    "750 mL",
  ].join("\n");
  const r = parseOcrText(text, 0.9);
  expect(r.alcoholContent.value).toBe("13.5% Alc/Vol");
});

it("alcoholContent resolves to null instead of a %-line with no ABV context when no real ABV line exists", () => {
  const text = ["LA CREMA", "CHARDONNAY", "AGED MINIMUM OF 9 MONTHS IN 100% FRENCH OAK", "750 mL"].join("\n");
  const r = parseOcrText(text, 0.9);
  expect(r.alcoholContent.value).toBeNull();
});

it("alcoholContent still matches a bare proof line with no percent sign (regression check)", () => {
  const text = ["OLD TOM", "BOURBON WHISKEY", "100 PROOF", "750 mL"].join("\n");
  const r = parseOcrText(text, 0.9);
  expect(r.alcoholContent.value).toBe("100 PROOF");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts -t "alcoholContent rejects a %-line with no ABV context and falls through"`
Expected: FAIL — `r.alcoholContent.value` is `"AGED MINIMUM OF 9 MONTHS IN 100% FRENCH OAK"`, not
`"13.5% Alc/Vol"`. The third test (bare proof) already passes today.

- [ ] **Step 3: Implement the minimal code change**

In `lib/vision/ocr-parser.ts`, add an `ABV_CONTEXT` constant right after `BRAND_NOISE` (before
`export function parseOcrText`):

```ts
// A bare "%" line is ambiguous (marketing copy like "100% FRENCH OAK" also contains one) — real ABV
// declarations are always printed alongside "ALC"/"VOL"/"ABV". A bare "proof" line has no analogous
// false-positive pattern in the eval data, so it still qualifies on its own.
const ABV_CONTEXT = /\b(?:alc|vol|abv)\b/i;
```

Then change the `alcoholLine` selection (currently `lines.find((l) => (/%/.test(l) ||
/proof/i.test(l)) && !/GOVERNMENT/i.test(l)) ?? null;`) to:

```ts
const alcoholLine =
  lines.find((l) => !/GOVERNMENT/i.test(l) && ((/%/.test(l) && ABV_CONTEXT.test(l)) || /proof/i.test(l))) ?? null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 5: Verify against the full suite and real-world eval**

Run: `pnpm test` — expect all green.
Run: `pnpm eval` — expect `13/13 (100%)`, `8/8 (100%)`.
Run: `pnpm eval:real-world` — expect alcoholContent improved from `40/46` (other fields at their
prior post-fix values).
Run: `pnpm eval:history --set real-world --provider local-ocr --limit 2` — confirm the delta.

- [ ] **Step 6: Commit**

```bash
git add lib/vision/ocr-parser.ts lib/vision/ocr-parser.test.ts
git commit -m "Require ABV context alongside a bare percent sign for alcoholContent"
```

---

### Task 5: `healthWarningStatement` — bound the no-closing-period fallback

**Files:**

- Modify: `lib/vision/ocr-parser.ts`
- Test: `lib/vision/ocr-parser.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Add these three tests to `lib/vision/ocr-parser.test.ts`, near the existing
`healthWarningStatement` tests:

```ts
it("healthWarningStatement's fallback stops at a trailing website URL instead of appending it (Old-Tub-style)", () => {
  const text = [
    "GOVERNMENT WARNING: (1) ACCORDING TO THE SURGEON GENERAL, WOMEN SHOULD NOT DRINK ALCOHOLIC",
    "BEVERAGES DURING PREGNANCY BECAUSE OF THE RISK OF BIRTH DEFECTS (2) CONSUMPTION OF ALCOHOLIC",
    "BEVERAGES IMPAIRS YOUR ABILITY TO DRIVE A CAR OR OPERATE MACHINERY AND MAY CAUSE HEALTH",
    "PROBLEMS www.drinksmart.com 750 mL",
  ].join("\n");
  const r = parseOcrText(text, 0.9);
  expect(r.healthWarningStatement.value).not.toContain("www.drinksmart.com");
  expect(r.healthWarningStatement.value).not.toContain("750 mL");
});

it("healthWarningStatement's fallback stops at a trailing barcode digit run instead of appending it", () => {
  const text = [
    "GOVERNMENT WARNING: (1) ACCORDING TO THE SURGEON GENERAL, WOMEN SHOULD NOT DRINK ALCOHOLIC",
    "BEVERAGES DURING PREGNANCY BECAUSE OF THE RISK OF BIRTH DEFECTS AND MAY CAUSE HEALTH",
    "PROBLEMS 80686176022",
  ].join("\n");
  const r = parseOcrText(text, 0.9);
  expect(r.healthWarningStatement.value).not.toContain("80686176022");
});

it("healthWarningStatement still matches via the primary health-problems-anchored pattern when it closes cleanly (regression check)", () => {
  const text = [
    "GOVERNMENT WARNING: (1) ACCORDING TO THE SURGEON GENERAL, WOMEN SHOULD NOT DRINK ALCOHOLIC",
    "BEVERAGES DURING PREGNANCY BECAUSE OF THE RISK OF BIRTH DEFECTS. (2) CONSUMPTION OF ALCOHOLIC",
    "BEVERAGES IMPAIRS YOUR ABILITY TO DRIVE A CAR OR OPERATE MACHINERY, AND MAY CAUSE HEALTH",
    "PROBLEMS.",
  ].join("\n");
  const r = parseOcrText(text, 0.9);
  expect(r.healthWarningStatement.value).toMatch(/HEALTH PROBLEMS\.$/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts -t "healthWarningStatement's fallback stops at a trailing"`
Expected: both FAIL — the URL test's value contains `"www.drinksmart.com"` and `"750 mL"`; the
barcode test's value contains `"80686176022"`. The third (regression) test already passes today.

- [ ] **Step 3: Implement the minimal code change**

In `lib/vision/ocr-parser.ts`, find the warning match (currently):

```ts
const warningMatch =
  joined.match(/GOVERNMENT\s+WARNING:.*?health\s+problems\s*\./i) ?? joined.match(/GOVERNMENT\s+WARNING:.*$/i);
```

Change it to:

```ts
// If the closing "health problems." isn't found cleanly (common on real photos — OCR garbles the
// final period), stop the fallback capture at the first trailing URL or barcode/UPC digit run
// instead of running to end-of-string. Canonical § 16.21 warning text contains neither, so this
// can never clip real warning content — it only trims OCR noise appended after the statement.
const warningMatch =
  joined.match(/GOVERNMENT\s+WARNING:.*?health\s+problems\s*\./i) ??
  joined.match(/GOVERNMENT\s+WARNING:.*?(?=\s+(?:www\.|https?:\/\/|\d{4,})|$)/i);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 5: Verify against the full suite and real-world eval**

Run: `pnpm test` — expect all green.
Run: `pnpm eval` — expect `13/13 (100%)`, `8/8 (100%)`.
Run: `pnpm eval:real-world` — expect healthWarningStatement improved from `39/46` (other fields at
their prior post-fix values).
Run: `pnpm eval:history --set real-world --provider local-ocr --limit 2` — confirm the delta.

- [ ] **Step 6: Commit**

```bash
git add lib/vision/ocr-parser.ts lib/vision/ocr-parser.test.ts
git commit -m "Bound healthWarningStatement's fallback at a trailing URL or barcode"
```

---

### Task 6: Full verification sweep and final report

**Files:** none (verification only — no commit at the end unless a fix is needed).

**Interfaces:** none.

- [ ] **Step 1: Full unit suite, typecheck, lint**

Run: `pnpm test` — expect all green (241 pre-existing + however many new tests Tasks 1-5 added).
Run: `pnpm typecheck` — expect clean.
Run: `pnpm lint` — expect clean.

- [ ] **Step 2: Mock-tier eval (must not regress)**

Run: `pnpm eval`
Expected: `overall verdict accuracy: 13/13 (100%)`, `planted violations caught: 8/8 (100%)`. If this
regressed at any point across Tasks 1-5, it should already have been caught and fixed in that task —
this is a final confirmation, not the first check.

- [ ] **Step 3: Real-world eval — final numbers**

Run: `pnpm eval:real-world`
Record the final `overall verdict accuracy` and full per-field breakdown.

Run: `pnpm eval:history --set real-world --provider local-ocr --limit 6`
This prints all 6 entries recorded across Tasks 1-5 plus this final run, in order — the complete,
recorded improvement trail from the 16/46 (35%) baseline through each individual fix. This table
(not a hand-written summary) is the actual deliverable of this task: observability of the whole
phase's impact, matching the spec's stated posture (observability, not a pass/fail gate).

- [ ] **Step 4: Report**

No commit — this task only runs and reports. If every step above passed, the phase is complete. If
`pnpm eval:real-world`'s final numbers are still poor for any field despite all five fixes landing
cleanly, that's a finding to report (per the spec's Non-goals: bounding-box/font-size line scoring
is the next lever, explicitly out of scope for this plan), not a reason to keep expanding this
plan's heuristics.

---

## Self-review notes (writing-plans skill)

- **Spec coverage:** Motivation's five numbered root causes → Tasks 1-5 respectively (brandName
  positional restriction, nameAndAddress next-line fallback, classType vocabulary, alcoholContent
  ABV-context, healthWarningStatement fallback bound). Goals → each task independently verified via
  `pnpm eval:real-world` before the next starts (Task N Step 5 in every task). Non-goals → confirmed
  untouched: no bbox/confidence, no preprocessing, no `netContents`/`countryOfOrigin` changes, no
  `lib/matching` changes, no new CI gate (Task 6 reports, doesn't gate on real-world numbers).
  Testing section → all five described test cases map to Tasks 1-5 Step 1 exactly, including the two
  explicit regression checks (nameAndAddress same-line capture, alcoholContent bare-proof line,
  healthWarningStatement primary-pattern-still-works). File inventory → matches (`ocr-parser.ts`,
  `ocr-parser.test.ts` only, across all five tasks). Coordination note → informational only, no task
  required (the eval-history tooling it references is already merged and used throughout via
  `pnpm eval:history`).
- **Placeholder scan:** none found — every step has literal code/commands/expected output; the one
  "TBD"-shaped item (Change 3's Risks note about the vocabulary being broader than Phase 1's list) is
  carried into Task 3 Step 5 as an explicit "stop and report if flat/negative" instruction, not left
  as an open question.
- **Type consistency:** `ABV_CONTEXT: RegExp` (Task 4) is the only new named constant across all five
  tasks, defined once and used once, no signature drift. `structuredFieldIndices`,
  `firstStructuredFieldIndex`, `producerIsVerbPhraseOnly`, `producerNextLine` (Tasks 1 and 2) are
  each local to their own task's code block, not referenced elsewhere, so no cross-task naming
  conflicts to check.
