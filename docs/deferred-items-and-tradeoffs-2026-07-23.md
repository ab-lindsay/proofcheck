# ProofCheck — local-ocr Accuracy Work: Current State (2026-07-23)

Companion to `docs/superpowers/specs/2026-07-23-local-ocr-field-selection-robustness-design.md`
(Phase 1), `docs/superpowers/specs/2026-07-23-local-ocr-field-selection-phase-2-design.md`
(Phase 2), and `docs/superpowers/specs/2026-07-23-eval-run-history-design.md`. Records where the
real-world extraction-accuracy effort actually stands, what was tried and blocked, and the
recommended next step — so a future session (or a future me) doesn't have to re-derive any of this
from git history.

## What shipped today

| Work                                                 | Outcome                                                                                                                                                                                                                                                                                                                           | Key commits                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Eval run-history persistence                         | `pnpm eval` / `pnpm eval:real-world` now auto-record a summary to committed `eval/history.jsonl` and per-item detail to gitignored `eval/.results/`; `pnpm eval:history` reads it back as a table.                                                                                                                                | `8c8cd32`, `e7f28fc`, `b7947f0`, `f7f6854`, merged `06fcc17`            |
| Phase 1 (local-ocr field-selection robustness)       | `classType` shortest-match-wins instead of first-match; `brandName` plausibility filter (word count, comma, denylist, digit/symbol noise). Plus an unrelated but compounding fix: `PSM.SINGLE_COLUMN` so tesseract stops dropping the brand line entirely.                                                                        | `2227f44`, `3ebda6c`, `13be667`, `96d9569`                              |
| Phase 2 (five evidence-backed field-selection fixes) | `brandName` positional restriction (+4), `nameAndAddress` next-line fallback (correct, real-world-flat), `classType` vocabulary expansion (correct, real-world-flat in aggregate but a genuine per-image win), `alcoholContent` ABV-context requirement (+4), `healthWarningStatement` fallback bound (correct, real-world-flat). | `f73d79e`, `1fe353c`, `6d88562`, `0d2d1c1`, `f7ce628`, merged `114862a` |

**`pnpm eval:real-world` trajectory** (local-ocr tier, 46-entry real-world set): **10/42 (24%)** →
(Phase 1 + PSM fix) → **16/46 (35%)** → (Phase 2) → **17/46 (37%)**. Per-field, final state:
brandName 30/46, classType 30/46, healthWarningStatement 39/46, alcoholContent 44/46, netContents
44/46, nameAndAddress 27/36, countryOfOrigin 10/10. Planted violations 5/5 throughout. Mock-tier
gate held at 13/13 (100%), 8/8 (100%) the entire time — no matcher regressions.

## Why the overall number moved so little despite real per-field gains

Overall PASS/FAIL is an AND across 7 fields — one MISMATCH fails the whole item. Per-image detail
analysis (`eval/.results/real-world-local-ocr.json`) shows failures are **correlated, not
independent**: of 46 images, 19 have zero wrong fields, but 13 are exactly _one_ field away from
passing (8 blocked solely by brandName, 5 solely by classType). Fixing a field on an image that
still has another broken field never flips that image's overall verdict. brandName's Phase-2 gain
of +4 correct field-verdicts landed on zero such "last domino" images; alcoholContent's +4 happened
to include exactly one, which is the entire source of the +1 overall gain.

