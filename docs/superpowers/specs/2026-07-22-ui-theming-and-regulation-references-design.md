# UI theming + per-field regulation references — design (2026-07-22)

## Goal

Two user-facing improvements to ProofCheck, plus the token migration that makes the first one real:

1. **Light / dark / system theming** — a hand-rolled, zero-dependency theme system, and the migration of
   the layout and components from hardcoded palette classes to the semantic tokens already defined in
   `app/globals.css`.
2. **Per-field legal regulation references** — every field result shows a plain-English basis and an
   always-visible link to the authoritative TTB regulation on eCFR.

Neither changes any verdict logic. `lib/matching` output and the eval harness are untouched.

## Context / current state

- `app/globals.css` already defines complete light (`:root`) and dark (`.dark`) OKLCH token sets and a
  `@custom-variant dark (&:is(.dark *))`, but nothing sets the `.dark` class and the components ignore the
  tokens — `layout.tsx` and every component hardcode `bg-stone-50`, `text-slate-900`, `bg-white/85`,
  `bg-emerald-600`, `border-stone-200`, etc. So the app can only ever render one fixed light look.
- `field-row.tsx` renders each `FieldResult` (field, verdict, reason). `verdict-card.tsx` composes rows.
- `ApplicationData.beverageType` is one of `distilled-spirits | wine | malt-beverage` (confirm exact enum
  in `lib/schema.ts` during implementation) — this is the key for choosing the right CFR part.
- The existing CSP (`lib/security-headers.ts`) allows `script-src 'self' 'unsafe-inline'`, so a
  pre-hydration inline theme script needs **no CSP change**.

## 1. Theme system

### Provider — hand-rolled, zero-dependency

Rationale: the project just completed a supply-chain hardening pass; adding a runtime dependency for
theming cuts against that. If the hand-rolled version proves unsatisfactory, `next-themes` is the agreed
fallback (revisit then).

Three pieces:

- **No-flash inline script** in `app/layout.tsx` `<head>`, run before first paint:
  reads `localStorage.getItem("theme")` (`"light" | "dark" | "system"`, default `"system"`), resolves
  `system` against `matchMedia("(prefers-color-scheme: dark)")`, and sets/removes `document.documentElement`
  `class="dark"` accordingly. Inlined as a string so it executes before hydration (prevents FOUC). Permitted
  by the current CSP.
- **`ThemeToggle` client component** (`components/theme-toggle.tsx`): reads/writes `localStorage.theme`,
  applies the resolved class to `<html>`, and — while the choice is `system` — subscribes to the
  `matchMedia` change event so the theme tracks OS changes live. Unsubscribes on unmount / when the user
  picks an explicit theme.
- No React context/provider is required (the toggle mutates the `<html>` class directly, which is what the
  Tailwind `dark` variant keys off). Keep it minimal.

