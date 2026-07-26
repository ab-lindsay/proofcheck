# ProofCheck — Test Coverage Gap Analysis (2026-07-22)

**Method:** Mapped every source file against its test file(s). Reviewed existing tests for missing branches and edge cases. Ran `pnpm test:coverage` (gated core: 98% statements, 91% branches, 100% functions, 99% lines — `lib/matching` + `lib/ttb` only).

**Result:** 7 source files have no test file. 7 existing test files have meaningful gaps.

---

## Source files with no test file

| Source file                   | Priority | What's untested                                                                                                                                                                                         |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks/use-batch.ts`          | High     | Concurrent queue logic (`CONCURRENCY = 5`), per-row error handling, `verifyOne()` fetch + parse, status transitions (`queued` → `running` → `done`/`error`), items state initialization from rows+files |
| `components/batch-table.tsx`  | Medium   | Sort-by-problems toggle, expand/collapse row details, `StatusPill` rendering for each status (`queued`, `running`, `done` PASS/FAIL, `error`), `rank()` function                                        |
| `app/page.tsx`                | Medium   | `loadSample` fetch + state updates (the bug from the audit), `onUpload` resets, `onSubmit` calls verify, sample button rendering                                                                        |
| `app/batch/page.tsx`          | Medium   | CSV upload parsing, images multi-file selection, `unmatchedImages` memo, `download()` helper, batch run trigger, results CSV download                                                                   |
| `app/layout.tsx`              | Low      | Static shell: header, nav links, skip-to-content link, theme toggle mount                                                                                                                               |
| `lib/utils.ts`                | Low      | `cn()` — trivial clsx+tailwind-merge wrapper                                                                                                                                                            |
| `lib/vision/sample-hashes.ts` | Low      | `isGenuineSample()` — tested indirectly via route security tests, but no isolated unit test for hash mismatch / unknown filename paths                                                                  |

---

## Existing tests with gaps

### `hooks/use-verify.test.ts` — 1 test

**Covers:** `reset()` clears a prior verdict.

**Missing:**

- Error path: `fetch` throws (network error) → `error` state set, `result` null.
- Error path: non-OK response (e.g. 500) → `error` from `body.error`.
- Loading state: `loading` is `true` during fetch, `false` after.
- `AbortSignal.timeout(30_000)` — verify the signal is passed to fetch (mock fetch, assert options).

### `components/verdict-card.test.tsx` — 2 tests

**Covers:** FAIL banner with reason + PASS with REVIEW items.

**Missing:**

- PASS banner with zero REVIEWs (clean pass, no amber warning bar).
- Cloud tier provider display: `result.tier === "cloud"` shows provider name.
- Pluralization: 1 REVIEW item ("needs") vs 2+ REVIEW items ("need").

### `components/field-row.test.tsx` — 2 tests

**Covers:** Cited field with eCFR link, field with no citation.

**Missing:**

- All three verdict styles render correct icon/color: MATCH (green check), MISMATCH (red X), REVIEW (amber triangle).
- `healthWarningStatement` has no citation (returns null from `citationFor`).
- Empty `applicationValue` renders "—" dash.
- Empty `labelValue` renders "not found".

### `components/application-form.test.tsx` — 3 tests

**Covers:** Empty brand blocks submit, form renders fields, submit calls onSubmit.

**Missing:**

- Alcohol content requiredness toggle: selecting "Distilled spirits" shows "Alcohol content" as required; selecting "Malt beverage" shows "(optional for this type)".
- Submit with valid data + file attached calls `onSubmit` with cleaned values.
- Submit button disabled when `fileAttached` is false.
- `defaultValues` prefills the form (sample preset path).

### `lib/csv.test.ts` — 10 tests

**Covers:** Template generation, parse with valid/invalid CSV, escape guards, results CSV.

**Missing:**

- `toResultsCsv` error rows: items with `status === "error"` render as `ERROR` with error message.
- Duplicate filename detection: second occurrence of same filename produces an error.
- Missing required columns: `missingHeaders` path returns error with column names.
- `escapeCsvCell` backtick/pipe (if those triggers are added per bug audit #4).

### `lib/matching/verify.test.ts` — 11 tests

**Covers:** Clean label, MISMATCH→FAIL, missing field→REVIEW, low confidence, table wine optional ABV, spirits required ABV, imported fields, confidence one-directional, empty string as missing.

**Missing:**

- Wine >14% ABV: alcohol content becomes required (`isAlcoholContentRequired` returns true when parsed ABV > 14).
- Wine with country of origin: `countryOfOrigin` field is compared when app provides it.
- Malt beverage: alcohol content optional even when present on label.
- `nameAndAddress` provided in app but missing on label → REVIEW.
- `countryOfOrigin` provided in app but missing on label → REVIEW.

### `app/api/verify/route.test.ts` — 8 tests

**Covers:** Genuine sample PASS, title-case FAIL, unsupported type, invalid JSON, oversized upload, magic-byte mismatch, VISION_PROVIDER=mock in production, beverageType echo.

**Missing:**

- Missing `application` field (not just invalid JSON) → 400.
- Empty file (`image.size === 0`) → 400.
- JPEG magic-byte sniff (ff d8 ff) accepted.
- WebP magic-byte sniff (RIFF...WEBP) accepted.
- `local-ocr` tier appends the OCR warning to `result.warnings`.