Of the 13 remaining one-field-away images: 3 share one exact, unfixable-by-text-heuristics cause
(the La Crema _back_-label images never print "CHARDONNAY" as text at all — it's front-panel-only);
most of the rest are severe-degradation OCR noise (`"Le NT BABI. hg ..—— —"` etc.); 2 are arguably
not extraction bugs but matching-layer near-misses (`"Tito's Handmade Vodka"` vs. expected `"Vodka"`
— a correct superset scored as MISMATCH).

**Split by fixture type** (also worth tracking going forward, not just the blended 37%): plain real
photos pass at 4/21 (19%); deliberately-degraded fixtures pass at 13/25 (52%) — higher, because most
degraded fixtures are synthetic labels (simple layout) degraded after the fact, which stays more
OCR-friendly than a messy real product photo even after blur/skew/glare. The blended number
understates how hard the plain-real-photo subset actually is.

## The deeper finding: confident-wrong beats honest-uncertain

Every real-world eval entry is `tolerant: true` — REVIEW already counts as a correct outcome, not
just MATCH. The actual failure mode on the unrecoverable images isn't REVIEW (already accepted), it's
**confident MISMATCH on garbage text**. Root cause: `lib/vision/ocr-parser.ts`'s per-field
confidence is `field(brandLine, c * 0.6)` — `c` is one blanket confidence number for the whole
image, times a fixed per-field weight. It has no signal for "the specific line I picked is garbage,"
only "how did OCR do on this image overall." A garbled brand line sitting in an otherwise-decent scan
still inherits a confident-looking score and produces a wrong answer instead of an honest REVIEW.

**This reframes the next investment**: better OCR _text_ accuracy on unrecoverable images is a
losing battle; making the system correctly recognize low-confidence _selections_ (not just
low-confidence images) and downgrade them to REVIEW is cheaper and matches the project's own
fail-closed design philosophy (invariant 7, `CLAUDE.md`).

## Gemini cloud-tier comparison — attempted, blocked

Tried to benchmark the `gemini` provider tier against the same 46-image real-world set, on the
theory that a vision-language model doesn't have to _guess_ prominence/layout from flat OCR text
order — it can see the image. Two blockers hit in sequence:

1. First attempt silently re-ran `local-ocr`: `pnpm eval:real-world` (the npm script) already
   hardcodes `--provider local-ocr`; appending `--provider gemini` after it left the _first_
   `--provider` flag (local-ocr) winning, since `eval/run.ts` uses `indexOf("--provider")`. Fixed by
   invoking `tsx eval/run.ts` directly instead of through the npm script alias.
2. Second attempt hit the Gemini free tier's **daily** quota (`limit: 20`,
   `generate_content_free_tier_requests`), already exhausted — almost certainly by earlier
   development work in this project (the Romance-language OCR latency-gate spike, `scripts/spike-ocr.ts`,
   made real Gemini calls). All 8 attempts before the run was stopped failed (mix of `503 Service
Unavailable` and `429 Too Many Requests`) — **zero successful comparison data points**, not a
   partial result to draw conclusions from.

**Status: unresolved, deferred.** Options on the table, not yet decided: wait for the daily quota to
reset; set up billing on the Gemini project (user's call, not something an agent can do); or
acquire and cycle through additional API keys (flagged as a ToS consideration worth being aware of —
most providers, likely including Google, prohibit using multiple free-tier keys/accounts specifically
to evade a rate limit, even though nothing about checking OCR accuracy on a personal project is
high-risk in itself).

## Recommended next step

Per-session discussion, the user chose to pivot to local-only work rather than wait on the cloud
comparison: **consume Tesseract's bounding-box/font-size data** (`data.blocks`, already returned by
the existing `recognize()` call but currently discarded) instead of guessing brand/class prominence
from flat text order. This was explicitly flagged and deferred in the Phase 1 design spec's
Non-goals ("noted here because it's free data... not because it's technically hard") and never
built. It's also the natural fix for the confidence problem above — real per-line confidence instead
of one blanket per-image number. Not yet brainstormed/spec'd as of this doc.

## Update 2026-07-24 — line-level prominence and confidence

Implemented `docs/superpowers/specs/2026-07-24-local-ocr-prominence-and-confidence-design.md`:
Tesseract's per-line bbox/confidence (previously not even requested) now drives brandName/classType
selection (tallest candidate wins, replacing word-count/reading-order guesses) and every field's
confidence/boundingBox (replacing the blanket per-image number). Confidence is now shown in the UI
(tier + percentage) for the first time.

