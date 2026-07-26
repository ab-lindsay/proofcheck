# ProofCheck UI Gap Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address six UI gaps in ProofCheck: confidence explainability, feedback loop, extended character-level diff, retry affordance, batch StatusPill accessibility, and mobile sample button overflow.

**Architecture:** Create a new `FieldDetails` component that composes confidence tooltip, character diff, and feedback buttons. `FieldRow` delegates to it. Other changes (retry, mobile, aria) are incremental edits to existing components. All feedback is client-side only (demo scope).

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS, Lucide icons, react-hook-form

## Global Constraints

- All changes are additive — no existing behavior is removed or altered
- Feedback is client-side only (demo scope) — no persistence across page refreshes
- Dev mode gate remains for character-level diff
- No new API endpoints
- No new dependencies (native browser tooltips via `title` attribute)

---

## File Structure

| File                                                            | Change     | Responsibility                                                     |
| --------------------------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `components/field-details.tsx`                                  | **New**    | Confidence tooltip helper, CharacterDiff wrapper, feedback buttons |
| `components/field-row.tsx`                                      | **Modify** | Import FieldDetails, remove inline WarningDiff logic               |
| `components/warning-diff.tsx` → `components/character-diff.tsx` | **Rename** | Now used for all text fields                                       |
| `components/verdict-card.tsx`                                   | **Modify** | Add feedback state, pass to FieldRow                               |
| `app/page.tsx`                                                  | **Modify** | Add retry state, retry button, sample button overflow fix          |
| `components/batch-table.tsx`                                    | **Modify** | Add aria-label to StatusPill                                       |
| `components/field-details.test.tsx`                             | **New**    | Unit tests for confidenceTooltip helper                            |
| `components/field-row.test.tsx`                                 | **Modify** | Update tests for FieldDetails integration                          |
| `components/batch-table.test.tsx`                               | **Modify** | Add accessibility test for StatusPill                              |

---

### Task 1: Create FieldDetails Component (Confidence Tooltip)

**Files:**

- Create: `components/field-details.tsx`
- Create: `components/field-details.test.tsx`

**Interfaces:**

- Consumes: `FieldResult` from `lib/schema`
- Produces: `confidenceTooltip(confidence: number): string`

- [ ] **Step 1: Write the failing test for confidenceTooltip**

```typescript
// components/field-details.test.tsx
import { describe, it, expect } from "vitest";
import { confidenceTooltip } from "./field-details";

describe("confidenceTooltip", () => {
  it("returns exact match message for confidence 1.0", () => {
    expect(confidenceTooltip(1.0)).toBe("Exact match — all characters verified.");
  });

  it("returns high confidence message for confidence 0.95", () => {
    expect(confidenceTooltip(0.95)).toBe(
      "High confidence — minor differences detected (e.g., whitespace, punctuation).",
    );
  });

  it("returns high confidence message for confidence 0.99", () => {
    expect(confidenceTooltip(0.99)).toBe(
      "High confidence — minor differences detected (e.g., whitespace, punctuation).",
    );
  });

  it("returns partial match message for confidence 0.94", () => {
    expect(confidenceTooltip(0.94)).toBe("Partial match — 1 character(s) differed or were unclear.");
  });

  it("returns partial match message for confidence 0.5", () => {
    expect(confidenceTooltip(0.5)).toBe("Partial match — 1 character(s) differed or were unclear.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run components/field-details.test.tsx`
Expected: FAIL with "confidenceTooltip is not exported"

- [ ] **Step 3: Write minimal implementation**

```typescript
// components/field-details.tsx
export function confidenceTooltip(confidence: number): string {
  if (confidence === 1.0) return "Exact match — all characters verified.";
  if (confidence >= 0.95) return "High confidence — minor differences detected (e.g., whitespace, punctuation).";
  return "Partial match — 1 character(s) differed or were unclear.";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run components/field-details.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/field-details.tsx components/field-details.test.tsx
git commit -m "feat: add confidenceTooltip helper for field confidence explainability"
```

---

### Task 2: Add Confidence Tooltip to FieldRow

**Files:**

- Modify: `components/field-row.tsx:55-56`

**Interfaces:**

- Consumes: `confidenceTooltip` from `components/field-details.tsx`
- Produces: Updated confidence display with tooltip

