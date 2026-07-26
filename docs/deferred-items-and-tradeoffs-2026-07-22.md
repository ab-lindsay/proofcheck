# ProofCheck — Deferred Items & Accepted Trade-offs (2026-07-22)

Companion to the UI-theming + regulation-references work and the 2026-07-22 bug/security/coverage
audits. Records what was fixed in the follow-up pass, what is deliberately left as an accepted
trade-off (with rationale), and known platform limitations. Nothing here blocks merge.

## Resolved in the follow-up pass

Driven by the final whole-branch review and the coverage-gap analysis.

| Item                                                                                    | Resolution                                                                                                                                                                                                                  | Commit    |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| PASS/FAIL banner subtitle failed WCAG AA (~2.5:1 light / ~3.8:1 dark)                   | Darkened banner gradients to `emerald-800/700` and `red-700/rose-700` (white text now 5.5–6.5:1); subtitle set to solid white. One gradient serves both themes (contrast is set by the gradient color, not the page theme). | `743fcbd` |
| Dark accent-shade inconsistency (`red-400` vs `red-300`; `amber-200` vs `amber-300`)    | Aligned error text to `dark:text-red-300` and the review banner to `dark:text-amber-300`.                                                                                                                                   | `743fcbd` |
| Citation line smaller than the reason above it (`text-sm` vs `text-base`)               | Bumped to `text-base` for legibility parity (persona bar).                                                                                                                                                                  | `ad44447` |
| `FieldResult.field` typed as `string`, requiring casts in `field-row.tsx`               | Narrowed to `keyof ExtractedLabel` at the source; casts removed. Compile-time only — matching output unchanged (140 tests green, eval 13/13, 8/8 planted violations caught).                                                | `ad44447` |
| Test gaps: citation completeness; `beverageType`→citation threading; pre-paint no-flash | Added a completeness assertion, a spirits-vs-wine citation-threading test, and `applyTheme('system')` OS-resolution coverage + a static `THEME_INIT_SCRIPT` contract check.                                                 | `deaaec4` |
| Intermittent fake-timer route test ("timed out in 5000ms" under load)                   | Gave the two fake-timer tests a 20s per-test timeout; they drive real async work between clock advances and can exceed Vitest's 5s wall on a saturated full-suite run. Not a logic bug (green across 10+ full-suite runs).  | `deaaec4` |

## Accepted trade-offs (deliberately not changed)

- **`normalizeLoose` and non-ASCII outside the fold map (bug-audit #5).** After NFKD + combining-mark
  stripping, the common accented Latin the audit cited (å, ü, ç) already decomposes to a/u/c, so those
  match correctly. The explicit `FOLD` map covers non-decomposable Latin (æ œ ø ß þ ð ł đ ħ). Only exotic
  letters with no decomposition and no fold entry (e.g. Turkish dotless ı, ŋ) are stripped — vanishingly
  rare on US TTB labels. Extending the map would change matching/normalization behavior (and thus eval)
  for negligible real-world benefit, so this is accepted per the audit's own stated option. Revisit only
  if a real label surfaces the gap.
- **Solid emerald CTA fills without `dark:` variants** (`bg-emerald-600 hover:bg-emerald-500` on the
  Verify buttons). A solid fill with white text has fixed contrast regardless of page theme, matching the
  logo-mark precedent (`app/layout.tsx`). Only theme-dependent accents (focus rings, borders that render
  against the page/card) were paired. The banner-gradient contrast fix above is the one place a fill was
  darkened, and only because white text sits directly on it.
- **Skip-link keeps hardcoded `bg-slate-900 text-white`.** An opaque, high-contrast focus-only overlay,
  legible in both themes by design.

## Known platform limitations (not defects)

- **`meta[theme-color]` follows the OS `prefers-color-scheme` only**, not a manual in-app theme override.
  A browser/OS constraint, documented at `app/layout.tsx`.
- **Bold formatting of "GOVERNMENT WARNING" cannot be verified from extracted text** (any tier). Surfaced
  as a `warnings` note ("check visually") rather than a verdict — by design (spec §6).

## Low-priority observations (from the bug audit's "non-bugs" section)

Fine on Vercel serverless; worth noting only for long-running self-hosted deploys.

- Cloud SDK clients (`Anthropic`/`OpenAI`/`GoogleGenerativeAI`) are instantiated per request — consider
  hoisting to module scope for high-throughput batch runs.
- The singleton Tesseract worker is never terminated (intentional — re-init is expensive; recycled with
  the serverless instance).
- `batch-table.tsx` `detailsId` uses the sorted-array index; correct within a render (`openRow` tracks by
  filename) but would need a stable id if multiple/persistent open rows are ever supported.
