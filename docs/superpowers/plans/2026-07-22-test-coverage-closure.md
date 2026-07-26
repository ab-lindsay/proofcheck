# Test Coverage Closure — Plan (2026-07-22)

Closes the gaps in `docs/test-coverage-gaps-2026-07-22.md`. Source of truth for the cases is that doc;
this plan partitions the work into independent, TDD-able units and records what's already done.

## Constraints

- **These are tests for existing code.** Write them to pass against current behavior. If a test
  surfaces a real bug, STOP and report it — do not change `lib/matching` (or any source) to make a test
  pass. Matching output must stay byte-identical (guard: `pnpm eval` → 13/13, 8/8 planted caught).
- Gate after each unit: `pnpm typecheck && pnpm lint && pnpm test`. Full suite must stay green.
- Follow existing test conventions: `fireEvent` (not user-event — not installed), `@vitest-environment node`
  for route tests, `vi.mock` for fetch/providers, Testing Library for components.
- Dedup: some cases were added by `6a1b394` (route/csv) and `deaaec4` (citations/verdict-card threading).
  Read the current test file first; add only what's missing.

## Already closed

- Final-review gaps: citation completeness, `beverageType`→citation threading, pre-paint theme resolution (`deaaec4`).
- Route/CSV bug-fix tests + backtick/pipe escape (`6a1b394`).

## Work items (each = one commit; independent unless noted)

### P1 — High

1. **`hooks/use-batch.ts`** → new `hooks/use-batch.test.ts`. Mock `fetch`. Cover: `verifyOne()` success →
   `done` with `result`; failure (non-OK / throw) → `error` with message; status transitions
   `queued`→`running`→`done`/`error`; bounded concurrency (`CONCURRENCY = 5` — never more than 5 in
   `running` at once; use deferred fetch promises to observe); `items` initialized from `rows` + `files`;
   a row whose image file is missing is handled per current behavior.

### P2 — Medium (untested source files)

2. **`components/batch-table.tsx`** → new test. Sort-by-problems toggle (FAIL/REVIEW first); expand/collapse
   row details (`aria-controls`/`openRow`); `StatusPill` for each status (`queued`/`running`/`done` PASS &
   FAIL/`error`); `rank()` ordering.
3. **`app/page.tsx`** → new test. `loadSample` success (sets file/preview/preset, `formKey` bump) and
   failure (fetch !ok → `sampleError` shown, no file set); `onUpload` clears prior result/sample;
   `onSubmit` calls verify only when a file is attached; sample buttons render.
4. **`app/batch/page.tsx`** → new test. CSV upload → `rows`/`csvErrors` from `parseApplicationsCsv`;
   images multi-select populates `files`; CSV re-upload resets `files` + input; `unmatchedImages` memo;
   run button enablement (rows>0 && files>0 && !running); results-CSV download enablement.

### P3 — Low (untested source files)

5. **`app/layout.tsx`** → new test. Renders header/brand, nav links (Single/Batch), skip-to-content link,
   and mounts `ThemeToggle` (radiogroup present). (May need `@vitest-environment jsdom` + font/script stubs.)
6. **`lib/utils.ts`** → new test. `cn()` merges + de-dupes Tailwind classes (conflicting utilities resolve
   last-wins; falsy args dropped).
7. **`lib/vision/sample-hashes.ts`** → new test. `isGenuineSample()`: genuine bytes+name → true; right name
   wrong bytes → false; unknown filename → false.

### P4 — existing-test gaps (each edits one existing file — do NOT run two in parallel on the same file)

8. **`hooks/use-verify.test.ts`**: fetch throws → `error` set, `result` null; non-OK → `error` from
   `body.error`; `loading` true during / false after; `AbortSignal.timeout(30_000)` passed to fetch.
9. **`components/verdict-card.test.tsx`**: clean PASS (no amber review bar); cloud tier shows provider name;
   pluralization "1 item needs" vs "2 items need".
10. **`components/field-row.test.tsx`**: MATCH/MISMATCH/REVIEW icon+style each; `healthWarningStatement` →
    no citation (null); empty `applicationValue` → "—"; null `labelValue` → "not found".
11. **`components/application-form.test.tsx`**: ABV requiredness label toggles (spirits required vs malt
    "(optional…)"); valid submit + file → `onSubmit` with cleaned values; submit disabled when no file;
    `defaultValues` prefill.
12. **`lib/csv.test.ts`**: `toResultsCsv` error rows (`status==="error"` → `ERROR` + message); duplicate
    filename error; missing-required-columns error. (Backtick/pipe escape: verify `6a1b394` covered it.)
13. **`lib/matching/verify.test.ts`**: wine >14% ABV → required; wine w/ country compared; malt ABV optional
    when present on label; `nameAndAddress` in app but missing on label → REVIEW; `countryOfOrigin` same.
14. **`app/api/verify/route.test.ts`**: missing `application` field → 400; empty file (`size===0`) → 400;
    JPEG magic-byte accepted; WebP magic-byte accepted; `local-ocr` tier appends OCR warning. (Verify
    overlap with `6a1b394`'s route tests first.)

## Suggested order (by value/independence)

P1 (#1) → P2 (#2–4) → P4 matching/hook/component gaps (#8–13, high logic value) → P3 trivial (#5–7) →
route gaps (#14). Items touching distinct files are independent; P4 items each own one existing file.
