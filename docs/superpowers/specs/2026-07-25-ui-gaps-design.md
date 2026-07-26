# Design Spec: ProofCheck UI Gap Remediation

**Date:** 2026-07-25
**Status:** Approved
**Scope:** 6 gaps identified in Playwright MCP UI assessment

---

## Summary

Address six UI gaps in ProofCheck: confidence explainability, feedback loop, extended character-level diff, retry affordance, batch StatusPill accessibility, and mobile sample button overflow. All changes are additive — no existing behavior is removed or altered.

---

## Architecture Decision

**Approach:** Shared `FieldDetails` component (Approach 2 from brainstorming)

Create a new `FieldDetails` component that composes confidence tooltip, character diff, and feedback buttons. `FieldRow` delegates to it. Other changes (retry, mobile, aria) are incremental edits to existing components.

**Why not incremental (Approach 1):** `FieldRow` is already 95 lines. Adding three features directly would push it past 150 lines and make future field-level features harder to add.

**Why not full compound component (Approach 3):** Overkill for 6 gaps. The collapsible section architecture would require significant refactoring of `FieldRow` and `VerdictCard` for marginal benefit.

---

## Section 1: FieldDetails Component

### New file: `components/field-details.tsx`

A component that renders in the field row, below the field comparison grid (Application vs Label). It composes three sub-features: confidence tooltip, character diff, and feedback buttons.

**Props:**

```typescript
interface FieldDetailsProps {
  field: FieldResult;
  beverageType: BeverageType;
  onFeedback?: (field: string, direction: "up" | "down") => void;
  feedbackState?: "up" | "down" | null;
}
```

### 1a. Confidence Tooltip

Wrap the existing confidence text in a `<span>` with a native `title` attribute.

**Tooltip content logic:**

- `confidence === 1.00`: `"Exact match — all characters verified."`
- `confidence >= 0.95`: `"High confidence — minor differences detected (e.g., whitespace, punctuation)."`
- `confidence < 0.95`: `"Partial match — N character(s) differed or were unclear."`

**Implementation:** Export a `confidenceTooltip(confidence: number)` helper from `field-details.tsx`. In `FieldRow`, import and use it: `title={confidenceTooltip(result.confidence)}` on the existing confidence `<span>`.

**No new dependencies** — native browser tooltip via `title` attribute.

### 1b. CharacterDiff (Extended WarningDiff)

**Current behavior:** `WarningDiff` only renders for `healthWarningStatement` fields in dev mode (`field-row.tsx:60-64`).

**New behavior:** Show character-level diff for **all text fields** when both `applicationValue` and `labelValue` are present and differ. Dev mode gate remains.

**Affected fields:** brand name, class/type designation, alcohol content, net contents, health warning statement.

**Component rename:** Rename `WarningDiff` to `CharacterDiff` and update all imports. The underlying `diffWarningTokens` function from `lib/ttb/warning-diff.ts` works on any text — no changes needed there. The file `components/warning-diff.tsx` is renamed to `components/character-diff.tsx`.

**Render condition in FieldRow:**

```typescript
{devMode && result.applicationValue && result.labelValue && result.applicationValue !== result.labelValue ? (
  <div className="mt-2 pl-8">
    <CharacterDiff canonical={result.applicationValue} extracted={result.labelValue} />
  </div>
) : null}
```

### 1c. Feedback Buttons

Two icon buttons rendered in the field row header, next to the confidence display.

**Visual design:**

- 👍: `CheckCircle2` icon, `text-muted-foreground` default, `text-verdict-compliant` when selected
- 👎: `XCircle` icon, `text-muted-foreground` default, `text-verdict-non-compliant` when selected
- Container: `flex items-center gap-1` with `ml-auto` (right-aligned, same row as verdict pill)
- Buttons: `p-1 rounded-md hover:bg-muted transition-colors` — minimal, non-intrusive

**State management:**

- Parent (`VerdictCard`) holds a `Map<string, "up" | "down">` keyed by field name
- Passed down to `FieldDetails` as `feedbackState`
- `onFeedback` callback updates the parent map
- No persistence — resets on page refresh (demo scope)

**Accessibility:**

- `aria-label="Feedback: helpful"` / `aria-label="Feedback: not helpful"`
- `aria-pressed={feedbackState === "up"}` / `aria-pressed={feedbackState === "down"}`

---

## Section 2: Retry Affordance

### Modified file: `app/page.tsx`

**Current error card (lines 217-224):**

```tsx
<div
  className="rounded-2xl border border-verdict-non-compliant/30 bg-verdict-non-compliant-bg px-6 py-5 shadow-sm"
  role="alert"
>
  <p className="text-xl font-semibold text-verdict-non-compliant">Something went wrong</p>
  <p className="mt-1 text-lg text-verdict-non-compliant">{error}</p>
</div>
```

**New error card:**

```tsx
<div
  className="rounded-2xl border border-verdict-non-compliant/30 bg-verdict-non-compliant-bg px-6 py-5 shadow-sm"
  role="alert"
>
  <p className="text-xl font-semibold text-verdict-non-compliant">Something went wrong</p>
  <p className="mt-1 text-lg text-verdict-non-compliant">{error}</p>
  {lastVerifyArgs && (
    <button
      onClick={() => void verify(lastVerifyArgs.app, lastVerifyArgs.file, lastVerifyArgs.source)}
      disabled={loading}
      className="mt-4 rounded-lg bg-primary px-4 py-2 text-base font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? "Retrying…" : "Try again"}
    </button>
  )}
</div>
```

