# local-ocr field-selection robustness — design (2026-07-23)

## Motivation

Running `pnpm eval:real-world` (42 entries: 17 real TTB-registry photos + 25 degraded captures,
all `tolerant: true`) against `local-ocr` scored **10/42 (24%) overall**, with per-field accuracy:

| Field                  | Accuracy |
| ---------------------- | -------- |
| brandName              | 11/42    |
| classType              | 22/42    |
| healthWarningStatement | 35/42    |
| alcoholContent         | 36/42    |
| netContents            | 37/42    |
| nameAndAddress         | 24/32    |
| countryOfOrigin        | 6/6      |

Planted violations were still caught 5/5 — the matching layer is sound. The gap is entirely in
`lib/vision/ocr-parser.ts`'s line-selection heuristics, which were built and unit-tested only
against clean, synthetic, single-column OCR text (one field per line, brand first). Real product
photography produces noisy multi-block text — marketing copy, series text, spec panels — that the
current heuristics were never tested against.

Root cause, confirmed by extracting a few real samples directly:

- **`classType`** (`lines.find(l => CLASS_KEYWORDS.test(l) && ...)`, first match wins) matched the
  Guinness can's marketing line _"...through the beer, creating the..."_ — "beer" hit the keyword
  regex as an ordinary word in a sentence, not a real class/type declaration, and won because it
  appeared first in OCR reading order.
- **`brandName`** has no keyword anchor at all — it's "the first pre-warning line nobody else
  claimed." On a real photo with series text, spec lines, and marketing copy, that's frequently
  wrong: the Old Tub front label returned `"BOTTLED IN BOND"` (a real but non-brand designation)
  because OCR dropped the actual large stylized brand title, and the Guinness can returned
  `"UPON OPENING, THE FAMOUS ="` — an ad-copy fragment.

Because `verifyLabel`'s overall verdict is `FAIL` whenever any field is `MISMATCH` (not just
`REVIEW`), these aren't just missed extractions — they produce confidently wrong verdicts on
`tolerant: true` entries that should have resolved to `PASS` (with individual fields at worst
`REVIEW`).

**Relationship to `docs/BRIEF.md`:** the brief frames handling imperfect photography as an explicit
stretch ("_maybe out of scope for a prototype_" — Jenny) and states _"a working core application
with clean code is preferred over ambitious but incomplete features."_ This spec is scoped
accordingly: a small, deterministic, easily-verified fix (Phase 1) rather than a bigger
structural-signal rework (Phase 2, not built here). It also serves the brief's core trust
requirement — agents need to believe a `PASS` is real; a heuristic that's confidently wrong is
worse than one that honestly defers to `REVIEW`.

## Goals

- Stop `classType` and `brandName` from picking marketing/narrative text over real field content
  on real product photography.
- When genuinely ambiguous, resolve to "not found" (→ existing `REVIEW` path in
  `lib/matching/verify.ts`'s `missing()`) rather than guessing — directly reduces false `MISMATCH`.
- Do this with pure, deterministic, structural heuristics (word count, punctuation shape, a small
  documented list of standardized federal designations) — no new dependencies, no I/O changes, no
  change to the `local-ocr.ts` → `ocr-parser.ts` interface.
- Validate test-first with realistic noisy-OCR fixtures modeled on the actual failures found above,
  then confirm via `pnpm eval` (must stay 13/13) and `pnpm eval:real-world` (report the delta).

## Non-goals (deferred to Phase 2, only if Phase 1 isn't enough)

- No use of Tesseract's per-line bounding-box/confidence data (`data.blocks` — already returned by
  the existing `recognize()` call, but consuming it means changing the `local-ocr.ts` →
  `ocr-parser.ts` interface and adding new test surface). Noted here because it's "free" data or a
  strong follow-up signal (line height as a font-size proxy — brand names are typically the largest
  text on a label), not because it's technically hard.
