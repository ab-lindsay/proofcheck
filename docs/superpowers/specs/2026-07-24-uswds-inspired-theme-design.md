# USWDS-inspired visual theme — design (2026-07-24)

## Goal

Re-skin ProofCheck's existing UI to the USWDS-inspired direction approved in chat (mockup:
`https://claude.ai/code/artifact/459089b3-aa80-4c62-9c59-fc50f133c11f`) — federal-design-system color
and type conventions, without any government branding (no seal, no flag, no ".gov" banner). Add one new
feature the mockup introduced: a byte-level diff view for the health warning statement, so invariant #3
("checked deterministically... never fuzzy, never model-judged") is visible, not just true in code.

No verdict/matching logic changes. `lib/matching` and `lib/ttb` output stay byte-identical; the eval
harness is untouched.

## Context / current state

- `app/globals.css` defines OKLCH tokens (shadcn "base-nova" scaffold) for background/foreground/card/
  border/etc., wired through `@theme inline` and toggled by a `.dark` class (see
  `docs/superpowers/plans/2026-07-22-ui-theming-and-regulation-references.md` — the prior theming pass
  that built the light/dark toggle and migrated most literal palette classes onto these tokens).
- That prior pass deliberately kept two things un-tokenized: the emerald brand mark, and verdict colors
  (MATCH/MISMATCH/REVIEW), which use hardcoded Tailwind shades + explicit `dark:` variants repeated across
  `field-row.tsx`, `verdict-card.tsx`, and `batch-table.tsx`. This pass revisits that: the same three colors
  are being intentionally rebranded everywhere at once, so centralizing them as tokens (one `.dark` class
  swap instead of three files' worth of paired `dark:` classes) now pays for itself.
- Fonts are Geist Sans / Geist Mono (`next/font/google`), loaded in `app/layout.tsx`.
- `--radius: 0.625rem` drives every corner radius in the app via `calc()` multipliers in `@theme inline`.
- The health warning statement already carries both strings needed for a diff: `lib/matching/warning.ts`'s
  `checkHealthWarning()` sets `applicationValue: HEALTH_WARNING_TEXT` (the canonical, sentence-case
  constant from `lib/ttb/warning.ts`) and `labelValue: field.value` (verbatim, case-preserved). The common
  real-world REVIEW case is the label printed **ALL CAPS** against a **sentence-case** canonical — the code
  comment in `warning.ts` notes "TTB approves all-caps renderings in practice (9/10 real approved labels in
  eval/samples)". The mockup's example (in the artifact) had this backwards; the real implementation uses
  the actual, code-documented scenario.
- CSP (`lib/security-headers.ts`) already sets `font-src 'self'`. `next/font/google` self-hosts at build
  time (no runtime request to Google), so switching typefaces needs **no CSP change** — same as the current
  Geist fonts.

## 1. Color tokens

Values below are either verified USWDS system tokens (cited) or deliberately-chosen colors held to the
same WCAG AA bar (4.5:1 normal text, verified by computing relative luminance — see table). None of this
is a government site, so no seal/flag/".gov" banner — a small disclaimer line covers that (§3).