**State:**

- Add `lastVerifyArgs` state: `{ app: ApplicationData; file: File; source: "sample" | "upload" } | null`
- Set it in `onSubmit` before calling `verify()`
- Clear it when `onUpload` is called (user changed the image)
- Clear it when `loadSample` is called (user loaded a different sample)

---

## Section 3: Mobile Overflow Fix

### Modified file: `app/page.tsx`

**Current sample button (lines 181-189):**

```tsx
<button className="flex flex-col items-start rounded-xl border border-border bg-card px-4 py-2.5 text-left shadow-sm transition-colors hover:border-proof hover:bg-accent">
  <span className="text-base font-semibold text-foreground">{sample.label}</span>
  <span className="text-sm text-muted-foreground">{sample.tag}</span>
</button>
```

**Updated sample button:**

```tsx
<button
  title={sample.label}
  className="flex min-w-0 flex-col items-start rounded-xl border border-border bg-card px-4 py-2.5 text-left shadow-sm transition-colors hover:border-proof hover:bg-accent"
>
  <span className="max-w-full text-base font-semibold text-foreground truncate">{sample.label}</span>
  <span className="max-w-full text-sm text-muted-foreground truncate">{sample.tag}</span>
</button>
```

**Changes:**

- Add `min-w-0` to button (prevents flex item from growing beyond container)
- Add `max-w-full` and `truncate` to both text spans
- Add `title={sample.label}` for native tooltip on hover/tap

---

## Section 4: Batch StatusPill Aria-Label

### Modified file: `components/batch-table.tsx`

**Current StatusPill (lines 6-33):** Returns `<span>` with text content but no `aria-label`.

**Updated StatusPill:**

```tsx
function StatusPill({ item }: { item: BatchItem }) {
  if (item.status === "done") {
    const pass = item.result?.overall === "PASS";
    return (
      <span
        aria-label={`Result for ${item.filename}: ${item.result?.overall}`}
        className={`inline-block rounded-full border px-3 py-1 text-sm font-bold ${
          pass
            ? "border-verdict-compliant/30 bg-verdict-compliant-bg text-verdict-compliant"
            : "border-verdict-non-compliant/30 bg-verdict-non-compliant-bg text-verdict-non-compliant"
        }`}
      >
        {item.result?.overall}
      </span>
    );
  }
  if (item.status === "error") {
    return (
      <span
        aria-label={`Error for ${item.filename}: ${item.error ?? "unknown error"}`}
        className="inline-block rounded-full border border-verdict-non-compliant/30 bg-verdict-non-compliant-bg px-3 py-1 text-sm font-bold text-verdict-non-compliant"
      >
        ERROR
      </span>
    );
  }
  return (
    <span
      aria-label={`Status for ${item.filename}: ${item.status}`}
      className="inline-block rounded-full border border-border bg-muted px-3 py-1 text-sm font-medium text-muted-foreground"
    >
      {item.status}
    </span>
  );
}
```

---

## Files Modified

| File                            | Change                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `components/field-details.tsx`  | **New** — FieldDetails component with confidence tooltip, CharacterDiff, feedback buttons  |
| `components/field-row.tsx`      | Import and render FieldDetails; remove inline WarningDiff logic for healthWarningStatement |
| `components/character-diff.tsx` | **Renamed** from `warning-diff.tsx` — now used for all text fields                         |
| `components/verdict-card.tsx`   | Add feedback state (`Map<string, "up"                                                      | "down">`), pass to FieldRow |
| `app/page.tsx`                  | Add `lastVerifyArgs` state, retry button in error card, sample button overflow fix         |
| `components/batch-table.tsx`    | Add `aria-label` to StatusPill                                                             |

## Files NOT Modified

| File                      | Reason                                                            |
| ------------------------- | ----------------------------------------------------------------- |
| `lib/ttb/warning-diff.ts` | `diffWarningTokens` already works on any text — no changes needed |
| `lib/matching/verify.ts`  | Confidence thresholds are display-only — no logic changes         |
| `app/api/verify/route.ts` | No API changes — all feedback is client-side                      |

---

## Testing Strategy

1. **Unit tests:** Add tests for `confidenceTooltip()` helper function (boundary values: 1.00, 0.95, 0.94, 0.50)
2. **Component tests:** Add tests for `FieldDetails` rendering (tooltip present, diff shown for text fields, feedback buttons toggle)
3. **Integration test:** Verify retry button re-calls verify with last args
4. **Accessibility test:** Verify StatusPill has aria-label in batch table
5. **Visual test:** Verify sample buttons truncate on narrow viewport (< 375px)
6. **Existing tests:** Run `pnpm test` and `pnpm e2e` to ensure no regressions

---

## Out of Scope

- Feedback persistence (client-side only for demo)
- Confidence explainability beyond tooltip (e.g., expandable details)
- Auto-retry on failure
- Collapsible field sections
- New API endpoints