- No image preprocessing (contrast normalization for the low-contrast cases like La Crema,
  Maker's Mark; deskew; orientation detection for rotated warning text).
- No changes to `alcoholContent`, `netContents`, `nameAndAddress`, `countryOfOrigin`, or
  `healthWarningStatement` selection logic — the data shows these are already reasonably solid;
  touching them isn't justified by the evidence.
- No changes to `lib/matching/*` — invariant #1 ("extraction proposes, matching disposes") holds;
  this is purely an extraction-layer accuracy fix.

## Design

### Change 1 — `classType`: shortest match instead of first match

Currently: `lines.find(l => CLASS_KEYWORDS.test(l) && !/GOVERNMENT/i.test(l))`.

New: collect **all** lines matching that same predicate, then pick the one with the fewest words
(ties keep original top-to-bottom order). Rationale: real TTB class/type declarations are printed
as short standalone designations ("BOURBON WHISKEY", "DRAUGHT STOUT", "AMBER MÄRZEN", "GRENACHE
BLANC" — all ≤ 3 words across the 10 sourced labels in `eval/samples/SOURCES.md`), while narrative
text that incidentally contains a class keyword is materially longer. This is a structural fact
about label layout, not a hand-tuned keyword, so it should generalize beyond the current eval set.

### Change 2 — `brandName`: plausibility filter over the leftover-line candidates

Currently: the first pre-warning line not already claimed by `classLine`/`alcoholLine`/`netLine`/
`producerLine`, with `length >= 3`, wins unconditionally.

New: apply a plausibility filter to that same candidate set before accepting a line. Reject a
candidate if:

- it has more than 6 words (brand/fanciful names across the sourced labels are all ≤ 4 words —
  "KENDALL-JACKSON", "TITO'S HANDMADE", "BUFFALO TRACE", "SIERRA NEVADA", "SAMUEL ADAMS"), or
- it contains a comma anywhere in the line (a strong sentence-vs-label signal; brand lines don't
  carry commas, ad copy does — this is what catches the Guinness case), or
- it matches a small, explicitly documented denylist of standardized federal/industry designations
  that commonly survive OCR when the real (often large, stylized) brand title gets dropped:
  `BOTTLED IN BOND`, `SOUR MASH`, `SINGLE BARREL`, `SMALL BATCH`, `CASK STRENGTH`. These are real
  regulatory/industry vocabulary — the same category of hardcoded domain list the file already
  uses for `CLASS_KEYWORDS` — not tuning specific to this eval set's phrasing.

The first surviving candidate wins, preserving today's top-to-bottom order (no new prominence
signal without bounding-box data — that's Phase 2 territory). If no candidate survives, `brandLine`
is `null`, which already flows into the existing "not found — verify by eye" `REVIEW` row; no
change needed downstream.

**Known accepted limitation:** a short, comma-free false positive can still slip through when
several leftover lines exist and none of them is the real brand (e.g., a real brand OCR'd as
completely absent, and the only leftover text left over happens to look brand-shaped). Phase 1
does not solve this — it only removes the _large, obviously-wrong_ class of false positives found
in the eval run. If `pnpm eval:real-world` afterward shows this is still a common enough failure
mode, that's the trigger for Phase 2 (bounding-box/font-size scoring).

## Testing

New cases added to `lib/vision/ocr-parser.test.ts`, test-first, modeled directly on the real
failure patterns found in this investigation (not synthetic guesses):

- `classType` picks the short designation line over a longer narrative line that incidentally
  contains the same keyword (Guinness-style: `"...through the beer, creating the..."` vs.
  `"DRAUGHT STOUT"`).
- `brandName` rejects a long, comma-bearing marketing line and either falls through to a shorter
  real candidate or resolves to `null` if none exists (Guinness-style ad-copy fragment).
- `brandName` rejects a denylisted standardized designation (`"BOTTLED IN BOND"`) rather than
  returning it as the brand when the real brand line is absent from OCR output (Old-Tub-style).
- Existing tests (e.g. "does not misclassify a brand that contains a class-keyword substring",
  "does not fabricate a brand from the warning body when the brand line is absent") must keep
  passing unchanged — this is a refinement of the existing selection logic, not a rewrite.

Verification: `pnpm eval` must stay `13/13 (100%)`, `8/8` violations caught (mock tier is fixture
data, unaffected by this change but must not regress — any regression here would indicate a
matcher-side mistake, not an extraction one). `pnpm eval:real-world` re-run afterward; report the
new per-field/overall numbers and the delta from the 24% baseline above as the actual deliverable
(observability, not a gate — same posture as the rest of the real-world eval set).

## File inventory

Modified:

- `lib/vision/ocr-parser.ts` (`classType` shortest-match selection; `brandName` plausibility
  filter + denylist)
- `lib/vision/ocr-parser.test.ts` (new cases per above)

Unchanged:

- `lib/vision/local-ocr.ts`, `lib/matching/*`, `lib/ttb/*`, `eval/expected.json`,
  `eval/expected-real-world.json`, the `ExtractedLabel` schema, `/api/verify` contract.

## Coordination note

A separate, concurrently in-progress effort (Romance-language OCR support — see
`docs/superpowers/specs/2026-07-23-romance-language-ocr-design.md`) also extends
`CLASS_KEYWORDS` and the producer/country-line regexes in this same file, in a different region.
The implementation step for this spec should rebase onto whatever lands from that work before
editing, to avoid a stale diff — the two changes are logically independent (this spec changes
_which_ line wins among matches; that one changes _what counts_ as a match) and shouldn't
conflict in substance, only possibly in diff proximity.

## Risks / open notes

- The 6-word threshold and comma check are heuristics tuned against the evidence in hand (17 real
  labels + degradations), not derived from a TTB regulation — they're structural approximations,
  documented as such rather than asserted as universal.
- The denylist is intentionally small and will always be incomplete against the full space of
  standardized whiskey/spirits designations; it's a targeted fix for the specific failure mode
  observed (real brand dropped by OCR, standardized designation left as the only short candidate),
  not a general solution.
- If `pnpm eval:real-world`'s brandName/classType numbers are still poor after this change, that's
  the documented trigger for Phase 2 (bounding-box/font-size line scoring), not a reason to keep
  expanding Phase 1's denylist indefinitely.

## Phase 2 candidates

### Positional restriction on brandLine (largest remaining lever)

**Problem:** After Phase 1's denylist/noise filters reject one junk candidate, the parser falls
through to the next pre-warning line — which is often plain rearranged letters or a truncated
marketing phrase that passes all the shape checks (short, no comma, no digits). E.g. suppressing
"100 PROOF 100 PROOF" on the Old Tub front label just exposed "KENTUCKY STRAIGHT" as the next
unclaimed candidate. The aggregate brandName score moved only 25→26/46 because the fallback chain
keeps producing plausible-looking but wrong answers.

**Observation:** Real TTB labels put the brand first — it's the largest, most prominent text,
typically the very first line of the front label. Everything after the first structured field
(class/type, ABV, net contents) is increasingly likely to be marketing copy, not a missed brand.

**Proposed change:** Restrict `brandLine` candidates to lines that appear _before_ whichever
structured field (classLine, alcoholLine, netLine, producerLine) shows up first in OCR reading
order. If no structured field is found, keep the current behavior (search all pre-warning lines).

Concretely: find the minimum index among `classLine`, `alcoholLine`, `netLine`, `producerLine` in
the `lines` array; slice `preWarningLines` to only that range; search for brandLine within that
shorter list.

**Why this helps:** When the brand is genuinely missing (OCR dropped the large bold title), the
parser currently grabs whatever line sits between the first structured field and the warning — which
is almost always marketing copy. With positional restriction, it would fall through to null (a
"not found" REVIEW) instead of a confident wrong answer.

**Risk:** Some labels have the class/type line _above_ the brand (e.g. "KENTUCKY STRAIGHT BOURBON
WHISKEY" as a header, brand below). These would need to be verified against per-file cases before
committing. The restriction should be "before the first structured field that appears _after_ any
brand-like line" — or simply "before the first alcohol/net/producer line" (classLine is excluded
because it can appear above the brand).

**Verification approach:** Run against every per-file entry in `eval/expected-real-world.json`,
inspect each brandName extraction, and confirm the positional cutoff doesn't reject any correct
brand. If it does, the restriction needs a per-field exception or a "brand must be in the top N
lines" variant instead of a hard cutoff at the first structured field.