- [ ] **Step 1: Import confidenceTooltip in FieldRow**

```typescript
// components/field-row.tsx (add to imports)
import { confidenceTooltip } from "@/components/field-details";
```

- [ ] **Step 2: Add title attribute to confidence span**

```typescript
// components/field-row.tsx (around line 55-56)
// Current:
<span className="text-xs text-muted-foreground">
  Confidence: {confidenceTier(result.confidence)} ({Math.round(result.confidence * 100)}%)
</span>

// Updated:
<span
  title={confidenceTooltip(result.confidence)}
  className="text-xs text-muted-foreground"
>
  Confidence: {confidenceTier(result.confidence)} ({Math.round(result.confidence * 100)}%)
</span>
```

- [ ] **Step 3: Run existing FieldRow tests**

Run: `pnpm vitest run components/field-row.test.tsx`
Expected: PASS (no regressions)

- [ ] **Step 4: Commit**

```bash
git add components/field-row.tsx
git commit -m "feat: add confidence tooltip to FieldRow"
```

---

### Task 3: Rename WarningDiff to CharacterDiff

> **Correction (2026-07-25, post-implementation).** This task was recorded in the SDD ledger as
> "review clean", and a reviewer's objection to Step 4's inequality check was dismissed there as
> "a false positive — check is present at field-row.tsx:64". That answered _is the check present?_,
> not _should it be?_ — and the answer to the second question was no. The final whole-branch review
> confirmed two defects originating here, both fixed in `42c3ad4`:
>
> - **The `applicationValue !== labelValue` guard in Step 4 was wrong.** It hid the character diff
>   whenever the two strings matched, which is precisely the regression `character-diff.test.tsx`
>   was written to pin ("STILL says it checked character-by-character when every character
>   matches"). The assurance is wanted most on a byte-exact health warning statement — i.e. exactly
>   when the values ARE equal. The component test kept passing because it renders `CharacterDiff`
>   directly; no FieldRow test covered the equal-values case. One now does.
> - **Extending the diff to all text fields carried the health warning's semantics with it.** Only
>   that field is judged byte-exact; every other text field goes through `fuzzyVerdict`, where case
>   and punctuation differences normalize away and can be COMPLIANT. The result was amber "needs
>   review" highlights, and copy about "the mandatory text", inside green COMPLIANT rows.
>   `CharacterDiff` now takes a `variant` so the two comparisons are presented as what they are.
>
> This task also violated the plan's own Global Constraint ("All changes are additive — no existing
> behavior is removed or altered"). Recorded here rather than in the SDD ledger because that file is
> rewritten wholesale for each new plan — the UI-gaps entries it once held have already been lost.

**Files:**

- Rename: `components/warning-diff.tsx` → `components/character-diff.tsx`
- Rename: `components/warning-diff.test.tsx` → `components/character-diff.test.tsx`
- Modify: `components/field-row.tsx:6` (update import)
- Modify: `components/field-row.tsx:60-64` (update render condition)

**Interfaces:**

- Consumes: `WarningDiffProps` from `components/warning-diff.tsx`
- Produces: `CharacterDiff` component

- [ ] **Step 1: Rename warning-diff.tsx to character-diff.tsx**

```bash
git mv components/warning-diff.tsx components/character-diff.tsx
git mv components/warning-diff.test.tsx components/character-diff.test.tsx
```

- [ ] **Step 2: Update component name in character-diff.tsx**

```typescript
// components/character-diff.tsx
// Change: export function WarningDiff
// To: export function CharacterDiff
```

- [ ] **Step 3: Update import in field-row.tsx**

```typescript
// components/field-row.tsx (update import)
import { CharacterDiff } from "@/components/character-diff";
```

- [ ] **Step 4: Update render condition in field-row.tsx**

```typescript
// components/field-row.tsx (around line 60-64)
// Current:
{devMode && result.field === "healthWarningStatement" && result.applicationValue && result.labelValue ? (
  <div className="mt-2 pl-8">
    <WarningDiff canonical={result.applicationValue} extracted={result.labelValue} />
  </div>
) : null}

// Updated:
{devMode && result.applicationValue && result.labelValue && result.applicationValue !== result.labelValue ? (
  <div className="mt-2 pl-8">
    <CharacterDiff canonical={result.applicationValue} extracted={result.labelValue} />
  </div>
) : null}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run components/character-diff.test.tsx components/field-row.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add components/character-diff.tsx components/character-diff.test.tsx components/field-row.tsx
git commit -m "feat: rename WarningDiff to CharacterDiff, extend to all text fields"
```

---

### Task 4: Add Feedback Buttons to FieldDetails

**Files:**

- Modify: `components/field-details.tsx`
- Modify: `components/field-details.test.tsx`

**Interfaces:**

- Consumes: `FieldResult` from `lib/schema`, `BeverageType` from `lib/schema`
- Produces: `FieldDetailsProps` interface, `FieldDetails` component

- [ ] **Step 1: Write the failing test for FieldDetails**

```typescript
// components/field-details.test.tsx (add to existing file)
import { render, screen } from "@testing-library/react";
import { FieldDetails } from "./field-details";
import type { FieldResult } from "@/lib/schema";

describe("FieldDetails", () => {
  const mockField: FieldResult = {
    field: "brandName",
    applicationValue: "OLD TOM DISTILLERY",
    labelValue: "OLD TOM DISTILLERY",
    verdict: "MATCH",
    confidence: 1.0,
    reason: "Matches the application exactly.",
  };

  it("renders feedback buttons", () => {
    render(<FieldDetails field={mockField} beverageType="distilled-spirits" />);
    expect(screen.getByLabelText("Feedback: helpful")).toBeInTheDocument();
    expect(screen.getByLabelText("Feedback: not helpful")).toBeInTheDocument();
  });

  it("calls onFeedback when helpful button clicked", async () => {
    const onFeedback = vi.fn();
    render(
      <FieldDetails
        field={mockField}
        beverageType="distilled-spirits"
        onFeedback={onFeedback}
      />
    );
    await screen.getByLabelText("Feedback: helpful").click();
    expect(onFeedback).toHaveBeenCalledWith("brandName", "up");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run components/field-details.test.tsx`
Expected: FAIL with "FieldDetails is not exported"

- [ ] **Step 3: Implement FieldDetails component**

```typescript
// components/field-details.tsx
import { CheckCircle2, XCircle } from "lucide-react";
import type { FieldResult, BeverageType } from "@/lib/schema";

export interface FieldDetailsProps {
  field: FieldResult;
  beverageType: BeverageType;
  onFeedback?: (field: string, direction: "up" | "down") => void;
  feedbackState?: "up" | "down" | null;
}

export function FieldDetails({
  field,
  onFeedback,
  feedbackState,
}: FieldDetailsProps) {
  return (
    <div className="flex items-center gap-2 ml-auto">
      <button
        type="button"
        aria-label="Feedback: helpful"
        aria-pressed={feedbackState === "up"}
        onClick={() => onFeedback?.(field.field, "up")}
        className={`p-1 rounded-md transition-colors ${
          feedbackState === "up"
            ? "text-verdict-match"
            : "text-muted-foreground hover:bg-muted"
        }`}
      >
        <CheckCircle2 className="h-5 w-5" />
      </button>
      <button
        type="button"
        aria-label="Feedback: not helpful"
        aria-pressed={feedbackState === "down"}
        onClick={() => onFeedback?.(field.field, "down")}
        className={`p-1 rounded-md transition-colors ${
          feedbackState === "down"
            ? "text-verdict-mismatch"
            : "text-muted-foreground hover:bg-muted"
        }`}
      >
        <XCircle className="h-5 w-5" />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run components/field-details.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/field-details.tsx components/field-details.test.tsx
git commit -m "feat: add FieldDetails component with feedback buttons"
```

---

### Task 5: Add Feedback State to VerdictCard

**Files:**

- Modify: `components/verdict-card.tsx`

**Interfaces:**

- Consumes: `FieldDetails` from `components/field-details.tsx`
- Produces: Feedback state management

- [ ] **Step 1: Add feedback state to VerdictCard**

```typescript
// components/verdict-card.tsx (add useState import if not present)
import { useState } from "react";

// Add state inside VerdictCard component
const [feedback, setFeedback] = useState<Map<string, "up" | "down">>(new Map());

const handleFeedback = (field: string, direction: "up" | "down") => {
  setFeedback((prev) => {
    const next = new Map(prev);
    if (next.get(field) === direction) {
      next.delete(field); // Toggle off if same direction clicked again
    } else {
      next.set(field, direction);
    }
    return next;
  });
};
```

- [ ] **Step 2: Pass feedback state to FieldRow**

```typescript
// components/verdict-card.tsx (in the FieldRow render)
{result.fields.map((f) => (
  <FieldRow
    key={f.field}
    result={f}
    beverageType={result.beverageType}
    feedbackState={feedback.get(f.field) ?? null}
    onFeedback={handleFeedback}
  />
))}
```

- [ ] **Step 3: Update FieldRow to accept and pass feedback props**

```typescript
// components/field-row.tsx (update FieldRow signature)
export function FieldRow({
  result,
  beverageType,
  feedbackState,
  onFeedback,
}: {
  result: FieldResult;
  beverageType: BeverageType;
  feedbackState?: "up" | "down" | null;
  onFeedback?: (field: string, direction: "up" | "down") => void;
}) {
  // ... existing code ...

  // Add FieldDetails after the citation section
  return (
    <li className="py-4">
      {/* ... existing content ... */}
      {citation ? (
        <p className="mt-1.5 flex items-start gap-1 pl-8 text-base text-muted-foreground">
          {/* ... existing citation content ... */}
        </p>
      ) : null}
      <div className="mt-2 pl-8">
        <FieldDetails
          field={result}
          beverageType={beverageType}
          feedbackState={feedbackState}
          onFeedback={onFeedback}
        />
      </div>
    </li>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run components/verdict-card.test.tsx components/field-row.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/verdict-card.tsx components/field-row.tsx
git commit -m "feat: integrate feedback state management in VerdictCard"
```

---

### Task 6: Add Retry Affordance to Error Card

**Files:**

- Modify: `app/page.tsx`

**Interfaces:**

- Consumes: `useVerify` hook
- Produces: `lastVerifyArgs` state, retry button

- [ ] **Step 1: Add lastVerifyArgs state**

```typescript
// app/page.tsx (add to state declarations)
const [lastVerifyArgs, setLastVerifyArgs] = useState<{
  app: ApplicationData;
  file: File;
  source: "sample" | "upload";
} | null>(null);
```

- [ ] **Step 2: Set lastVerifyArgs in onSubmit**

```typescript
// app/page.tsx (in onSubmit function)
const onSubmit = (app: ApplicationData) => {
  if (file) {
    const source = isSample ? "sample" : "upload";
    setLastVerifyArgs({ app, file, source });
    void verify(app, file, source);
  }
};
```

- [ ] **Step 3: Clear lastVerifyArgs when image changes**

```typescript
// app/page.tsx (in onUpload function)
const onUpload = (f: File | null) => {
  setFile(f);
  setIsSample(false);
  setPreviewSrc(null);
  setLastVerifyArgs(null); // Clear retry args
  reset();
};
```

- [ ] **Step 4: Clear lastVerifyArgs when sample loads**

```typescript
// app/page.tsx (in loadSample function)
const loadSample = async (sample: (typeof SAMPLES)[number]) => {
  setSampleError(null);
  reset();
  setLastVerifyArgs(null); // Clear retry args
  // ... rest of function
};
```

- [ ] **Step 5: Add retry button to error card**

```typescript
// app/page.tsx (in the error card section)
) : error ? (
  <div
    className="rounded-2xl border border-verdict-mismatch/30 bg-verdict-mismatch-bg px-6 py-5 shadow-sm"
    role="alert"
  >
    <p className="text-xl font-semibold text-verdict-mismatch">Something went wrong</p>
    <p className="mt-1 text-lg text-verdict-mismatch">{error}</p>
    {lastVerifyArgs && (
      <button
        onClick={() => {
          void verify(lastVerifyArgs.app, lastVerifyArgs.file, lastVerifyArgs.source);
        }}
        disabled={loading}
        className="mt-4 rounded-lg bg-primary px-4 py-2 text-base font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Retrying…" : "Try again"}
      </button>
    )}
  </div>
) : (
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run app/page.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add app/page.tsx
git commit -m "feat: add retry affordance to error card"
```

---

### Task 7: Fix Mobile Overflow for Sample Buttons

**Files:**

- Modify: `app/page.tsx:181-189`

**Interfaces:**

- Consumes: None
- Produces: Updated sample button styling

- [ ] **Step 1: Update sample button styling**

```typescript
// app/page.tsx (in the SAMPLES map)
{SAMPLES.map((sample) => (
  <button
    key={sample.name}
    type="button"
    onClick={() => void loadSample(sample)}
    title={sample.label}
    className="flex min-w-0 flex-col items-start rounded-xl border border-border bg-card px-4 py-2.5 text-left shadow-sm transition-colors hover:border-proof hover:bg-accent"
  >
    <span className="max-w-full text-base font-semibold text-foreground truncate">
      {sample.label}
    </span>
    <span className="max-w-full text-sm text-muted-foreground truncate">
      {sample.tag}
    </span>
  </button>
))}
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run app/page.test.tsx`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "fix: add truncation and tooltip to sample buttons for mobile"
```

---

### Task 8: Add Aria-Label to Batch StatusPill

**Files:**

- Modify: `components/batch-table.tsx:6-33`
- Modify: `components/batch-table.test.tsx`

**Interfaces:**

- Consumes: `BatchItem` from `lib/csv`
- Produces: Accessible StatusPill

- [ ] **Step 1: Write the failing accessibility test**

```typescript
// components/batch-table.test.tsx (add new test)
import { render, screen } from "@testing-library/react";
import { BatchTable } from "./batch-table";
import type { BatchItem } from "@/lib/csv";

describe("BatchTable accessibility", () => {
  it("StatusPill has aria-label for done items", () => {
    const items: BatchItem[] = [
      {
        filename: "test-label.png",
        status: "done",
        result: {
          overall: "PASS",
          fields: [],
          warnings: [],
          tier: "mock",
          processingMs: 100,
          beverageType: "distilled-spirits",
        },
      },
    ];
    render(<BatchTable items={items} />);
    expect(screen.getByLabelText("Result for test-label.png: PASS")).toBeInTheDocument();
  });

  it("StatusPill has aria-label for error items", () => {
    const items: BatchItem[] = [
      {
        filename: "bad-label.png",
        status: "error",
        error: "File not found",
      },
    ];
    render(<BatchTable items={items} />);
    expect(screen.getByLabelText("Error for bad-label.png: File not found")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run components/batch-table.test.tsx`
Expected: FAIL with "Unable to find an accessible element with role..."

- [ ] **Step 3: Add aria-label to StatusPill**

```typescript
// components/batch-table.tsx (update StatusPill component)
function StatusPill({ item }: { item: BatchItem }) {
  if (item.status === "done") {
    const pass = item.result?.overall === "PASS";
    return (
      <span
        aria-label={`Result for ${item.filename}: ${item.result?.overall}`}
        className={`inline-block rounded-full border px-3 py-1 text-sm font-bold ${
          pass
            ? "border-verdict-match/30 bg-verdict-match-bg text-verdict-match"
            : "border-verdict-mismatch/30 bg-verdict-mismatch-bg text-verdict-mismatch"
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
        className="inline-block rounded-full border border-verdict-mismatch/30 bg-verdict-mismatch-bg px-3 py-1 text-sm font-bold text-verdict-mismatch"
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run components/batch-table.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/batch-table.tsx components/batch-table.test.tsx
git commit -m "feat: add aria-label to batch StatusPill for accessibility"
```

---

### Task 9: Run Full Test Suite and E2E

**Files:**

- None (verification only)

**Interfaces:**

- Consumes: All previous tasks
- Produces: Passing test suite

- [ ] **Step 1: Run unit tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 2: Run e2e tests**

Run: `pnpm e2e`
Expected: All e2e tests pass

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors

- [ ] **Step 4: Run lint**

Run: `pnpm lint`
Expected: No lint errors

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address test and lint issues from UI gap remediation"
```

---

## Self-Review Checklist

- [ ] All 6 gaps have corresponding tasks
- [ ] No placeholders ("TBD", "TODO", etc.)
- [ ] All types and function names are consistent across tasks
- [ ] All code blocks are complete and copy-pasteable
- [ ] All test commands have expected output
- [ ] All commits have descriptive messages
