# Bedrock Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dev-mode-only Bedrock model picker to switch between Claude Haiku 4.5 (default, passes 5s budget) and Claude Opus 4.5 (highest accuracy, exceeds budget).

**Architecture:** Follows the existing dev mode pattern: a `useSyncExternalStore` + localStorage hook for state, a segmented control in the header, form data field appended to verify requests, server-side mapping to full model IDs.

**Tech Stack:** React, TypeScript, Next.js, Vitest, @testing-library/react

## Global Constraints

- Default model is `haiku` (passes 5s p95 budget)
- Opus exceeds the 5s budget — visual warning indicator required
- No runtime budget enforcement — picker is a deliberate override
- No changes to `lib/matching`, `lib/schema.ts`, or verdict logic
- Follow existing `useDevTier`/`TierSwitcher` patterns exactly

---

## File Structure

| File                               | Action | Purpose                                      |
| ---------------------------------- | ------ | -------------------------------------------- |
| `hooks/use-dev-model.ts`           | Create | State management for model selection         |
| `hooks/use-dev-model.test.ts`      | Create | Unit tests for the hook                      |
| `components/model-picker.tsx`      | Create | Segmented control UI                         |
| `components/model-picker.test.tsx` | Create | Component tests                              |
| `lib/vision/cloud/bedrock.ts`      | Modify | Add `modelOverride` parameter to `extract()` |
| `lib/vision/cloud/bedrock.test.ts` | Modify | Add test for model override                  |
| `app/api/verify/route.ts`          | Modify | Read `devBedrockModel` from form data        |
| `app/api/verify/route.test.ts`     | Modify | Add tests for model override routing         |
| `hooks/use-verify.ts`              | Modify | Append `devBedrockModel` to FormData         |
| `hooks/use-batch.ts`               | Modify | Pass `devBedrockModel` to `verifyOne()`      |
| `app/layout.tsx`                   | Modify | Mount `<ModelPicker />`                      |

---

### Task 1: Create `useDevBedrockModel` hook

**Files:**

- Create: `hooks/use-dev-model.ts`
- Create: `hooks/use-dev-model.test.ts`
- Reference: `hooks/use-dev-tier.ts` (pattern to follow)

**Interfaces:**

- Consumes: None (standalone hook)
- Produces: `useDevBedrockModel(): DevBedrockModel`, `setDevBedrockModel(value: DevBedrockModel): void`, `type DevBedrockModel = "haiku" | "opus"`

- [ ] **Step 1: Write the failing test**

```ts
// hooks/use-dev-model.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useDevBedrockModel, setDevBedrockModel } from "@/hooks/use-dev-model";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("useDevBedrockModel", () => {
  it("defaults to 'haiku' when nothing is stored", () => {
    const { result } = renderHook(() => useDevBedrockModel());
    expect(result.current).toBe("haiku");
  });

  it("reflects a stored valid value on mount", () => {
    localStorage.setItem("devBedrockModel", "opus");
    const { result } = renderHook(() => useDevBedrockModel());
    expect(result.current).toBe("opus");
  });

  it("falls back to 'haiku' for a malformed stored value", () => {
    localStorage.setItem("devBedrockModel", "not-a-real-model");
    const { result } = renderHook(() => useDevBedrockModel());
    expect(result.current).toBe("haiku");
  });

  it("updates every subscribed hook instance when setDevBedrockModel is called", () => {
    const a = renderHook(() => useDevBedrockModel());
    const b = renderHook(() => useDevBedrockModel());
    act(() => setDevBedrockModel("opus"));
    expect(a.result.current).toBe("opus");
    expect(b.result.current).toBe("opus");
    expect(localStorage.getItem("devBedrockModel")).toBe("opus");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run hooks/use-dev-model.test.ts`
Expected: FAIL with "Cannot find module '@/hooks/use-dev-model'"

- [ ] **Step 3: Write minimal implementation**

```ts
// hooks/use-dev-model.ts
"use client";
import { useSyncExternalStore } from "react";

export type DevBedrockModel = "haiku" | "opus";

const STORAGE_KEY = "devBedrockModel";
const VALID_MODELS: readonly DevBedrockModel[] = ["haiku", "opus"];
type Listener = () => void;
const listeners = new Set<Listener>();

function isDevBedrockModel(value: string | null): value is DevBedrockModel {
  return value !== null && (VALID_MODELS as readonly string[]).includes(value);
}

function getSnapshot(): DevBedrockModel {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isDevBedrockModel(stored) ? stored : "haiku";
}

function getServerSnapshot(): DevBedrockModel {
  return "haiku";
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setDevBedrockModel(value: DevBedrockModel): void {
  localStorage.setItem(STORAGE_KEY, value);
  listeners.forEach((listener) => listener());
}

export function useDevBedrockModel(): DevBedrockModel {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run hooks/use-dev-model.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hooks/use-dev-model.ts hooks/use-dev-model.test.ts
git commit -m "feat: add useDevBedrockModel hook"
```