`pnpm eval:real-world` (local-ocr tier): **17/46 (37%)** → **17/46 (37%)**. Per-field:
healthWarningStatement 39/46 · brandName 30/46 · classType 30/46 · alcoholContent 44/46 · netContents 44/46 · nameAndAddress 27/36 · countryOfOrigin 10/10. Mock-tier gate held at 13/13 (100%).

**Interpretation**: every per-field count above is bit-for-bit identical to the Phase 2 baseline
(brandName 30/46, classType 30/46, healthWarningStatement 39/46, alcoholContent 44/46, netContents
44/46, nameAndAddress 27/36, countryOfOrigin 10/10 — unchanged in every single field, not just in
aggregate). Checked per-item (not just aggregate) whether this is because prominence never disagreed
with the old word-count/order heuristic — it isn't: diffing per-item extraction values between the
pre-plan baseline and this commit shows **7 of 46 images had at least one field where the two
algorithms picked a genuinely different line.** Prominence is doing real, different work; it just
never flipped a verdict, in either direction, on this set.

Of those 7, three are exactly the "last domino" one-field-away-from-passing images identified earlier
in this doc (`spirits-makers-mark-founders-series-front.jpg`,
`wine-chateau-ste-michelle-grenache-blanc-front.jpg`,
`degraded/spirits-old-tub-bourbon-back-combo.jpg` — all blocked solely by brandName) — the exact
places a fix would have had to land to move the overall number. Dumping Tesseract's raw per-line
output for these three directly (not inferring from the eval summary) shows why prominence still
couldn't win there:

- **Maker's Mark**: the brand title was never recognized as clean text at all. The closest OCR
  candidate is the fragment `"y Mark:"` — "Maker's" is missing entirely. No selection algorithm can
  pick text that was never in the candidate pool.
- **Chateau Ste Michelle**: the words "Chateau," "Ste," and "Michelle" appear **nowhere** in the raw
  OCR text — not garbled, simply absent. The only brand-shaped candidates are a secondary vineyard
  name ("DINEEN FAMILY VINEYARDS") and marketing prose.
- **OLD TUB**: this fixture is the **back** label (`-back-combo.jpg`), combined with heavy synthetic
  degradation (blur+skew+glare+lowres). The brand name is only printed on the front panel — it isn't
  reasonable to expect it here regardless of degradation.

**Conclusion**: on all three of the images where a selection fix could have mattered, the ceiling is
OCR _text recognition_, not selection _logic_ — there was no correct candidate for prominence (or any
heuristic) to find. This confirms, with concrete per-image evidence rather than assumption, the
category of limitation this doc's "Known platform limitations" section already anticipated. The
prominence/confidence work still trades the prior blanket-per-image confidence model for real per-line
signals, enabling more honest REVIEW outcomes (now visible in the UI) and laying groundwork for
confidence-based filtering in a future phase — but that value isn't visible in this particular metric,
and shouldn't be expected to move it further without also improving OCR recognition itself (e.g. image
preprocessing — contrast/deskew — was explicitly out of scope for Phase 1/2 and this work). No
regression — mock-tier gate remained at 100%.

## Update 2026-07-24 (later same day) — image preprocessing

Implemented `docs/superpowers/specs/2026-07-24-local-ocr-image-preprocessing-design.md`: `local-ocr.ts`'s
`prepareForOcr` now applies greyscale → contrast normalize → mild sharpen unconditionally (Approach A),
replacing the prior behavior of skipping all processing for images already under the resize cap.
Deskew explicitly out of scope (needs a real rotation-angle-detection algorithm neither `sharp` nor
`tesseract.js` provides).

`pnpm eval:real-world` (local-ocr tier): **17/46 (37%)** → **22/46 (48%)**, a genuine +5 images.
Per-field: healthWarningStatement 39/46, brandName 31/46 (+1), classType 32/46 (+2), alcoholContent
43/46 (-1), netContents 42/46 (-2), nameAndAddress 27/36, countryOfOrigin 10/10. Mock-tier gate held
at 13/13 (100%). Planted violations 5/5 (100%).

