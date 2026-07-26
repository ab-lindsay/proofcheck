---
name: add-test-label
description: Use when adding a new sample label to the eval set (a new field case or planted violation) — keeps fixtures, rendered image, and expected.json in sync.
---

# Add Test Label

The mock fixtures in `lib/vision/mock.ts` are the single source of truth; images are rendered FROM them.

1. Add a new entry to `MOCK_FIXTURES` (filename key ending `.png`, values = what the label shows).
   For a planted violation, encode the violation in the fixture values (e.g. a title-case warning).
2. Add the matching entry to `eval/expected.json`: the application states the INTENDED values;
   `expected.overall` and `expected.violation` (field + verdictOneOf) describe what the matcher must say.
3. Run `pnpm samples` to render the new PNG into `eval/samples/`.
4. Run `pnpm eval` — must be 100% on mock. If the new case exposes a real matcher gap, fix the
   matcher (test-first, see tune-matching), not the expectation.
5. Commit fixture + image + expected.json together.