Persistence: `localStorage` only (the user's own browser preference — not label/application data), which is
consistent with invariant #6 (no server/label persistence).

### Token migration (the substantive work)

Replace hardcoded palette classes with the semantic tokens in `globals.css`, across `layout.tsx` and all
components under `components/` and the two pages:

| Hardcoded today                           | Semantic token              |
| ----------------------------------------- | --------------------------- |
| `bg-stone-50` (body)                      | `bg-background`             |
| `text-slate-900` / `text-slate-700`       | `text-foreground`           |
| `text-slate-500`                          | `text-muted-foreground`     |
| `bg-white`, `bg-white/85` (cards, header) | `bg-card`, `bg-card/85`     |
| `border-stone-200/*`                      | `border-border`             |
| focus rings, inputs                       | `ring-ring`, `border-input` |

- **Brand accent:** the emerald mark (`bg-emerald-600`) stays as an intentional brand color; give it a
  dark-aware treatment so it doesn't glare on the dark surface.
- **Verdict colors** (MATCH green / MISMATCH red / REVIEW amber) currently use fixed Tailwind shades. Add
  dark-mode variants (`dark:` classes or token-based) so contrast passes in both themes — verdict legibility
  is core to the tool and to the accessibility bar (non-technical persona; high contrast).

### Control

A three-way segmented control in the header (`Sun` · `Monitor` · `Moon`, lucide icons, each with an
accessible label; the active one visibly selected). Always visible, large tap targets, one tap per choice —
explicit and obvious for the persona. On narrow screens it collapses to a single icon button that opens a
small menu with the three labeled choices.

## 2. Per-field regulation references

### Data — `lib/ttb/citations.ts` (pure, tested, no I/O)

A lookup keyed by `(field, beverageType)`:

```ts
interface Citation {
  basis: string; // plain-English, one sentence: WHY this field is on the label
  cfr: string; // e.g. "27 CFR §5.65"
  url: string; // deep link to the section on ecfr.gov
}
function citationFor(field: keyof ExtractedLabel, beverageType: BeverageType): Citation | null;
```

- The correct CFR **part** depends on beverage type: wine → part 4, distilled spirits → part 5, malt
  beverages → part 7 (post-2020 TTB "modernization" numbering); the **health warning statement** is
  27 CFR part 16 for all types (US-mandated, always English).
- **Accuracy is the whole point.** Every `(field, beverageType)` citation — section number, basis wording,
  and eCFR URL — **must be verified against the current eCFR text and cited with its link before merge**
  (project rule: cite sources for any regulatory claim). Verifying the citation table is an explicit,
  gating task in the implementation plan; the numbers below are a _starting draft to verify_, not final.

Draft mapping to verify (fields × beverage type):

| Field                              | Wine (pt 4)       | Spirits (pt 5)    | Malt (pt 7)       |
| ---------------------------------- | ----------------- | ----------------- | ----------------- |
| brandName                          | verify            | verify            | verify            |
| classType (class/type designation) | verify            | verify            | verify            |
| alcoholContent                     | verify            | verify            | verify            |
| netContents                        | verify            | verify            | verify            |
| nameAndAddress                     | verify            | verify            | verify            |
| countryOfOrigin                    | verify (imported) | verify (imported) | verify (imported) |
| healthWarningStatement             | 27 CFR §16.21     | 27 CFR §16.21     | 27 CFR §16.21     |

If a field genuinely has no citation for a beverage type (e.g. country of origin on a domestic product),
`citationFor` returns `null` and the row simply omits the basis block — never a fabricated citation.

### Wiring

Look up the citation **at render time** in `field-row.tsx` from `(field, app.beverageType)`. This keeps
`lib/matching` output pure and unchanged (no verdict coupling; eval and matching tests unaffected). The
`beverageType` is already available where results are rendered (thread it to `field-row` via `verdict-card`
if not already present).

### Presentation

The always-visible inline block chosen in brainstorming, under each field's reason:

```
⚖  Basis: <plain-English one-liner>.
   27 CFR §x.y  ↗   (opens the section on eCFR in a new tab)
```

- Link: `target="_blank" rel="noopener noreferrer"`. External navigation only — allowed by CSP (not a
  `connect-src` fetch).
- High contrast in both themes; the citation link is a clear, large-enough target.

## 3. Testing

- **Citations (`lib/ttb/citations.test.ts`):** every `(field, beverageType)` either resolves to a citation
  whose `cfr` matches `^27 CFR §\d+\.\d+` and whose `url` is an `https://…ecfr.gov/…` link, or is a
  deliberate `null`. Health warning resolves to part 16 for all types.
- **`field-row` component test:** renders the basis text and a link with the expected `href` and
  `rel="noopener noreferrer"`; renders no basis block when `citationFor` returns `null`.
- **Theme:** `ThemeToggle` sets the `<html>` class and persists to `localStorage` for each choice; `system`
  reflects the `matchMedia` result. (jsdom for state/persistence.)
- **Production browser check:** boot `next start`, confirm the page hydrates with no flash and **zero CSP
  violations** in both themes and that the eCFR link is present — same method used in the security pass.
- **Unchanged:** all `lib/matching`, verdict, and eval tests. No server/matching behavior changes.

## Deferred / backlog (explicitly out of scope)

Captured here so they aren't lost; each becomes its own spec later:

1. **Persistent results history** — a cross-session history table is **gated on invariant #6 ("persist
   nothing")**; it would require a conscious decision to change the privacy/threat-model posture. An
   in-session, in-memory results list (no persistence) is the compatible alternative, but overlaps the
   existing Batch + CSV flow, so it's deferred.
2. **Richer / adversarial test labels** — the eval fixtures are clean centered serif text on a plain
   background; they don't exercise real artwork (backgrounds, decorative/script fonts, rotation, low
   contrast, dense back labels) or the threat model's headline risk (prompt-injection text embedded in
   artwork, LLM01). Improve `eval/generate-samples.ts` and add adversarial samples.
3. **Romance-language OCR on the keyless tier** — cloud tiers are already multilingual and `normalizeLoose`
   already folds diacritics; the gap is `local-ocr` using `createWorker("eng")` only. Add `fra/spa/ita/por`
   packs, weighing the added traineddata download + OCR latency against the <5 s budget.

## Non-goals

- No fuzziness/strictness control and no general settings panel (decided: keep matching fixed and
  auditable).
- No changes to extraction tiers, matching rules, the API contract, or the eval harness.
