---
name: add-batch-test
description: Use when adding a batch test case to the eval set (a CSV-parsing edge case or a batch-shaped matcher scenario) — keeps CSV fixtures, expected results, and images in sync.
---

# Add Batch Test

Add a new batch test case to the eval set — keeps CSV fixtures, expected results, and images in sync.

## What this set does and does not cover

`pnpm eval:batch` measures **CSV parsing and matcher accuracy over batch-shaped inputs**. It calls
the vision provider directly; it does **not** exercise `POST /api/batch`. Multipart parsing, the
per-image security guards, the concurrency pool, and result ordering are covered by
`app/api/batch/route.test.ts` — add cases there, not here, when the endpoint itself is what changed.

## Workflow

1. **Create CSV fixture** in `eval/fixtures/batch/`:
   - Use template headers: `image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin`
   - Images must exist in `eval/samples/` and, for `--provider mock`, have a `MOCK_FIXTURES` entry in
     `lib/vision/mock.ts` (the mock tier keys off filename and throws for anything it doesn't know)
   - Name descriptively (e.g. `concurrency-pair.csv`, `missing-image.csv`)

2. **Add entry to `eval/expected-batch.json`**:
   ```json
   {
     "csv": "your-fixture.csv",
     "images": ["image1.png", "image2.png"],
     "expected": {
       "overall": "APPROVED | NEEDS_CORRECTION | REJECTED — REJECTED if the CSV produced any parse error or any row was REJECTED/errored, else NEEDS_CORRECTION if any row needs correction, else APPROVED",
       "parsedRows": 2,
       "parseErrors": ["substring of each error the CSV must produce"],
       "rows": [
         { "filename": "image1.png", "overall": "APPROVED", "violation": null },
         { "filename": "image2.png", "overall": "REJECTED", "violation": { "field": "fieldName", "verdictOneOf": ["NON_COMPLIANT"] } }
       ]
     },
     "tags": ["regression | csv-parsing | concurrency | error-handling"]
   }
   ```

   Every field above is asserted. In particular:
   - **`parsedRows`** is required. It must equal the number of rows the CSV parses to, and
     `rows` must have exactly that many entries. This is what makes a fixture that parses to nothing
     (an empty CSV, a rejected header) a checked outcome instead of a silently skipped one.
   - **`rows` is matched to parsed rows by index**, and each `filename` is checked — so the order in
     `rows` must be the CSV's order.
   - **`parseErrors`** is exact: the error count must match too. Omit it when the CSV parses cleanly.
     Use a distinctive substring, not "error" — "some error happened" must never stand in for "the
     right error happened".
   - **`violation`** is checked on its own field: the named field's verdict must be one of
     `verdictOneOf`. A row reporting the right overall verdict for the wrong reason is a failure.
   - **`expectError: true`** on a row means it must fail *before* producing a verdict (e.g. its image
     file is absent). Without this flag a thrown exception is always scored as wrong — never as a
     convenient REJECTED.

3. **Run eval** — `pnpm eval:batch` must pass, and it exits non-zero on any failing check (including
   zero checks, e.g. a `--tags` filter that matches nothing). If the new case exposes a real matcher
   gap, fix the matcher (test-first, see tune-matching), not the expectation.

4. **Commit** CSV fixture + `expected-batch.json` entry together.

## Tags

- `regression` — end-to-end batch smoke test
- `csv-parsing` — CSV edge cases (empty, duplicates, missing columns)
- `concurrency` — batch-shaped input where per-row results must be independent
- `error-handling` — missing images, invalid data, mixed results

Filter with `pnpm eval:batch --tags csv-parsing,error-handling`.