---

### Task 2: Create `ModelPicker` component

**Files:**

- Create: `components/model-picker.tsx`
- Create: `components/model-picker.test.tsx`
- Reference: `components/tier-switcher.tsx` (pattern to follow)

**Interfaces:**

- Consumes: `useDevMode()`, `useDevBedrockModel()`, `setDevBedrockModel()`
- Produces: `<ModelPicker />` component (renders in header when dev mode is on)

- [ ] **Step 1: Write the failing test**

```tsx
// components/model-picker.test.tsx
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ModelPicker } from "@/components/model-picker";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("devMode", "true");
});
afterEach(cleanup);

describe("ModelPicker", () => {
  it("renders nothing when dev mode is off", () => {
    localStorage.setItem("devMode", "false");
    const { container } = render(<ModelPicker />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders both model options when dev mode is on", () => {
    render(<ModelPicker />);
    expect(screen.getByRole("radio", { name: "Haiku 4.5" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Opus 4.5" })).toBeInTheDocument();
  });

  it("defaults to Haiku selected", () => {
    render(<ModelPicker />);
    expect(screen.getByRole("radio", { name: "Haiku 4.5" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Opus 4.5" })).toHaveAttribute("aria-checked", "false");
  });

  it("selecting Opus persists the choice", () => {
    render(<ModelPicker />);
    fireEvent.click(screen.getByRole("radio", { name: "Opus 4.5" }));
    expect(screen.getByRole("radio", { name: "Opus 4.5" })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("devBedrockModel")).toBe("opus");
  });

  it("selecting Haiku persists the choice", () => {
    localStorage.setItem("devBedrockModel", "opus");
    render(<ModelPicker />);
    fireEvent.click(screen.getByRole("radio", { name: "Haiku 4.5" }));
    expect(screen.getByRole("radio", { name: "Haiku 4.5" })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("devBedrockModel")).toBe("haiku");
  });

  it("Opus button has warning styling when selected", () => {
    render(<ModelPicker />);
    fireEvent.click(screen.getByRole("radio", { name: "Opus 4.5" }));
    const opusBtn = screen.getByRole("radio", { name: "Opus 4.5" });
    expect(opusBtn.className).toContain("bg-amber");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run components/model-picker.test.tsx`
Expected: FAIL with "Cannot find module '@/components/model-picker'"

- [ ] **Step 3: Write minimal implementation**

```tsx
// components/model-picker.tsx
"use client";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useDevBedrockModel, setDevBedrockModel, type DevBedrockModel } from "@/hooks/use-dev-model";

const OPTIONS: { value: DevBedrockModel; label: string; title: string }[] = [
  {
    value: "haiku",
    label: "Haiku 4.5",
    title: "Fastest, lowest cost — passes 5s p95 budget (4431ms)",
  },
  {
    value: "opus",
    label: "Opus 4.5",
    title: "Highest accuracy (89%) — exceeds 5s p95 budget (7586ms)",
  },
];

export function ModelPicker() {
  const devMode = useDevMode();
  const model = useDevBedrockModel();
  if (!devMode) return null;

  return (
    <div
      role="radiogroup"
      aria-label="Bedrock model"
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1"
    >
      {OPTIONS.map(({ value, label, title }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={model === value}
          title={title}
          onClick={() => setDevBedrockModel(value)}
          className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${
            model === value
              ? value === "opus"
                ? "bg-amber-500 text-white"
                : "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run components/model-picker.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/model-picker.tsx components/model-picker.test.tsx
git commit -m "feat: add ModelPicker component"
```

---

### Task 3: Add `modelOverride` parameter to Bedrock provider

**Files:**

- Modify: `lib/vision/cloud/bedrock.ts:19-88`
- Modify: `lib/vision/cloud/bedrock.test.ts`
- Reference: `lib/vision/types.ts` (VisionProvider interface)

**Interfaces:**

- Consumes: None (standalone provider modification)
- Produces: `bedrockProvider.extract()` accepts optional `modelOverride?: string` parameter