Cited USWDS tokens (designsystem.digital.gov, fetched 2026-07-24): `blue-vivid-50 #0076d6`,
`blue-50 #2378c3`, `blue-60 #2c608a`, `green-cool-50 #4d8055`, `red-50 #d83933`, `gold-50 #8e704f`,
`gray-90 #1b1b1b`, `gray-5 #f0f0f0`. Our palette below is inspired by these (same hue families, adjusted
so every pair clears AA against our specific warm paper/navy surfaces — the cited tokens are graded for
USWDS's own grays, not ours).

| Token                                | Light                     | Dark                  | Role                                                                                                              |
| ------------------------------------ | ------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--background`                       | `#faf8f3`                 | `#15130f`             | page (warm off-white / warm near-black — chosen, not inherited neutrals)                                          |
| `--foreground`                       | `#1b1b1b` (USWDS gray-90) | `#ede8dd`             | body text                                                                                                         |
| `--card`                             | `#ffffff`                 | `#201d17`             | raised surfaces                                                                                                   |
| `--muted` / `--accent`               | `#f2ede2`                 | `#2a2720`             | subtle panels                                                                                                     |
| `--muted-foreground`                 | `#55534d`                 | `#b6ae9e`             | secondary text                                                                                                    |
| `--border` / `--input`               | `#ddd6c7`                 | `#3a362c`             | hairlines                                                                                                         |
| `--primary`                          | `#142c46` (navy)          | `#1f4468`             | solid-fill brand surfaces: header, Step badges, selected theme-toggle pill                                        |
| `--primary-foreground`               | `#ffffff`                 | `#ffffff`             | text/icons on `--primary`                                                                                         |
| `--ring` (links + focus)             | `#005ea2`                 | `#6cb6f0`             | darkened from USWDS blue-vivid-50 — `#0076d6` cleared only 4.34:1 on our paper, below AA; `#005ea2` clears 6.34:1 |
| `--destructive`                      | `#b3221c`                 | `#f08a83`             | shadcn destructive slot (aliases mismatch red)                                                                    |
| `--proof-amber` (brand accent)       | `#a85a1a`                 | `#e08a3e`             | wordmark, header rule — used sparingly, NOT a semantic verdict color                                              |
| `--verdict-compliant` / `-bg`        | `#3f6b46` / `#e8f1e6`     | `#8fc296` / `#1d2a1e` | MATCH chip                                                                                                        |
| `--verdict-needs-correction` / `-bg` | `#7d5f3f` / `#f2e7d4`     | `#d3b587` / `#322a1a` | REVIEW chip (muted gold, distinct from proof-amber)                                                               |
| `--verdict-non-compliant` / `-bg`    | `#b3221c` / `#fbe7e5`     | `#f08a83` / `#35191a` | MISMATCH chip                                                                                                     |

Verified contrast (relative-luminance WCAG formula; ≥4.5:1 = AA normal text, ≥3:1 = AA large text ≥18pt/24px bold):

| Pair                                                                  | Light            | Dark                           |
| --------------------------------------------------------------------- | ---------------- | ------------------------------ |
| foreground / background                                               | 16.23:1          | 15.18:1                        |
| muted-foreground / background                                         | 7.25:1           | 8.43:1                         |
| white / primary (badges)                                              | 14.20:1          | 10.07:1 (`#1f4468`)            |
| ring (link) / background                                              | 6.34:1           | 8.47:1                         |
| ring (link) / card                                                    | 6.72:1           | 7.67:1                         |
| proof-amber / card                                                    | 5.07:1           | 6.96:1                         |
| verdict-compliant / -bg                                               | 5.34:1           | 7.36:1                         |
| verdict-needs-correction / -bg                                        | 4.79:1           | 7.24:1                         |
| verdict-non-compliant / -bg                                           | 5.59:1           | 6.64:1                         |
| white / PASS banner gradient (`#24402a`→`#3f6b46`, fixed both themes) | 11.40:1 / 6.17:1 | same (gradient doesn't toggle) |
| white / FAIL banner gradient (`#7a1815`→`#b3221c`, fixed both themes) | 10.67:1 / 6.64:1 | same                           |

Every pair clears AA; most clear AAA. The two banner gradients stay fixed across themes (same reasoning as
the code they replace: white text needs to read regardless of page theme — see `verdict-card.tsx`'s
existing comment on this).

`--radius`: `0.625rem` → `0.375rem` (6px). USWDS/government-form surfaces read squarer than the current
`rounded-2xl` consumer-app look; this is a single-variable change that cascades through the existing
`--radius-sm/md/lg/xl` `calc()` chain in `@theme inline` — no component touches its own radius class.

## 2. Typography

next/font/google, self-hosted, no CSP change:

| Role                       | Typeface               | Replaces        | Used for                                                       |
| -------------------------- | ---------------------- | --------------- | -------------------------------------------------------------- |
| `--font-sans` (body/UI)    | Public Sans            | Geist Sans      | everything except the exceptions below                         |
| `--font-mono` (data)       | Roboto Mono            | Geist Mono      | extracted/application values, filenames, the warning-diff view |
| `--font-heading` (display) | Merriweather (700/900) | aliased to sans | wordmark, page `<h1>`, the big PASS/FAIL verdict text only     |

Restraint: per the frontend-design skill, the serif face is a display accent, not a wholesale reskin —
Step section titles, card headings, and body copy stay on Public Sans so the page doesn't read as
"serif everywhere." All three are real USWDS-associated typefaces (Public Sans and Roboto Mono are USWDS's
own defaults; Merriweather is USWDS's documented alternative heading face).

## 3. Copy additions

A quiet disclaimer line in the header, same spirit as the mockup — honest positioning, not decoration:

> Independent compliance tool — not affiliated with the U.S. Department of the Treasury or the Alcohol and
> Tobacco Tax and Trade Bureau.

## 4. Health warning statement — byte-level diff (new feature)

**`lib/ttb/warning-diff.ts`** (pure, no I/O, tested — same discipline as `lib/ttb/normalize.ts`):

```ts
export type DiffToken = { text: string; kind: "same" | "case-diff" | "space-diff" | "diverge" };
export function diffWarningTokens(
  canonical: string,
  extracted: string,
): { canonical: DiffToken[]; extracted: DiffToken[] };
```

Tokenizes both strings on whitespace runs (`split(/(\s+)/)`, keeping the runs), then walks index-by-index
while tokens keep aligning:

- identical token → `same`
- both tokens are whitespace, but differ (e.g. one space vs two) → `space-diff`
- both tokens are words, equal case-insensitively but not literally → `case-diff`
- otherwise (a genuine wording difference, or the arrays run out of lockstep) → everything from that index
  onward, on both sides, collapses into one trailing `diverge` token per side.

This directly mirrors the verdict semantics already decided in `lib/matching/warning.ts`: `case-diff` /
`space-diff` are exactly the conditions that already produce REVIEW there; `diverge` is exactly what
already produces MISMATCH. The diff view doesn't re-decide anything — it visualizes the same rule.

**`components/warning-diff.tsx`**: renders the canonical line and the extracted line stacked in
`font-mono`, each token as plain text (`same`) or a `<mark>` colored by kind — `case-diff`/`space-diff` in
`verdict-needs-correction` colors, `diverge` in `verdict-non-compliant` colors. Wired into `field-row.tsx`: when
`result.field === "healthWarningStatement"` and both `applicationValue` and `labelValue` are non-null, this
replaces the generic Application/Label value boxes; the null-`labelValue` ("not found on label") case keeps
the existing generic fallback since there's nothing to diff against. (As of Task 11, this replacement is
also gated behind the dev-mode toggle — off by default, only shown when dev mode is enabled; see
`hooks/use-dev-mode.ts` and its wiring in `field-row.tsx`.)

Demonstration data for tests uses the real documented scenario (label in all caps vs. sentence-case
canonical), not an invented example.

## 5. Non-goals

- No changes to `lib/matching`, `lib/ttb/normalize.ts`, `lib/ttb/warning.ts`'s canonical constant, the API
  contract, or the eval harness.
- No new runtime dependencies (Merriweather/Public Sans/Roboto Mono load through the `next/font/google`
  already in use for Geist).
- No seal, flag, or ".gov" styling — the disclaimer line is the honesty mechanism, not a visual one.
- Chart (`--chart-1..5`) and sidebar tokens in `globals.css` are unused by any current component; carried
  forward with minimal neutral-palette adjustment, not a design focus of this pass.
