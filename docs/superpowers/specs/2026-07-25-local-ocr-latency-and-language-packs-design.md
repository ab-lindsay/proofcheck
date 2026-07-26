# local-ocr real-photo latency + the multilingual OCR packs — design

**Date:** 2026-07-25 · **Product:** ProofCheck · **Repo:** `ttb-label-verifier`
**Companion to:** [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md),
[`2026-07-23-romance-language-ocr-design.md`](2026-07-23-romance-language-ocr-design.md) (the change
this revisits, on its own documented rollback path),
[`2026-07-24-agentic-extraction-escalation-design.md`](2026-07-24-agentic-extraction-escalation-design.md)
(the precedent: a measured null result retires a feature from the default path).

> **Summary.** `local-ocr` — the keyless default tier — breaches the < 5 s budget on real
> photographs (max 6577–7222 ms measured). The cause is the five-language Tesseract worker added
> 2026-07-23 for Romance-language labels. Measured against the 46-label real-world set, those extra
> packs deliver **zero** accuracy benefit: overall verdict accuracy is identical (23/46) across every
> language configuration, and the one apparent per-field gain is a scoring artifact, not a better
> read. This spec reverts the worker to English-only (the romance spec's own §B rollback path),
> keeps the free half of that feature (the parser's multilingual vocabulary), and closes the
> measurement gap that let a budget breach hide for two days.

---

## 1. Problem

### 1.1 The keyless default tier is over budget on real photos

`scripts/check-latency.ts --provider local-ocr --set real-world` (46 samples):

| metric  | measured    |
| ------- | ----------- |
| p50     | 477 ms      |
| p95     | 4224 ms     |
| **max** | **7136 ms** |

The brief's requirement is < 5 s end-to-end for a single-label verify. `local-ocr` is the tier a
reviewer hits with **zero setup** (invariant 4, keyless by default), so this is the demo's default
path, not an edge case. The slowest samples are ordinary real photographs:

| sample                                         | ms   | size    |
| ---------------------------------------------- | ---- | ------- |
| `malt-guinness-draught-stout-can.jpg`          | 7055 | 1259 KB |
| `spirits-old-tub-bourbon-front.jpg`            | 6422 | 234 KB  |
| `spirits-titos-handmade-vodka-back.jpg`        | 5971 | 490 KB  |
| `spirits-buffalo-trace-experimental-front.png` | 5932 | 858 KB  |
| `malt-samuel-adams-boston-lager-can.jpg`       | 4923 | 560 KB  |

Note that file size does not predict cost — the 234 KB bourbon photo costs nearly as much as the
1259 KB can. Cost tracks glyph density and image difficulty, not bytes.

### 1.2 Why it was invisible

Three compounding measurement gaps, all now fixed or fixed here:

1. **`check-latency` only ever measured 13 small synthetic samples** (`--set default`). Real
   photographs are larger, denser JPEGs and cost multiples more. Fixed in `e81c59b` (added `--set`).
2. **`check-latency` gates on p95 only.** It computes and prints `max`, but the PASS/FAIL verdict
   reads p95 alone — so a run printing `max 7136 ms` still prints `PASS: all tiers within the 5000ms
p95 budget`. **This bug is still live and is fixed by this spec (§4).**
3. **The romance-language spec's own latency gate was scoped as a one-time manual measurement.** Its
   §B decision gate measured a _cold-vs-warm single synthetic image_ (`old-tom-clean.png`, 1409 ms
   cold / 372 ms warm) and explicitly declined to assert latency in CI: _"latency varies by
   environment and isn't something to assert in CI."_ That measurement was accurate when taken and
   silently stopped reflecting reality as the real-world corpus grew to 46 photographs. Worth noting
   the gate was also run **post-hoc** — commit `74f791f` records that it "was never actually run
   before the 5-language worker shipped."

This is the third instance of one failure class in this project: **a measurement scoped as
"manual, run once" stops describing the system as the system changes.** The escalation ladder's
null result and `check-latency`'s inability to reach the cloud tier were the other two.

### 1.3 The cause

`lib/vision/local-ocr.ts` creates its worker with five language packs:

```ts
createWorker("eng+fra+spa+ita+por", 1, { cachePath: "/tmp" });
```

Added 2026-07-23 to support imported French/Spanish/Italian/Portuguese wine labels.

---

## 2. What the measurement actually says

All numbers below: `local-ocr`, real-world set (46 labels), single process, one explicitly
parameterised `createWorker` call per configuration, warm-up call before timing. Tesseract is
deterministic for a fixed input and configuration, so these deltas are **not** run-to-run noise.

### 2.1 Language-count sweep

| langs                           | brandName | **overall** | p50    | p95     | **max**     | budget   |
| ------------------------------- | --------- | ----------- | ------ | ------- | ----------- | -------- |
| `eng`                           | 31/46     | **23/46**   | 389 ms | 1399 ms | **2164 ms** | ok       |
| `eng+fra`                       | 31/46     | **23/46**   | 388 ms | 2910 ms | 3687 ms     | ok       |
| `eng+fra+spa`                   | 33/46     | **23/46**   | 396 ms | 2211 ms | 3846 ms     | ok       |
| `eng+fra+spa+ita+por` (shipped) | 33/46     | **23/46**   | 396 ms | 4099 ms | **6577 ms** | **OVER** |

**Overall verdict accuracy is identical — 23/46 — in every configuration.** No language
configuration changes a single PASS/FAIL outcome on 46 real labels. Per-field deltas from `eng` to
five packs: brandName +2, classType +1, healthWarningStatement +1, alcoholContent −1,
netContents −1, nameAndAddress 0, countryOfOrigin 0.

### 2.2 The apparent brandName gain is a scoring artifact

The entire +2 comes from two samples — and they are the **front and back of the same physical
bottle** (one distinct product, `OLD TUB`, an English brand name):

| sample                              | expected  | `eng`                                              | `eng+fra+spa`                                           |
| ----------------------------------- | --------- | -------------------------------------------------- | ------------------------------------------------------- |
| `spirits-old-tub-bourbon-front.jpg` | `OLD TUB` | `"SO ACADL BOTTLED AT"` (conf 0.21) → **MISMATCH** | `null` (conf 0.00) → **REVIEW** ✅ counted correct      |
| `spirits-old-tub-bourbon-back.jpg`  | `OLD TUB` | `"orp Tug"` (conf 0.46) → **MISMATCH**             | `"QLD Tug"` (conf 0.66) → **REVIEW** ✅ counted correct |

**Neither configuration ever reads the brand name correctly.** The multilingual packs did not
recognise anything better; they made the extractor _less certain_. Because both entries carry
`tolerant: true`, REVIEW is in the accepted verdict set, so degradation scores as improvement. On
the front label the multilingual worker returned **nothing at all**, and that counted as a win.

Zero of the 11 brand names that differ between configurations is a diacritic or foreign-word case.
Where the packs do change hard-photo output (`"Grate Htetioth."` → `"RATTLESNAKE HILLS"`), the
recovered text is **English** — this is extra traineddata marginally perturbing the base character
classifier, not a French or Spanish dictionary doing the work it was added to do.

### 2.3 The four Romance fixtures produce byte-identical output

The project's four dedicated Romance-language fixtures — the ones the feature was built and
validated against — return **identical raw OCR text** (421 / 396 / 395 / 402 characters, matching
exactly) and identical field verdicts under `eng` and `eng+fra+spa+ita+por`:

| fixture                           | `eng`                        | multilingual                 |
| --------------------------------- | ---------------------------- | ---------------------------- |
| `wine-french-cotes-du-rhone.png`  | PASS, all MATCH              | PASS, all MATCH              |
| `wine-spanish-rioja.png`          | PASS, countryOfOrigin REVIEW | PASS, countryOfOrigin REVIEW |
| `wine-italian-chianti.png`        | PASS, all MATCH              | PASS, all MATCH              |
| `wine-portuguese-vinho-verde.png` | PASS, all MATCH              | PASS, all MATCH              |

Across all 46 real-world entries, only **4 application fields** contain non-ASCII characters
(`"Rosé Wine"` ×2, `"Côtes du Rhône Rouge"`, `"España"`) and **none is a `brandName`**.

### 2.4 Why multilingual OCR was always the wrong end of the pipeline

`lib/ttb/normalize.ts`'s `normalizeLoose` — applied before every comparison — runs NFKD, strips
combining diacritical marks (`é` → `e`), and carries an explicit fold table for non-decomposable
Latin letters (`æ œ ø ß þ ð ł đ ħ`). The matcher is **already accent-blind**: `Château` and
`Chateau` verdict identically. Paying seconds of Tesseract scoring to preserve a distinction the
matcher deliberately discards microseconds later inverts the pipeline.

The residual theoretical benefit is narrow: language packs can help Tesseract choose `Château` over
`Chdteau`, and normalization cannot rescue a wrong **base letter** (`chdteau` ≠ `chateau` is a
MISMATCH). That effect is real in principle — and measured at zero here, on the only corpus we have.

---

## 3. Regulatory framing

Newly researched, and it sharpens _which_ field could justify multilingual OCR at all:

- **Distilled spirits — [27 CFR 5.55(a)](https://www.ecfr.gov/current/title-27/chapter-I/subchapter-A/part-5/subpart-D/section-5.55):**
  mandatory information "must appear in the English language, with the exception of the brand name
  and except as provided in paragraph (c)."
- **Malt beverages — 27 CFR 7.55(a):** identical wording.
  ([part 7 full text](https://www.govinfo.gov/content/pkg/CFR-2025-title27-vol1/xml/CFR-2025-title27-vol1-part7.xml))
- **Both §5.55(b) / §7.55(b):** additional foreign-language statements are permitted so long as they
  do not conflict with the requirements of the part.
- **Both §5.55(c):** mandatory information may be solely in Spanish for products bottled for
  consumption in **Puerto Rico**.
- **Health warning — [27 CFR 16.21](https://www.law.cornell.edu/cfr/text/27/16.21):** prescribes a
  verbatim English string. Part 16 is silent on language, but a translation cannot satisfy a literal
  required string, so the byte-exact check (invariant 3) is unaffected.
- **Wine — [27 CFR part 4](https://www.govinfo.gov/content/pkg/CFR-2025-title27-vol1/xml/CFR-2025-title27-vol1-part4.xml):**
  **no English-language provision exists.** Wine was not part of the Phase 2 modernization rule
  ([87 FR, Feb 9 2022](https://www.federalregister.gov/documents/2022/02/09/2022-00841/modernization-of-the-labeling-and-advertising-regulations-for-distilled-spirits-and-malt-beverages))
  that produced §5.55 and §7.55. Treat "wine mandatory info must be English" as TTB practice we
  could **not** verify in the CFR, not as a citable rule.

**Consequence.** For spirits and malt beverages, six of seven matched fields are English **by
regulation**; `brandName` is the explicit carve-out and therefore the only field where extra
language packs have a regulatory reason to help. §2.2 measures that field directly and finds no
genuine gain. For wine the carve-out is broader (no English rule at all), which is why the
`OCR_LANGS` override is retained rather than deleted (§4.2).

---

## 4. Design

### 4.1 English-only default for the OCR worker

`lib/vision/local-ocr.ts`:

```ts
/** Default OCR language pack. English-only: measured 2026-07-25 against the 46-label real-world
 *  set, adding fra/spa/ita/por changed ZERO overall verdicts (23/46 in every configuration) while
 *  costing 3.3x p95 latency and pushing max past the < 5 s budget (2164 -> 6577 ms). See
 *  docs/superpowers/specs/2026-07-25-local-ocr-latency-and-language-packs-design.md. */
const DEFAULT_OCR_LANGS = "eng";

/** Escape hatch, not a feature flag: 27 CFR 5.55(c) permits all-Spanish mandatory info for labels
 *  bottled for Puerto Rico, and wine (27 CFR part 4) carries no English-language requirement at
 *  all. A deployment serving such a corpus can restore packs (e.g. OCR_LANGS="eng+spa") and pay the
 *  latency knowingly. Optional — invariant 4 (keyless by default) is unaffected. */
const OCR_LANGS = process.env.OCR_LANGS?.trim() || DEFAULT_OCR_LANGS;
```

Rejected alternatives:

- **`eng+fra+spa` (the Pareto point on the raw sweep).** Gets `brandName` 33/46 at max 3846 ms,
  inside budget. Rejected once §2.2 established that the 33/46 is two REVIEW-not-MATCH degradations
  on one product — buying a scoring artifact for +78% max latency and 3× the traineddata footprint
  on an unauthenticated, un-rate-limited tier.
- **A tiered two-pass worker** (fast `eng` pass, multilingual re-pass when fields read weak). The
  trigger is _sound_ — both affected labels had weak English `brandName` (conf 0.21 / 0.46, below
  `CONFIDENCE_REVIEW_THRESHOLD`), so a narrow trigger catches 2/2 with no regressions, unlike the
  escalation ladder's confident-but-wrong problem. Rejected anyway: a broad "any weak field" trigger
  fires on **42/46 labels (91%)**, making nearly every request pay both passes (up to 2164 + 6577 =
  8741 ms, breaching the route's 8 s hard timeout); and the narrow trigger's entire prize is the
  §2.2 artifact. Two pooled workers, trigger logic, budget arithmetic, and merge logic to recover
  nothing measurable is the escalation ladder's lesson repeating.
- **In-browser Tesseract** (the original ARCHITECTURE risk-row fallback). Out of scope: it moves
  latency off the server rather than removing it, and rewrites the tier's execution model to fix a
  cost that a one-line default removes.

### 4.2 Keep the parser's multilingual vocabulary

`lib/vision/ocr-parser.ts`'s French/Spanish/Italian/Portuguese keyword tables (class/type terms,
producer-line patterns, country markers) are **retained unchanged**. They are pure string and regex
matching — no measurable runtime cost — and they do real work: routing `Mis en bouteille par…` or
`Produit de France` into the correct `ExtractedLabel` field. Only the _Tesseract language packs_ are
reverted. Deleting the free half of the Romance feature alongside the expensive half would discard
capability for no gain.

The four Romance eval fixtures are also retained: they pass under English-only (§2.3, proven
byte-identical), they cost nothing, and they guard the parser vocabulary against regression.

### 4.3 Fix the latency gate: assert on max, not just p95

`scripts/check-latency.ts` currently computes `max` but derives PASS/FAIL from p95 alone. A single
7 s request is exactly the user-visible failure the budget exists to prevent, and with 46 samples
p95 is the 44th value — structurally unable to see the tail.

Both thresholds, with a deliberate gap:

```ts
const BUDGET_MS = 5000; // p95 — the typical-case requirement
const MAX_BUDGET_MS = 8000; // max — the route's EXTRACT_TIMEOUT_MS: past this a user gets a 504
```

Rationale for two numbers rather than one: gating `max` at 5000 would make the gate hostage to the
single worst sample in a growing corpus and invite threshold-fudging. Gating `max` at the route's
own hard timeout asserts something categorical — **no sample may reach the point where the route
returns an error** — while p95 continues to assert the product budget. A tier that passes p95 but
fails max now reports `FAIL (max > 8000ms)` instead of `PASS`.

Under this design English-only measures p95 1399 ms / max 2164 ms — passing both with ~3.5× and
~3.7× margin, so the gate is achievable rather than aspirational.

### 4.4 Close the process gap: gate it in CI

Add a `check-latency` step to `.github/workflows/ci.yml` running `--provider local-ocr --set
real-world`. Justification: `local-ocr` needs **no API key** (invariant 4), so this runs keyless with
no secrets, exactly like the existing mock-tier eval gate. The cloud tiers stay out of CI (keys,
cost, quota) and remain a manual pre-deploy check.

CI runners are slower and noisier than a dev machine, so the p95/max thresholds above are set
against the route's own contract rather than tuned to local hardware. If CI proves too noisy in
practice, the honest fix is to raise the documented threshold with the measurement behind it — not
to silently drop the gate.

---

## 5. Threat / invariant analysis

| Invariant                                                       | Effect                                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — extraction proposes, matching disposes                      | Unaffected. No verdict logic changes; only which traineddata Tesseract loads.                                                                                          |
| 2 — every tier returns a Zod-validated `ExtractedLabel`         | Unaffected. `parseOcrText` and the schema boundary are untouched.                                                                                                      |
| 3 — health warning checked deterministically                    | Unaffected, and reinforced by §3: the statement is a verbatim English string per 27 CFR 16.21.                                                                         |
| 4 — keyless by default                                          | **Improved.** `OCR_LANGS` is optional; the default path now downloads one traineddata file instead of five.                                                            |
| 5 — keys server-side only                                       | Unaffected.                                                                                                                                                            |
| 6 — persist nothing                                             | Unaffected (`/tmp` traineddata cache is unchanged in kind, smaller in size).                                                                                           |
| 7 — fail closed, per item                                       | Unaffected. `prepareForOcr`'s best-effort catch and the worker self-heal path are untouched.                                                                           |
| 8 — label text is untrusted                                     | Unaffected. Fewer language models cannot widen an injection surface; OCR transcribes pixels and cannot follow instructions.                                            |
| 9 — escalation ladder off by default, blind to application data | Unaffected. This spec deliberately does **not** route through the ladder (§4.1): the fix must apply to every request by default, not only when the opt-in ladder runs. |

**Resource posture (improves).** `docs/ARCHITECTURE.md`'s risk table carries a row for the
five-pack worker raising memory and cold-start cost on the keyless, unauthenticated, un-rate-limited
tier. Reverting to one pack reduces that exposure; the row is updated to record the outcome rather
than deleted.

**Accepted limitation (documented, not hidden).** English-only OCR has a regulation-shaped blind
spot: `brandName` is the one field TTB permits in a foreign language (27 CFR 5.55(a) / 7.55(a)), and
wine carries no English requirement at all. A real photographed label with accented brand text could
read worse than under the five-pack worker. We have no such sample in the corpus, so the effect is
unmeasured in both directions. `OCR_LANGS` is the remedy for a deployment that needs it. Stating
this is stronger than pretending the trade-off does not exist.

---

## 6. Measurement plan

Re-run after implementation and record in the plan's verification notes:

1. `pnpm check-latency --provider local-ocr --set real-world` — **gate:** p95 < 5000 ms **and**
   max < 8000 ms. Expect ≈ p95 1399 ms / max 2164 ms.
2. `pnpm check-latency --provider local-ocr` (synthetic set) — regression check on the fast path.
3. `pnpm eval --provider local-ocr --set real-world` — **floor: overall must not fall below 23/46**,
   real-photo subset not below 5/21, planted violations 5/5. Expected: exactly 23/46 (§2.1).
   Per-field `brandName` is expected to read 31/46 rather than 33/46 — a known, explained
   consequence of removing the §2.2 artifact, **not** a regression to fix.
4. `pnpm eval --provider mock` — 13/13, 8/8 violations (matcher isolation, unchanged).
5. `pnpm eval:adversarial` — injection gate PASS (unchanged).
6. `pnpm test && pnpm lint && pnpm typecheck && pnpm build && pnpm e2e`.

**What a null looks like:** if English-only shows overall < 23/46, or the real-photo subset < 5/21,
the language packs were carrying real accuracy this analysis missed — restore `eng+fra+spa` (the
§4.1 Pareto point, inside budget) and record the contradiction rather than defending this spec.

---

## 7. Risks

| Risk                                         | Exposure  | Mitigation                                                                                                                                                                        |
| -------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A real accented-brand-name label reads worse | Low / Low | Documented blind spot (§5) with regulatory citation; `OCR_LANGS` override; no such sample exists in the corpus, so no measured regression.                                        |
| CI latency gate flakes on slow runners       | Med / Low | Thresholds tied to the route's contract (8 s hard timeout), not to local hardware; English-only holds ~3.7× margin on max. Raise with evidence if it flakes; never silently drop. |
| `tolerant: true` masks a future regression   | Med / Med | Recorded as a follow-up (§8) — out of scope here, but this spec exists because of it.                                                                                             |
| Reviewer reads this as feature-deletion      | Low / Low | The parser vocabulary and Romance fixtures are retained (§4.2); the commit and README record a measured trade, matching the escalation ladder's precedent.                        |

---

## 8. Follow-up (out of scope, recorded)

**`tolerant: true` scoring rewards uncertainty.** The flag was added so a real photo whose field is
genuinely unreadable is not scored as an extraction error — sound in intent. But it puts REVIEW in
the accepted set, so an extractor that returns `null` scores _better_ than one that guesses wrong.
That is precisely how a pure degradation registered as a `brandName` improvement (§2.2), and it will
mask regressions in any future `local-ocr` work.

Worth a separate spec. Sketch: score MATCH and REVIEW as distinct outcomes rather than pooling them
(e.g. report `matched / reviewed / missed` per field instead of one `correct` count), so
"the extractor gave up" is visible instead of indistinguishable from "the extractor was right."
Deliberately not bundled here — it changes eval semantics and would re-baseline every committed
number in `eval/history.jsonl`.

---

## 9. Files

**Modify**

| File                                                        | Change                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `lib/vision/local-ocr.ts`                                   | `DEFAULT_OCR_LANGS = "eng"` + `OCR_LANGS` override (§4.1)                             |
| `lib/vision/local-ocr.test.ts`                              | Update the language-string assertion; add an `OCR_LANGS` override test                |
| `scripts/check-latency.ts`                                  | `MAX_BUDGET_MS` gate alongside p95 (§4.3)                                             |
| `.github/workflows/ci.yml`                                  | Keyless `check-latency --provider local-ocr --set real-world` step (§4.4)             |
| `docs/ARCHITECTURE.md`                                      | Update the five-pack risk row to record the measured outcome; note the max-based gate |
| `README.md`                                                 | One line: keyless-tier latency, and the English-only trade with its blind spot        |
| `docs/superpowers/plans/2026-07-23-romance-language-ocr.md` | Annotate §B's gate as superseded by this measurement (honest history, not a rewrite)  |
| `.env.example`                                              | Document `OCR_LANGS` as optional                                                      |

**Unchanged (deliberately)**

`lib/vision/ocr-parser.ts` (multilingual vocabulary retained), the four Romance eval fixtures,
`lib/matching/*`, `lib/ttb/*`, the `ExtractedLabel` schema, the `/api/verify` contract, and
`lib/vision/escalation/*`.