- [ ] **Step 1: Write the failing test**

Read `lib/vision/cloud/bedrock.test.ts` first to understand existing test structure, then add:

```ts
it("uses modelOverride when provided instead of BEDROCK_MODEL env", async () => {
  process.env.AWS_BEARER_TOKEN_BEDROCK = "test-token";
  process.env.BEDROCK_MODEL = "original-model";
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ output: { message: { content: [{ text: '{"name":"test"}' }] } } }),
  });
  vi.stubGlobal("fetch", fetchMock);

  const { bedrockProvider } = await import("@/lib/vision/cloud/bedrock");
  await bedrockProvider.extract(
    Buffer.from("fake"),
    {
      filename: "test.png",
      mimeType: "image/png",
    },
    { modelOverride: "custom-model-id" },
  );

  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("custom-model-id"), expect.anything());
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("original-model"), expect.anything());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/vision/cloud/bedrock.test.ts`
Expected: FAIL (test should fail because `modelOverride` parameter doesn't exist yet)

- [ ] **Step 3: Write minimal implementation**

Modify `lib/vision/cloud/bedrock.ts` to accept optional `modelOverride` in `extract()`:

```ts
// Add to VisionProvider type or use inline options type
async extract(image: Buffer, meta: { filename: string; mimeType: string }, options?: { modelOverride?: string }) {
  // ... existing token check ...

  const region = process.env.BEDROCK_REGION ?? DEFAULT_REGION;
  const model = options?.modelOverride ?? process.env.BEDROCK_MODEL ?? DEFAULT_MODEL;
  // ... rest unchanged ...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/vision/cloud/bedrock.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/vision/cloud/bedrock.ts lib/vision/cloud/bedrock.test.ts
git commit -m "feat: add modelOverride parameter to bedrock provider"
```

---

### Task 4: Wire `devBedrockModel` through the verify route

**Files:**

- Modify: `app/api/verify/route.ts:70-169`
- Modify: `app/api/verify/route.test.ts`

**Interfaces:**

- Consumes: `bedrockProvider.extract()` with `modelOverride` parameter
- Produces: Route reads `devBedrockModel` from form data and passes to provider

- [ ] **Step 1: Write the failing test**

Read `app/api/verify/route.test.ts` first to understand existing test structure, then add:

```ts
it("routes devBedrockModel=opus to the Opus model ID when bedrock tier is active", async () => {
  // Stub AWS_BEARER_TOKEN_BEDROCK so bedrock provider is selected
  process.env.AWS_BEARER_TOKEN_BEDROCK = "test-token";
  // ... existing test setup for FormData ...
  fd.set("devBedrockModel", "opus");
  fd.set("devTier", "cloud");
  // ... mock fetch to capture the request ...
  // Assert the URL contains "us.anthropic.claude-opus-4-5-20251101-v1:0"
});

it("falls back to BEDROCK_MODEL env when devBedrockModel is absent", async () => {
  process.env.AWS_BEARER_TOKEN_BEDROCK = "test-token";
  process.env.BEDROCK_MODEL = "env-model";
  // ... existing test setup ...
  // Don't set devBedrockModel
  fd.set("devTier", "cloud");
  // Assert the URL contains "env-model"
});

it("falls back to BEDROCK_MODEL env when devBedrockModel is malformed", async () => {
  process.env.AWS_BEARER_TOKEN_BEDROCK = "test-token";
  process.env.BEDROCK_MODEL = "env-model";
  // ... existing test setup ...
  fd.set("devBedrockModel", "invalid-model");
  fd.set("devTier", "cloud");
  // Assert the URL contains "env-model"
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run app/api/verify/route.test.ts`
Expected: FAIL (tests should fail because `devBedrockModel` is not read yet)

- [ ] **Step 3: Write minimal implementation**

Add to `app/api/verify/route.ts` after line 146 (where `devTier` is read):

```ts
const VALID_BEDROCK_MODELS = new Set(["haiku", "opus"]);
const BEDROCK_MODEL_MAP: Record<string, string> = {
  haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  opus: "us.anthropic.claude-opus-4-5-20251101-v1:0",
};

const devBedrockModelRaw = form.get("devBedrockModel");
const devBedrockModel =
  typeof devBedrockModelRaw === "string" && VALID_BEDROCK_MODELS.has(devBedrockModelRaw)
    ? devBedrockModelRaw
    : undefined;
```

Then modify the bedrock provider selection (around line 156-164) to pass the model override:

```ts
} else if (devTier === "cloud") {
  const cloud = selectCloudProvider();
  if (!cloud) {
    return NextResponse.json(
      { error: "Cloud tier requires an API key configured on the server." },
      { status: 400 },
    );
  }
  provider = cloud;
}
```

And after provider selection, if bedrock is selected and devBedrockModel is present, we need to pass it. The cleanest approach is to wrap the provider:

```ts
// After provider selection, before the extraction call
if (provider?.name === "bedrock" && devBedrockModel) {
  const originalExtract = provider.extract.bind(provider);
  const modelId = BEDROCK_MODEL_MAP[devBedrockModel];
  provider = {
    ...provider,
    extract: (image, meta) => originalExtract(image, meta, { modelOverride: modelId }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run app/api/verify/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/verify/route.ts app/api/verify/route.test.ts
git commit -m "feat: wire devBedrockModel through verify route"
```

---

### Task 5: Append `devBedrockModel` from client hooks

**Files:**

- Modify: `hooks/use-verify.ts:23-54`
- Modify: `hooks/use-batch.ts:11-29,31-76`

**Interfaces:**

- Consumes: `useDevBedrockModel()` hook
- Produces: `devBedrockModel` field appended to FormData when dev mode is on

- [ ] **Step 1: Write the failing test**

Read existing tests for `use-verify.ts` and `use-batch.ts` to understand test patterns, then add tests that verify `devBedrockModel` is appended to FormData when dev mode is on.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run hooks/use-verify.test.ts hooks/use-batch.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Modify `hooks/use-verify.ts`:

```ts
import { useDevBedrockModel } from "@/hooks/use-dev-model";

// In useVerify():
const devBedrockModel = useDevBedrockModel();

// In the verify callback, after line 37:
if (devMode) fd.set("devBedrockModel", devBedrockModel);

// Add to useCallback dependencies:
}, [devMode, devTier, devEscalation, devBedrockModel]);
```

Modify `hooks/use-batch.ts`:

```ts
import { useDevBedrockModel, type DevBedrockModel } from "@/hooks/use-dev-model";

// In verifyOne(), add parameter:
async function verifyOne(
  row: BatchRow,
  file: File,
  devTier?: DevTier,
  escalate?: boolean,
  devBedrockModel?: DevBedrockModel,
): Promise<VerifyResponse> {
  // ... after line 20:
  if (devBedrockModel) fd.set("devBedrockModel", devBedrockModel);
  // ...
}

// In useBatch():
const devBedrockModel = useDevBedrockModel();

// In run callback, compute effective value:
const effectiveDevBedrockModel = devMode ? devBedrockModel : undefined;

// Pass to verifyOne():
const result = await verifyOne(
  row,
  files.get(row.filename) as File,
  effectiveDevTier,
  effectiveEscalate,
  effectiveDevBedrockModel,
);

// Add to useCallback dependencies:
}, [devMode, devTier, devEscalation, devBedrockModel]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run hooks/use-verify.test.ts hooks/use-batch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hooks/use-verify.ts hooks/use-batch.ts
git commit -m "feat: append devBedrockModel from client hooks"
```

---

### Task 6: Mount `ModelPicker` in layout

**Files:**

- Modify: `app/layout.tsx:1-103`

**Interfaces:**

- Consumes: `<ModelPicker />` component, `useDevMode()` hook
- Produces: Model picker rendered in header when dev mode is on

- [ ] **Step 1: Write the failing test**

Read existing `app/layout.test.tsx` to understand test patterns, then add a test that verifies `<ModelPicker />` renders when dev mode is on.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run app/layout.test.tsx`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Add import at top of `app/layout.tsx`:

```ts
import { ModelPicker } from "@/components/model-picker";
```

Add `<ModelPicker />` after `<TierSwitcher />` in the header (around line 88):

```tsx
<DevModeToggle />
<TierSwitcher />
<ModelPicker />
<EscalationToggle />
<ThemeToggle />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run app/layout.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/layout.tsx
git commit -m "feat: mount ModelPicker in layout header"
```

---

### Task 7: Full regression check

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `pnpm lint`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 4: Run eval to confirm no matching changes**

Run: `pnpm eval`
Expected: No regressions in matching accuracy

- [ ] **Step 5: Visual verification**

Start dev server, enable dev mode, verify:

- Model picker appears in header next to tier switcher
- Haiku is selected by default (primary color)
- Opus shows amber background when selected
- Tooltips display correct metadata
- Verify a label with each model to confirm it works

- [ ] **Step 6: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address regression issues from model picker"
```
