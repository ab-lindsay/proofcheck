# OCR language scope — what TTB actually requires

**Status:** research note — acted on. English-only is now the default; see [Current state](#current-state).
**Date:** 2026-07-25

## Why this exists

`lib/vision/local-ocr.ts` loaded five Tesseract language models, hardcoded (this is the state that
prompted the note; it has since changed — see [Current state](#current-state)):

```ts
createWorker("eng+fra+spa+ita+por", 1, { cachePath: "/tmp" });
```

Tesseract scores every candidate word against **every** loaded model, so recognition cost scales
with the language count times the amount of text-like material in the image. That lands on dense
photographs of cans and bottles and not on clean synthetic labels — which matches the measured
latency profile of this tier exactly (p95 1494 ms on the 13 small synthetic samples; **max 6731 ms**
on real photographs, against a 5 000 ms end-to-end budget).

Before treating the language count as a latency knob, the prior question is whether five languages
are _justified_ — i.e. whether the fields ProofCheck actually compares can lawfully be non-English.
This note answers that from the regulations.

## What the regulations say

TTB's Phase 2 labeling modernization (effective 11 March 2022) put the language rule in its own
section for distilled spirits and malt beverages. Both read identically:

| Beverage type     | Provision                                                                                                 | Requirement                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Distilled spirits | [27 CFR 5.55](https://www.ecfr.gov/current/title-27/chapter-I/subchapter-A/part-5/subpart-D/section-5.55) | Mandatory information in English, **except the brand name** |
| Malt beverages    | [27 CFR 7.55](https://www.ecfr.gov/current/title-27/chapter-I/subchapter-A/part-7/subpart-D/section-7.55) | Same wording                                                |
| Wine              | part 4                                                                                                    | **No English-language provision found** — see below         |

**§ 5.55(a) / § 7.55(a) — General:**

> Mandatory information must appear in the English language, with the exception of the brand name and
> except as provided in paragraph (c) of this section.

**§ 5.55(b) / § 7.55(b) — Foreign languages:**

> Additional statements in a foreign language, including translations of mandatory information that
> appears elsewhere in English on the label, are allowed on labels and containers as long as they do
> not in any way conflict with, or contradict, the requirements of this part.

**§ 5.55(c) / § 7.55(c) — Puerto Rico:** mandatory information may be stated **solely in Spanish** on
labels of products bottled for consumption within the Commonwealth of Puerto Rico.

### The health warning statement

[27 CFR 16.21](https://www.law.cornell.edu/cfr/text/27/16.21) prescribes the statement as a literal
English string beginning `GOVERNMENT WARNING:`. Part 16 is _silent_ on language — there is no
express English requirement and no foreign-language provision — but because the required text is a
verbatim English string, a translation cannot satisfy it. The byte-exact check in `lib/ttb` is on
solid ground independent of the language rule.

### Wine is a gap — do not overstate it

Wine was not included in the modernization that produced §§ 5.55 and 7.55, and there is **no
analogue section in part 4**. A full-text pass over the current part 4 found no English-language
provision for mandatory label information.

> Treat "wine mandatory information must be in English" as TTB practice that could not be verified
> in the CFR, **not** as a citable rule. Do not put it in UI copy or docs as a regulatory claim.

## What this implies for extraction

Of the seven fields the matcher compares:

| Field                                                                             | Language status                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `classType`, `alcoholContent`, `netContents`, `nameAndAddress`, `countryOfOrigin` | English by rule (spirits, malt beverages)              |
| `healthWarningStatement`                                                          | English by prescribed text (§ 16.21)                   |
| `brandName`                                                                       | **Expressly carved out — may lawfully be non-English** |

So the regulation removes the justification for foreign-language models on six of seven fields and
preserves a narrow one for exactly one: the brand name.

### Diacritics are already handled, and not by OCR

`normalizeLoose` in `lib/ttb/normalize.ts` applies NFKD, strips combining diacritical marks
(é → e), and folds non-decomposable Latin letters (æ, œ, ø, ß, þ, ð, ł, đ, ħ) before comparison.
`Château` and `Chateau` therefore produce identical verdicts already.

This matters for the language decision: extra language models buy **nothing** for accent handling,
because the matcher discards accents microseconds later anyway. What they could still buy is better
_base-letter_ recognition — a French dictionary helps Tesseract choose `Château` over `Chdteau`, and
normalization cannot rescue that (`chdteau ≠ chateau` is a MISMATCH). That effect is real but narrow,
and it is empirical rather than regulatory.

## Decision gate

Any change to the language set must be judged on the **`brandName` per-field number**, not on overall
accuracy. Overall is too coarse — brand name is the only field where the four extra models have a
regulatory reason to help, so a change there would be diluted to invisibility in the aggregate.

```bash
pnpm eval --provider local-ocr --set real-world   # compare brandName correct/total, before vs after
```

If `brandName` holds under English-only, English-only is correct and this note is the rationale. If
it drops measurably, widen the set on the evidence — not on a guess.

## Known limitation to state, not hide

An English-only default has a regulation-shaped blind spot: the brand-name carve-out in § 5.55(a),
and lawful all-Spanish labels under § 5.55(c). Both are narrow, neither is imaginary. If a
server-side language override exists, those are its legitimate use cases.

## Current state

Resolved. Everything this note describes as pending has landed on `main`:

- `DEFAULT_OCR_LANGS = "eng"`, with `OCR_LANGS` as a documented env override and the cost rationale
  in the source comment (`d85377b`, then extended with the override tests in the
  `worktree-fix-batch` merge). The regulatory carve-outs in [Known limitation](#known-limitation-to-state-not-hide)
  above are that override's stated use cases.
- `check-latency` gates `max` at the route's `EXTRACT_TIMEOUT_MS` alongside the p95 product budget,
  so a single slow sample can no longer hide behind the percentile.
- The two diagnostic scripts are committed and wired as `pnpm diagnose:ocr-langs` and
  `pnpm diagnose:ocr-latency`. `knob-check.ts` is gone as a separate file — it printed the effective
  language configuration, which `diagnose:ocr-langs` now does as its first output line.

The measurement that justified all of it is in
[2026-07-25-local-ocr-latency-and-language-packs-design.md](2026-07-25-local-ocr-latency-and-language-packs-design.md):
adding `fra/spa/ita/por` changed **zero** overall verdicts (23/46 in every configuration) while
costing ~3.3x p95. The apparent per-field gain was a `tolerant: true` scoring artifact — the extra
packs made the extractor return `null` on a brand name it never read correctly either way, and
REVIEW counts as correct on tolerant entries. That scoring flaw is a separate open item; it will
mask regressions in any future accuracy work.

## Sources

- [27 CFR part 5 — full text (govinfo, 2025 edition)](https://www.govinfo.gov/content/pkg/CFR-2025-title27-vol1/xml/CFR-2025-title27-vol1-part5.xml) — § 5.55 verified here
- [27 CFR part 7 — full text (govinfo, 2025 edition)](https://www.govinfo.gov/content/pkg/CFR-2025-title27-vol1/xml/CFR-2025-title27-vol1-part7.xml) — § 7.55 verified here
- [27 CFR part 4 — full text (govinfo, 2025 edition)](https://www.govinfo.gov/content/pkg/CFR-2025-title27-vol1/xml/CFR-2025-title27-vol1-part4.xml) — searched, no English-language provision
- [27 CFR part 16 — full text (govinfo, 2025 edition)](https://www.govinfo.gov/content/pkg/CFR-2025-title27-vol1/xml/CFR-2025-title27-vol1-part16.xml) · [§ 16.21 (Cornell LII)](https://www.law.cornell.edu/cfr/text/27/16.21)
- [Modernization of the Labeling and Advertising Regulations for Distilled Spirits and Malt Beverages, final rule (9 Feb 2022)](https://www.federalregister.gov/documents/2022/02/09/2022-00841/modernization-of-the-labeling-and-advertising-regulations-for-distilled-spirits-and-malt-beverages)
