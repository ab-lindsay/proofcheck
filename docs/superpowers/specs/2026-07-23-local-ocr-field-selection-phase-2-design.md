# local-ocr field-selection robustness, Phase 2 — design (2026-07-23)

## Motivation

Phase 1 (`docs/superpowers/specs/2026-07-23-local-ocr-field-selection-robustness-design.md`) fixed
`classType`'s first-match-wins bug and added a plausibility filter to `brandName`'s leftover-line
search. Combined with an unrelated but compounding fix (`96d9569`, setting
`PSM.SINGLE_COLUMN` so tesseract stops dropping the brand line entirely), `pnpm eval:real-world`
moved from the Phase 1 baseline (10/42, 24%) to **16/46 (35%)**, with per-field:

| Field                  | Accuracy |
| ---------------------- | -------- |
| brandName              | 26/46    |
| classType              | 30/46    |
| healthWarningStatement | 39/46    |
| alcoholContent         | 40/46    |
| netContents            | 44/46    |
| nameAndAddress         | 27/36    |
| countryOfOrigin        | 10/10    |

Planted violations still caught 5/5. Instrumenting the eval harness to print per-item, per-field
`[MISS] file :: field got=X want=Y extracted="..." app="..."` rows (ad hoc, not committed — see the
"Coordination note" below) surfaced five distinct, structural, fixable causes behind the 76 real
remaining mismatches, beyond the "unrecoverable OCR garbage" cases (heavily degraded blur/lowres/
combo images that OCR into pure noise, e.g. `"Le NT BABI. hg ..—— —"` — no heuristic fixes these,
out of scope here as in Phase 1):

