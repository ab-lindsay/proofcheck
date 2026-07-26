# Country of origin, required for imports — design

**Date:** 2026-07-26 · **Product:** ProofCheck · **Repo:** `ttb-label-verifier`
**Companion to:** [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md),
[`2026-07-21-alcohol-label-verification-design.md`](2026-07-21-alcohol-label-verification-design.md)
(base data model — this spec adds one field and one requiredness rule on top of it, the same shape
as `isAlcoholContentRequired`).

> **Summary.** The brief lists "Country of origin for imports" as a required label element
> (`docs/BRIEF.md:76`), but the field was always-optional with no notion of "imported" anywhere in
> the data model — an import application that omitted country of origin silently passed. This adds
> an explicit `isImport` flag to `ApplicationData` and a matching `isCountryOfOriginRequired` rule,
> mirroring the existing `isAlcoholContentRequired` pattern exactly.

---

## 1. Problem

`countryOfOrigin` (`lib/schema.ts`) is `z.string().optional()` with no conditional-requiredness
logic. In `lib/matching/verify.ts`, an absent `app.countryOfOrigin` simply skips the field —
no `FieldResult` row, no warning, nothing — even when the product is plainly an import (e.g. the
`kirkbride-import-wine` eval fixture has `countryOfOrigin: "France"` filled in by the fixture author,
but nothing in the code would have caught it if they hadn't).

## 2. Decision: an explicit `isImport` flag

Three ways to know an application is for an import were considered:

- **Infer from `countryOfOrigin`'s own presence.** Circular — the whole point is to require the
  field, so its presence can't be the signal that requires it.
- **Infer from `nameAndAddress` text** (e.g. "Imported by..."). That text is extracted-label data,
  not ground truth from the application, and its format isn't standardized enough to key
  requiredness off of.
- **An explicit boolean field on `ApplicationData`.** Chosen. Matches the existing `beverageType`
  precedent (`docs/ARCHITECTURE.md` invariant: "drives field REQUIREDNESS only"), is unambiguous,
  and is the only option a human filling out the form can state directly.

`isImport: z.boolean().optional()` (no `.default()`, consistent with every other optional field on
`ApplicationData` — `alcoholContent`, `nameAndAddress`, `countryOfOrigin` are all plain
`.optional()` with no default). `undefined` and `false` are both treated as "not an import" —
`isCountryOfOriginRequired` checks `app.isImport === true`. This means every existing
`ApplicationData` object literal in the codebase (samples, fixtures, tests) needed **zero**
changes for type-safety, and every existing eval/CSV fixture is unaffected (no `isImport` key →
requirement never fires → identical verdicts to before this change).

Regulatory basis: imported alcohol beverage containers must carry a country-of-origin statement
under U.S. Customs marking rules (19 CFR Part 134), and TTB's own COLA review checks for a
certificate of origin per 27 CFR 4.45 (wine) and 5.52(e) (distilled spirits) — see
[TTB's country-of-origin certification page](https://www.ttb.gov/import-export/itd/certificate-of-age-and-origin-requirements-for-imported-alcohol-beverages).

## 3. Data model diff

```diff
 interface ApplicationData {
   ...
   countryOfOrigin?: string;
+  isImport?: boolean; // drives countryOfOrigin requiredness only, mirrors beverageType/alcoholContent
 }
```

`lib/ttb/required-fields.ts` gains `isCountryOfOriginRequired(app): boolean { return app.isImport === true; }`
— same file, same shape as `isAlcoholContentRequired`.

## 4. Matching rule diff

`lib/matching/verify.ts` previously handled `nameAndAddress` and `countryOfOrigin` in one shared
loop (compare-if-present, else informational-warning-if-the-label-has-one). `countryOfOrigin` is
now split out to add a third branch, mirroring the `alcoholContent` required-field block that
already existed:

1. Application provides it → fuzzy-compare as before (COMPLIANT / NEEDS_CORRECTION / NON_COMPLIANT).
2. Application omits it **and `isCountryOfOriginRequired(app)`** → fail-closed, visible
   `NEEDS_CORRECTION` row ("Country of origin is required for imported products but was not
   provided in the application — request it."), not a buried warning.
3. Application omits it and it's not required (domestic) → unchanged: informational warning only
   if the label happens to show one, otherwise nothing.

`NEEDS_CORRECTION`, not `NON_COMPLIANT`, for the same reason `alcoholContent`'s missing-required-field
case uses it: this is an application-data gap TTB would ask the applicant to fix, not a label defect
— consistent with invariant 7 (fail closed per item) and the disposition semantics in `lib/schema.ts`.

## 5. Surfaces updated

- `lib/schema.ts` — `isImport` field.
- `lib/ttb/required-fields.ts` — `isCountryOfOriginRequired`.
- `lib/matching/verify.ts` — split countryOfOrigin out of the nameAndAddress loop, add the
  required-field branch.
- `lib/csv.ts` — new `is_import` column, accepted as `yes/true/1` (case-insensitive) → `true`,
  anything else → `false`. **Not** added to the CSV's required-headers check — a CSV written before
  this column existed still parses, defaulting every row to not-import (identical behavior to
  today). `buildTemplateCsv`/`buildSampleCsv` include the column going forward.
- `components/application-form.tsx` — a "This is an imported product" checkbox; checking it flips
  the country-of-origin field's label from "(optional)" to required and blocks submit with a
  plain-English error if it's left blank, mirroring the alcohol-content required-field UX exactly.
- `lib/samples.ts` — the bundled `kirkbride-import-wine.png` demo sample now sets `isImport: true`
  (it already had `countryOfOrigin: "France"`, so this doesn't change its verdict — it now also
  correctly exercises the new flag in the bundled demo/batch samples).

## 6. Test plan

- `lib/ttb/required-fields.test.ts` — `isCountryOfOriginRequired` is true iff `isImport === true`,
  independent of beverage type; false when unset.
- `lib/matching/verify.test.ts` — import missing country of origin → visible NEEDS_CORRECTION row;
  import with country of origin present → matches normally (COMPLIANT/APPROVED); domestic
  (isImport false/unset) omitting it → unaffected, no row (regression guard for existing behavior).
- `lib/csv.test.ts` — `is_import` parses `yes`/`true`/`1` case-insensitively to `true`, everything
  else to `false`; a CSV predating the column still parses with every row defaulting to `false`.
- `components/application-form.test.tsx` — label toggles optional→required on checking the import
  box; submit blocked with a plain-English error when checked and country of origin is blank;
  submits successfully once filled in.

Not covered by a new eval fixture (would need a rendered label image via the `add-test-label`
skill) — the unit-level coverage above matches how this project already tests matching rules per
CLAUDE.md ("pure functions with no I/O"). Adding an eval-set case demonstrating the end-to-end
NEEDS_CORRECTION disposition is a reasonable follow-up, not required for this change.
