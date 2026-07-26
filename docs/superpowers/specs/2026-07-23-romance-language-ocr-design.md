# Romance-language OCR on the keyless tier — design (2026-07-23)

## Motivation

`local-ocr` (the keyless default extraction tier) creates its Tesseract worker with
`createWorker("eng", 1, { cachePath: "/tmp" })` — English only. Cloud tiers are already
multilingual, and `lib/ttb/normalize.ts`'s `normalizeLoose` already NFKD-folds Romance diacritics
(é, ñ, ç, ã, etc.), so the matching layer has never been the problem. This was already identified
and deliberately deferred as backlog item #3 in
`docs/superpowers/specs/2026-07-22-ui-theming-and-regulation-references-design.md`:

> **Romance-language OCR on the keyless tier** — cloud tiers are already multilingual and
> `normalizeLoose` already folds diacritics; the gap is `local-ocr` using `createWorker("eng")`
> only. Add `fra/spa/ita/por` packs, weighing the added traineddata download + OCR latency against
> the <5 s budget.

Investigating this surfaced a **second, previously-undocumented gap**: `lib/vision/ocr-parser.ts`'s
field-detection regexes (class/type keywords, producer-line patterns, country-line patterns) are
English-vocabulary-only. Even with correct multilingual OCR text, a label reading "Mis en bouteille
par..." or "Produit de France" would still fail to populate `nameAndAddress` /
`countryOfOrigin` correctly. This spec covers both gaps together — an OCR-only fix would have
limited practical value on the real imported labels (French/Spanish/Italian/Portuguese wine, in
particular) that motivated it.

**Relationship to `docs/BRIEF.md`:** this is a stretch beyond the brief's core requirements — every
interview (Sarah/Dave/Jenny) and the Technical Requirements section describe English-label fields
only; multilingual OCR isn't asked for. It's justified as a direct extension of the real-world eval
work (`docs/superpowers/plans/2026-07-22-real-world-eval-images.md`), which is what surfaced genuine
imported labels carrying this vocabulary. Because the brief explicitly states _"a working core
application with clean code is preferred over ambitious but incomplete features. Document any
trade-offs or limitations,"_ this spec includes an explicit rollback path (§B): if the latency
decision gate fails and the fallback isn't worth the complexity, the change is reverted and
documented as a known limitation instead of shipped half-working.

## Goals

- Correctly OCR label text containing French, Spanish, Italian, or Portuguese vocabulary on the
  keyless `local-ocr` tier.
- Correctly bucket that OCR'd text into the right `ExtractedLabel` fields (`classType`,
  `nameAndAddress`, `countryOfOrigin`) via extended field-detection vocabulary.
- Validate both with new synthetic eval fixtures in the real-world set.
- Preserve the <5 s end-to-end / 8 s hard-timeout latency budget — verified empirically, with an
  explicit decision gate and rollback path rather than an assumption.

## Non-goals

- No client-facing language selector or settings panel (consistent with the project's existing
  "no general settings panel" decision in the UI theming spec).
- No language support beyond French, Spanish, Italian, Portuguese (e.g. German) in this pass.
- No vendoring of `.traineddata` — still a runtime CDN fetch cached to `/tmp`, same posture as
  today, just more files.
- No per-request language override — the worker stays a single shared singleton; this is a
  tier-wide capability upgrade, not a per-label choice.
- No changes to the health warning check — it's always printed in English by law regardless of a
  label's other-language content, and is already checked byte-exact/deterministic per invariant
  #3. Zero interaction with this feature.
- No changes to `normalizeLoose` or anything in `lib/matching` — already sufficient; the gap was
  always upstream, in extraction.
- No changes to cloud tiers — already multilingual.
- The two-pass design (fast English-only pass first, Romance bundle only on low confidence) is
  **not built in this pass** — it's the documented fallback if §B's decision gate fails.

## A. Language pack change (`lib/vision/local-ocr.ts`)

Single-line change:

```ts
// before
workerPromise = createWorker("eng", 1, { cachePath: "/tmp" }).catch(...)
// after
workerPromise = createWorker("eng+fra+spa+ita+por", 1, { cachePath: "/tmp" }).catch(...)
```

Everything else about the worker's lifecycle is unchanged: still a module-level singleton, still
lazily created on first use, still memoized in a promise, still self-healing (a rejected init
promise resets to `null` rather than permanently disabling the tier). Because it's a singleton, the
extra language-pack download cost lands once per server instance at cold init — not on every
request — which is what makes §B's empirical approach viable instead of assuming the worst case.

## B. Decision gate — extending `scripts/spike-ocr.ts`

The existing spike script already measures cold-vs-warm `local-ocr` latency against a 2.5 s warm
threshold. Extend it to run the 5-pack worker (post-§A change) against a real label image and
report cold and warm timings against **two** thresholds: the route's 8 s hard timeout
(`EXTRACT_TIMEOUT_MS` in `app/api/verify/route.ts`) and the product's <5 s end-to-end budget.

This run's output is the gate, with concrete thresholds so the outcome isn't a judgment call after
the fact:

- **Cold start completes in ≤ 6 s** (2 s margin under the 8 s hard timeout) **and warm requests stay
  ≤ 5 s** → ship the single combined worker as the final design. No further latency work needed.