1. **`brandName` positional restriction (already empirically validated in-session: 26→30/46, no
   other field regressed).** After Phase 1's plausibility filter rejects one junk candidate, the
   parser falls through to the next pre-warning leftover line — often still wrong ("100 PROOF 100
   PROOF" suppressed just exposed "KENTUCKY STRAIGHT" as the next unclaimed candidate). Real labels
   put the brand first; everything after the first structured field is increasingly likely to be
   marketing copy.
2. **`nameAndAddress` capturing only the producer verb phrase.** The single biggest repeat offender
   (6+ misses: `spirits-old-tub-bourbon-front.jpg`, `-back.jpg`, `spirits-buffalo-trace-experimental-
back.png`, `malt-samuel-adams-boston-lager-can.jpg`, plus two `degraded/` variants). Real photos
   often OCR the verb phrase ("Distilled and Bottled by") and the company name/address onto
   _separate lines_; the current regex only looks for text following the verb phrase on the _same_
   line, finds nothing, and falls back to returning the bare verb phrase as the value.
3. **`classType` missing vocabulary.** `CLASS_KEYWORDS` has no grape varietals (chardonnay, cabernet,
   grenache, pinot, riesling, zinfandel...) or several beer styles (märzen, amber, IPA...). When the
   real designation word isn't in the list, the shortest-match algorithm has no valid candidate and
   grabs marketing prose that coincidentally contains a keyword substring (e.g. `wine-chateau-ste-
michelle-grenache-blanc-back.jpg` extracted `"Kunde, a beloved wine-growing visionary, who
planted the vineyard with her husband,"` — "wine" inside "wine-growing" was the only match).
4. **`alcoholContent` selecting the first `%`-line with no ABV-context check.** Loses to marketing
   copy like `"AGED MINIMUM OF 9 MONTHS IN 100% FRENCH OAK"` or `"CONTAINS SULFITES 750ml ALC 135%
BY VOL"` when the real ABV line is dropped or reordered.
5. **`healthWarningStatement` trailing-junk leak.** When OCR garbles the closing "health problems."
   (common on real photos), the fallback regex `GOVERNMENT\s+WARNING:.*$` has no multiline flag, so
   `$` matches end of the entire joined string — it swallows everything after, including barcodes
   and website URLs (`"...HEALTH PROBLEMS moon WWW.DRINKSMART.COM 1007750 mL"`).

**Relationship to `docs/BRIEF.md`:** same posture as Phase 1 — small, deterministic, structural
fixes over a bigger rework, verified against real evidence rather than tuned to guesses. This phase
extends the same discipline to four fields Phase 1 explicitly deferred (Phase 1's Non-goals said
"the data shows these are already reasonably solid" for `alcoholContent`, `netContents`,
`nameAndAddress`, `countryOfOrigin`, and `healthWarningStatement` — new evidence from the fuller
46-item real-world set now shows two of those five have fixable structural causes; `netContents`
(44/46) and `countryOfOrigin` (10/10) remain untouched, still solid).

## Goals

- Fix the five structural causes above, each independently, each verified against
  `pnpm eval:real-world` before moving to the next (matching Phase 1's and the eval-history plan's
  discipline — now recordable via `pnpm eval:history` instead of hand-copied numbers).
- Keep every change pure, deterministic, and structural (word count, line adjacency, keyword
  co-occurrence, punctuation shape) — no Tesseract bounding-box/confidence data, no image
  preprocessing, no change to the `local-ocr.ts` → `ocr-parser.ts` interface (same Non-goals as
  Phase 1).
- Test-first, using cases modeled on the real failures found in this investigation.

## Non-goals

- No use of Tesseract's per-line bounding-box/confidence data or image preprocessing (deferred
  indefinitely, per Phase 1's Non-goals — still true; nothing here changes that).
- No changes to `netContents` or `countryOfOrigin` selection (44/46 and 10/10 — no fixable pattern
  found in the MISS data for these two fields).
- No changes to `lib/matching/*` — invariant #1 ("extraction proposes, matching disposes") holds.
  The one matching-layer observation from this investigation (a leading vintage year like `"2020"`
  in an otherwise-correct `classType` extraction causing an avoidable MISMATCH against an
  application value with no year) is noted here for the record but is explicitly **not** proposed —
  it's a separate, unscoped idea that would need its own brainstorming pass if pursued.
- No new CI gate — `pnpm eval:real-world` numbers remain observability, reported via
  `pnpm eval:history` after this phase lands, not a pass/fail gate (same posture as Phase 1).

## Design

### Change 1 — `brandName`: positional restriction to before the first structured field

Currently, `preWarningLines` (all lines before the `GOVERNMENT` line) is searched in full for a
brandLine candidate. New: also compute the earliest index among `classLine`, `alcoholLine`,
`netLine`, `producerLine` (in the raw `lines` array) that is **not** `classLine` — i.e. the minimum
index of `alcoholLine`, `netLine`, `producerLine` only. `classLine` is excluded from this cutoff
because some labels print the class/type designation as a header _above_ the brand. If such an
index exists, slice `preWarningLines` down to that range before searching for `brandLine`; if none
of the three fields were found, search the full `preWarningLines` as today (no regression on labels
where none of those fields resolved).

This was implemented and measured directly against `eval/expected-real-world.json` in-session
before being written up here: brandName 26→30/46, every other field's count unchanged, mock-tier
gate unaffected. No further per-file risk investigation is needed before proceeding — the empirical
check the Phase 1 spec asked for ("Verification approach: run against every per-file entry... confirm
the positional cutoff doesn't reject any correct brand") already happened and showed no regression.

### Change 2 — `nameAndAddress`: next-line fallback when the verb phrase has nothing after it

Currently: `producerMatch = producerLine.match(/(?:${PRODUCER_VERB})\s+(.+)$/i)`; when the verb
phrase is the entire line (nothing follows it), this match fails (`(.+)$` requires at least one
character after the verb), and `nameAndAddressValue` falls back to `producerLine` itself — the bare
verb phrase.

New: when `producerLine` matched via the `PRODUCER_VERB` branch (not the `\bco\.,/i` branch, where
the whole line already _is_ the name) and `producerMatch` is null, take the next line in the `lines`
array (by index) as the value instead. Scope: single-line lookahead only — every observed failure
case has the company name/address as the literal next OCR line, not spread across more lines. If a
future case needs multi-line address continuation, that's a documented follow-up, not built here
(YAGNI — no evidence in hand requires it).

### Change 3 — `classType`: expand `CLASS_KEYWORDS`

Add grape varietals (chardonnay, cabernet (sauvignon), merlot, pinot noir, pinot grigio, pinot gris,
sauvignon blanc, zinfandel, syrah, shiraz, malbec, riesling, grenache, tempranillo, sangiovese,
moscato, muscat, rosé, champagne, prosecco, chenin blanc) and beer styles (märzen/marzen, ipa,
pilsner, amber, pale ale, wheat, saison) to the existing `CLASS_KEYWORDS` regex, following the same
`\b(?:...)\b` word-boundary-anchored alternation pattern already in use (prevents the same class of
false substring match Phase 1's comment already documents — e.g. `\brose\b` won't match inside
"Rosewood"). Combined with the existing shortest-match-wins logic (Phase 1, unchanged here), a real
short designation line now has a chance to be found and win over marketing prose that previously was
the only match.

### Change 4 — `alcoholContent`: require ABV context alongside a bare `%`

Currently: `lines.find(l => (/%/.test(l) || /proof/i.test(l)) && !/GOVERNMENT/i.test(l))` — the
first line containing either symbol wins unconditionally.

New: a `%`-line only qualifies if it also contains `alc`, `vol`, or `abv` (word-boundary anchored,
case-insensitive) somewhere on the same line; a bare `proof` line still qualifies on its own (it's
already an unambiguous ABV signal with no analogous false-positive pattern observed). Rejects lines
like `"AGED MINIMUM OF 9 MONTHS IN 100% FRENCH OAK"` while still accepting every real form observed
in the eval set (`"40% ALC./VOL."`, `"5.5% ABV"`, `"13.5% Alc by Vol"`, `"ALC 135% BY VOL"`).

### Change 5 — `healthWarningStatement`: bound the no-closing-period fallback

Currently: `joined.match(/GOVERNMENT\s+WARNING:.*?health\s+problems\s*\./i) ??
joined.match(/GOVERNMENT\s+WARNING:.*$/i)` — the second (fallback) pattern's `.*$` runs to the end
of the entire `joined` string (no `m` flag), so when OCR garbles the closing "health problems."
badly enough to miss the first pattern, the fallback swallows everything after it too, including
barcodes and website URLs.

New: change the fallback's capture to stop at the first URL-like marker (`www\.` or `http`) or a run
of 4+ digits (barcode/UPC), whichever comes first, instead of running to end-of-string:

```
joined.match(/GOVERNMENT\s+WARNING:.*?(?=\s+(?:www\.|https?:\/\/|\d{4,})|$)/i)
```

Canonical § 16.21 warning text (`lib/ttb`) contains neither a URL pattern nor a 4+ digit run, so this
cannot clip genuine warning content — it only shortens the fallback capture when OCR has already
appended non-warning text. This is an extraction-side-only change; the deterministic byte-exact /
wording-only / anything-else comparison in `lib/matching` (invariant #3) is untouched — a garbled
extraction (with or without trailing junk) still resolves through the same three-way compare it
already does.

## Testing

New cases added to `lib/vision/ocr-parser.test.ts`, test-first, modeled on the real failure patterns
found in this investigation:

- `brandName` falls through to `null` (not a marketing-copy leftover line) when the only pre-warning
  lines after the first structured field are non-brand text, and still finds the correct brand when
  it legitimately appears before that field.
- `nameAndAddress` captures the next line when the producer verb phrase has nothing following it on
  its own line (Old-Tub-style: `"Distilled and Bottled by"` / `"James B. Beam Distilling Co.,
Clermont, KY"` on consecutive lines), and continues to capture same-line text correctly when the
  verb phrase and name share a line (regression check — no change to that path).
- `classType` finds a newly-added varietal/style keyword (e.g. `"CHARDONNAY"`) as a short standalone
  line over a longer narrative line that happens to contain a different, already-recognized keyword
  substring (Kunde-style: `"...wine-growing visionary..."` vs. `"CHARDONNAY"`).
- `alcoholContent` rejects a `%`-line lacking `alc`/`vol`/`abv` context (`"100% FRENCH OAK"`) and
  falls through to the real ABV line when one exists elsewhere, or to `null` when it doesn't; a bare
  `proof` line (no `%`) still matches as before (regression check).
- `healthWarningStatement`'s fallback stops at a trailing URL/barcode instead of appending it, while
  the primary "health problems."-anchored match (the common case) is unaffected (regression check).
- All existing tests in `lib/vision/ocr-parser.test.ts` (Phase 1's and the pre-existing baseline)
  must keep passing unchanged — every change here is additive/restrictive to existing candidate
  searches, not a rewrite of them.

Verification, per change, in order: `pnpm eval` must stay `13/13 (100%)`, `8/8` violations caught
(any regression indicates a matcher-side mistake, not an extraction one — mock tier is fixture data,
unaffected by parser changes). `pnpm eval:real-world` re-run after each change; report the delta via
`pnpm eval:history --set real-world --provider local-ocr` (built in the eval-history persistence
work merged just before this phase) rather than hand-copying numbers into commit messages.

## File inventory

Modified:

- `lib/vision/ocr-parser.ts` (all five changes: brandName positional restriction, nameAndAddress
  next-line fallback, CLASS_KEYWORDS expansion, alcoholContent ABV-context requirement,
  healthWarningStatement fallback bound)
- `lib/vision/ocr-parser.test.ts` (new cases per above)

Unchanged:

- `lib/vision/local-ocr.ts`, `lib/matching/*`, `lib/ttb/*`, `eval/expected.json`,
  `eval/expected-real-world.json`, the `ExtractedLabel` schema, `/api/verify` contract,
  `eval/record-run.ts`, `eval/print-history.ts`, `eval/run.ts`.

## Coordination note

The per-item `[MISS]` breakdown that grounded this spec's Motivation section was generated by
temporarily instrumenting `eval/run.ts` in-session (not committed) and has since been reverted; the
now-merged eval-history persistence work (`eval/record-run.ts`, `eval/.results/<set>-<provider>.json`)
gives future investigations of this kind a permanent, gitignored equivalent without needing to
hand-instrument the harness again.

## Risks / open notes

- Change 3's added vocabulary (`amber`, `wheat`, `rosé`, etc.) is broader than Phase 1's tight,
  evidence-specific denylist approach — these are real varietal/style words, not tuned to this eval
  set's exact phrasing, but a generic word like "amber" has more surface area to coincidentally
  match unrelated marketing text than the narrower original list did. `pnpm eval:real-world`'s
  classType number is the check for this, run immediately after Change 3 lands, before Change 4
  starts.
- Change 2's single-line lookahead is a known, accepted limitation (see Design) — multi-line address
  continuations are out of scope until evidence shows they're needed.
- If any individual change's `pnpm eval:real-world` delta is flat or negative, that change should be
  reverted or reworked before proceeding to the next — same "stop and report the delta, don't chase
  a specific number" posture as Phase 1's Task 3, now made easier to compare via `pnpm eval:history`.