**Important caveat, split by fixture type (same split this doc has tracked since Phase 2): all 5
newly-passing images are in the `degraded/` synthetic set (13/25 → 17/25, 52% → 68%). Plain real
photos are unchanged at exactly 4/21 (19%)** — the same as before this pass. This is expected, not a
surprise to paper over: greyscale/normalize/sharpen directly counters the specific synthetic
blur/glare effects we ourselves generate for stress-testing, so it's unsurprising it helps those
fixtures specifically. It says nothing about whether this preprocessing generalizes to real-world
photography, because it didn't move that number at all. **The headline "+5 images" is a real win on
our own synthetic benchmark, not yet a demonstrated win on real product photos.**

**This is a real, unambiguous improvement, unlike the flat result from the prominence/confidence work
earlier today** — verified the same way (per-item diff against the pre-change baseline, not just
aggregate counts), plus one more check the prominence work didn't need: whether any field-level
_regression_ flipped a previously-passing image to failing. It didn't, anywhere in the 46-image set.

Per-item detail:

- **8 field-level flips wrong→right.** Several are the "confident-wrong becomes honest-not-found"
  pattern this whole line of work has been chasing — e.g. `degraded/old-tom-clean-blur.png`'s
  brandName went from a garbled confident guess (`"Le NT BABI. hg ..—— —"`) to `null` (REVIEW under
  `tolerant: true` scoring, i.e. correct). 5 of these are exactly the images that flip the whole file
  from FAIL to PASS: `degraded/old-tom-clean-blur.png`, `degraded/kirkbride-import-wine-blur.png`,
  `degraded/kirkbride-import-wine-combo.jpg`, `degraded/spirits-old-tub-bourbon-back-combo.jpg`,
  `degraded/wine-la-crema-saralees-chardonnay-back-combo.jpg`.
- **8 field-level flips right→wrong** — the real risk Approach A's design doc flagged upfront.
  E.g. `malt-guinness-draught-stout-can.jpg`'s healthWarningStatement went from `null` (REVIEW,
  correct) to a long confident garbled transcription (MISMATCH, wrong); similarly for
  `spirits-makers-mark-founders-series-front.jpg` classType, `malt-sierra-nevada-oktoberfest-can.jpg`
  brandName, `malt-samuel-adams-boston-lager-can.jpg` netContents, and three more. **Checked
  explicitly: every one of these 8 images was already FAIL both before and after** — none had a
  fully-passing image regress. Sharpening/contrast can occasionally push Tesseract from "found
  nothing" to "found something wrong and confident" on a field, same failure mode the prominence work
  targeted, just newly introduced by this pass on different fields — worth watching if a future
  change touches these same images again, but not a net cost today.
- **48 field-level text changes with no verdict flip** — preprocessing measurably changes raw OCR
  output broadly, not just in the 16 flip-cases; most of the difference is cosmetic/still-wrong either
  way (e.g. `'Old Tus'` → `'Old Tug'`) and doesn't move the needle either direction.

**Recommended next step**: none of the remaining known-unrecoverable cases from the earlier diagnosis
(Chateau Ste Michelle's brand as a stylized logo, Maker's Mark's brand never OCR'd as clean text) were
fixed by this pass — confirmed expected, since preprocessing can't invent text recognition where the
underlying content isn't real printed text or is fundamentally illegible. Those remain candidates for
the vision-LLM cloud tier, not further local-ocr work.

## Known platform limitations (not defects, unchanged from prior audits)

- Bold formatting of "GOVERNMENT WARNING" cannot be verified from extracted text (any tier) —
  surfaced as a `warnings` note, not a verdict (spec §6).
- `meta[theme-color]` follows OS `prefers-color-scheme` only, not a manual in-app override.