- **Cold start exceeds 6 s, or warm requests exceed 5 s** → two paths, in order of preference:
  1. Build the two-pass fallback (English-only first; re-run with the Romance bundle only when
     confidence is low) as a follow-up task — protects the common English-label path's latency
     entirely, at the cost of a second OCR pass (and a second cold-start download) for the
     minority of labels that need it.
  2. If that's not worth the added complexity for a prototype, **revert §A and §C entirely** and
     document Romance-language OCR as a known limitation in the README's trade-offs section — the
     explicit rollback path from the Motivation section.

This measurement is run manually as part of implementation verification, the same way
`eval:real-world`'s accuracy numbers are reported rather than gated — latency varies by environment
and isn't something to assert in CI.

## C. Field-detection vocabulary extension (`lib/vision/ocr-parser.ts`)

Extend the existing keyword tables with per-language equivalents, alternated into the same regexes
(purely additive — the parsing _structure_, i.e. which regex maps to which `ExtractedLabel` field,
does not change):

- **Producer-line pattern** (currently `distilled|bottled|produced|brewed|imported|made by`): add
  `mis en bouteille par` (French), `embotellado por` (Spanish), `imbottigliato da` (Italian),
  `engarrafado por` (Portuguese).
- **Country-line pattern** (currently `PRODUCT OF` / `IMPORTED FROM`): add `produit de france`,
  `producto de españa`, `prodotto in italia`, `produzido em portugal` and equivalent phrasing.
- **`CLASS_KEYWORDS`** (currently English wine/spirit/beer terms): add `vin`/`vino`/`vinho`,
  `rouge`/`tinto`/`rosso`, `blanc`/`blanco`/`bianco`/`branco`, and similar common varietal/style
  vocabulary.

This is label vocabulary, not a regulatory claim (unlike the health warning constant), so no
citation requirement applies. `lib/matching` is untouched — invariant #1 ("extraction proposes,
matching disposes") holds exactly as it does today.

## D. Eval fixtures

Four new synthetic label samples — one per language — generated the same way
`eval/generate-samples.ts` renders today's synthetic fixtures (SVG text via `sharp`, not real
photos; no genuinely photographed French/Spanish/Italian/Portuguese label exists in
`eval/samples/SOURCES.md` today). Each is a plausible wine or spirits label using real label
vocabulary in that language, illustratively:

| Language   | Style                | Producer-line example     | Country-line example    |
| ---------- | -------------------- | ------------------------- | ----------------------- |
| French     | Côtes-du-Rhône-style | "Mis en bouteille par..." | "Produit de France"     |
| Spanish    | Rioja-style          | "Embotellado por..."      | "Producto de España"    |
| Italian    | Chianti-style        | "Imbottigliato da..."     | "Prodotto in Italia"    |
| Portuguese | Vinho Verde-style    | "Engarrafado por..."      | "Produzido em Portugal" |

Each still carries the mandatory English health warning (unaffected by the label's other-language
content, per TTB law) and a language-agnostic numeric ABV/net-contents line. Wired into
`eval/expected-real-world.json` with `tolerant: true` (same semantics established in the
real-world-eval-images plan) — never touches `eval/expected.json` or the mock-gated `pnpm eval` CI
gate, and run via `pnpm eval:real-world` for observability, not as a pass/fail gate. Exact label
copy is pinned in the implementation plan, not this spec.

## File/script inventory

New:

- 4 synthetic label images under `eval/samples/` (one per language)

Modified:

- `lib/vision/local-ocr.ts` (language string, §A)
- `lib/vision/ocr-parser.ts` (keyword tables, §C)
- `scripts/spike-ocr.ts` (extended latency measurement, §B)
- `eval/expected-real-world.json` (4 new `tolerant: true` entries, §D)
- `lib/vision/local-ocr.test.ts` (assert the new language string)
- `lib/vision/ocr-parser.test.ts` (one case per language)

Unchanged:

- `lib/matching/*`, `lib/ttb/*`, `eval/expected.json`, `eval/generate-samples.ts`,
  `lib/vision/mock.ts`, cloud tier providers, the `/api/verify` contract, the `ExtractedLabel`
  schema shape.

## Testing / verification

- `lib/vision/local-ocr.test.ts`: extend the existing mocked-`createWorker` test to assert
  `"eng+fra+spa+ita+por"` is the string passed, alongside the existing self-heal coverage
  (unchanged).
- `lib/vision/ocr-parser.test.ts`: one new case per language, feeding realistic OCR text through
  `parseOcrText` and asserting `classType`, `nameAndAddress`, and `countryOfOrigin` land correctly —
  mirroring the existing English cases.
- `scripts/spike-ocr.ts`: extended run reports cold/warm latency for the 5-pack worker against both
  the 8 s timeout and the <5 s budget — this is the §B decision-gate evidence, recorded in the
  implementation plan's verification notes.
- `pnpm eval:real-world`: the four new fixtures run through it for observability.
- `pnpm eval` (default, mock): unchanged, still 13/13 (100%), 8/8 planted violations caught.
- `pnpm typecheck && pnpm lint`: clean.

## Risks / open notes

- **Cold-start latency is the central open question** — see §B. This spec does not assume the
  answer; it's measured before the design is considered final.
- Eval fixtures are synthetic, not real photography — accepted here because the goal is validating
  the OCR + parser vocabulary pipeline, not sourcing new real-world images (that remains a separate,
  already-tracked gap in `SOURCES.md`).
- If scrapped per the rollback criterion, the revert is clean: this design touches only
  `lib/vision/local-ocr.ts`, `lib/vision/ocr-parser.ts`, `scripts/spike-ocr.ts`, and eval fixtures —
  no schema, API contract, or matching-layer changes to unwind.
