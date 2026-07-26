# Dev-mode warning prompt + tier switcher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a confirmation prompt before dev mode turns on, and a dev-mode-only extraction-tier switcher (Local OCR / Local LLM / Cloud) with automatic cloud→local-ocr fallback on runtime failure, without changing any verdict/matching logic.

**Architecture:** `DevModeToggle` gains a small native-`<dialog>` confirmation before `setDevMode(true)` fires. A new `TierSwitcher` (mounted in the header, self-gating on `useDevMode()`) reads/writes a new `useDevTier()` hook (same `useSyncExternalStore` + localStorage pattern as `useDevMode`). `useVerify`/`useBatch` forward the chosen tier as a `devTier` form field on `/api/verify` POSTs; the route uses it to pick a provider directly when present, and wraps any cloud-tier extraction (explicit or auto-detected) in a new `withFallback` composition that retries `local-ocr` once on failure. A new `GET /api/verify` reports whether any cloud provider is configured, so the switcher can disable "Cloud" without ever exposing key material to the client.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Vitest + Testing Library, native `<dialog>` (no new dependency).

## Global Constraints

- **No verdict/matching changes.** `lib/matching/*` and `lib/ttb/*` are untouched; this plan only touches `lib/vision`, `hooks`, `components`, and `app/api/verify/route.ts`'s provider-selection branch. The eval harness output must be unaffected.
- **No new runtime dependencies.** The confirmation dialog uses the native `<dialog>` element.
- **Keyless by default; API keys are server-side only.** The client never sees which cloud provider is configured or any key — only a boolean (`cloudAvailable`).
- **Fail closed.** A failed/erroring `GET /api/verify` call is treated as `cloudAvailable: false`, never assumed available. An unrecognized `devTier` value is treated as absent (falls back to today's behavior), never a hard error.
- **Vocabulary:** verdicts `MATCH | MISMATCH | REVIEW`; overall `PASS | FAIL`; tiers `mock | local-ocr | local-llm | cloud` (this plan also fixes a pre-existing route.ts quirk where a `local-llm` provider was mis-tagged `"cloud"` in the response — see Task 4).
- **Sample images resolve to mock by default, unless `devTier` is explicitly set** — matching today's behavior (the `forced`/`VISION_PROVIDER` branch in `lib/vision/select.ts` already bypasses the mock-sample shortcut the same way; `devTier` follows that same precedent).

### Interfaces this plan produces, for reference across tasks

| Symbol                                                                                                          | File                              | Produced in |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------- |
| `type DevTier = "local-ocr" \| "local-llm" \| "cloud"`, `useDevTier(): DevTier`, `setDevTier(v: DevTier): void` | `hooks/use-dev-tier.ts`           | Task 1      |
| `withFallback(primary: VisionProvider, fallback: VisionProvider, onFallback?: () => void): VisionProvider`      | `lib/vision/fallback.ts`          | Task 2      |
| `selectCloudProvider(): VisionProvider \| null`                                                                 | `lib/vision/select.ts`            | Task 3      |
| `GET` (returns `{ cloudAvailable: boolean }`); POST now reads a `devTier` form field                            | `app/api/verify/route.ts`         | Task 4      |
| `<DevModeConfirm open onConfirm onCancel />`                                                                    | `components/dev-mode-confirm.tsx` | Task 5      |
| `<TierSwitcher />` (self-mounts only when `useDevMode()` is true)                                               | `components/tier-switcher.tsx`    | Task 6      |

---

### Task 1: `useDevTier` hook

**Files:**

- Create: `hooks/use-dev-tier.ts`
- Test: `hooks/use-dev-tier.test.ts`

**Interfaces:**

- Produces: `export type DevTier = "local-ocr" | "local-llm" | "cloud"`; `useDevTier(): DevTier`; `setDevTier(value: DevTier): void`. Storage key `"devTier"`. Default (nothing stored, or a malformed value stored) is `"cloud"`.

- [ ] **Step 1: Write the failing test**

```ts
// hooks/use-dev-tier.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useDevTier, setDevTier } from "@/hooks/use-dev-tier";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("useDevTier", () => {
  it("defaults to 'cloud' when nothing is stored", () => {
    const { result } = renderHook(() => useDevTier());
    expect(result.current).toBe("cloud");
  });

  it("reflects a stored valid value on mount", () => {
    localStorage.setItem("devTier", "local-ocr");
    const { result } = renderHook(() => useDevTier());
    expect(result.current).toBe("local-ocr");
  });

  it("falls back to 'cloud' for a malformed stored value", () => {
    localStorage.setItem("devTier", "not-a-real-tier");
    const { result } = renderHook(() => useDevTier());
    expect(result.current).toBe("cloud");
  });

  it("updates every subscribed hook instance when setDevTier is called", () => {
    const a = renderHook(() => useDevTier());
    const b = renderHook(() => useDevTier());
    act(() => setDevTier("local-llm"));
    expect(a.result.current).toBe("local-llm");
    expect(b.result.current).toBe("local-llm");
    expect(localStorage.getItem("devTier")).toBe("local-llm");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test hooks/use-dev-tier.test.ts`
Expected: FAIL — cannot resolve `@/hooks/use-dev-tier`.

- [ ] **Step 3: Write the implementation**

```ts
// hooks/use-dev-tier.ts
"use client";
import { useSyncExternalStore } from "react";

export type DevTier = "local-ocr" | "local-llm" | "cloud";

const STORAGE_KEY = "devTier";
const VALID_TIERS: readonly DevTier[] = ["local-ocr", "local-llm", "cloud"];
type Listener = () => void;
const listeners = new Set<Listener>();

function isDevTier(value: string | null): value is DevTier {
  return value !== null && (VALID_TIERS as readonly string[]).includes(value);
}

function getSnapshot(): DevTier {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isDevTier(stored) ? stored : "cloud";
}

function getServerSnapshot(): DevTier {
  return "cloud";
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Persists the choice and notifies every mounted useDevTier() subscriber in this tab — mirrors
// hooks/use-dev-mode.ts's pattern (localStorage's own "storage" event only fires in OTHER tabs).
export function setDevTier(value: DevTier): void {
  localStorage.setItem(STORAGE_KEY, value);
  listeners.forEach((listener) => listener());
}

export function useDevTier(): DevTier {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test hooks/use-dev-tier.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add hooks/use-dev-tier.ts hooks/use-dev-tier.test.ts
git commit -m "Add useDevTier hook (local-ocr/local-llm/cloud, localStorage-backed)"
```

---

### Task 2: `withFallback` provider composition

**Files:**

- Create: `lib/vision/fallback.ts`
- Test: `lib/vision/fallback.test.ts`

**Interfaces:**

- Consumes: `VisionProvider` from `@/lib/vision/types`.
- Produces: `withFallback(primary: VisionProvider, fallback: VisionProvider, onFallback?: () => void): VisionProvider`. The returned provider's `name` is `primary`'s. `onFallback` fires exactly once if and only if `primary.extract()` rejects and `fallback.extract()` is attempted — Task 4 uses it to know a fallback occurred (to append a response warning) without `withFallback` itself needing to expose that as part of its return value.

- [ ] **Step 1: Write the failing test**

```ts
// lib/vision/fallback.test.ts
import { describe, expect, it, vi } from "vitest";
import { withFallback } from "@/lib/vision/fallback";
import type { VisionProvider } from "@/lib/vision/types";
import type { ExtractedLabel } from "@/lib/schema";

const IMAGE = Buffer.from([1, 2, 3]);
const META = { filename: "x.png", mimeType: "image/png" };
const RESULT = {} as ExtractedLabel;

function stubProvider(name: string, behavior: () => Promise<ExtractedLabel>): VisionProvider {
  return { name, extract: vi.fn(behavior) };
}

describe("withFallback", () => {
  it("returns the primary's result and never calls fallback when primary succeeds", async () => {
    const primary = stubProvider("cloud", async () => RESULT);
    const fallback = stubProvider("local-ocr", async () => RESULT);
    const composed = withFallback(primary, fallback);
    const result = await composed.extract(IMAGE, META);
    expect(result).toBe(RESULT);
    expect(fallback.extract).not.toHaveBeenCalled();
  });

  it("calls fallback and returns its result when primary rejects", async () => {
    const primary = stubProvider("cloud", async () => {
      throw new Error("cloud down");
    });
    const fallback = stubProvider("local-ocr", async () => RESULT);
    const composed = withFallback(primary, fallback);
    const result = await composed.extract(IMAGE, META);
    expect(result).toBe(RESULT);
    expect(fallback.extract).toHaveBeenCalledTimes(1);
  });

  it("propagates fallback's rejection when both primary and fallback fail", async () => {
    const primary = stubProvider("cloud", async () => {
      throw new Error("cloud down");
    });
    const fallback = stubProvider("local-ocr", async () => {
      throw new Error("local-ocr down too");
    });
    const composed = withFallback(primary, fallback);
    await expect(composed.extract(IMAGE, META)).rejects.toThrow("local-ocr down too");
  });

  it("exposes primary's name, not fallback's", () => {
    const primary = stubProvider("cloud", async () => RESULT);
    const fallback = stubProvider("local-ocr", async () => RESULT);
    expect(withFallback(primary, fallback).name).toBe("cloud");
  });

  it("calls onFallback exactly once when the fallback path is taken", async () => {
    const primary = stubProvider("cloud", async () => {
      throw new Error("cloud down");
    });
    const fallback = stubProvider("local-ocr", async () => RESULT);
    const onFallback = vi.fn();
    const composed = withFallback(primary, fallback, onFallback);
    await composed.extract(IMAGE, META);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("never calls onFallback when primary succeeds", async () => {
    const primary = stubProvider("cloud", async () => RESULT);
    const fallback = stubProvider("local-ocr", async () => RESULT);
    const onFallback = vi.fn();
    const composed = withFallback(primary, fallback, onFallback);
    await composed.extract(IMAGE, META);
    expect(onFallback).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/vision/fallback.test.ts`
Expected: FAIL — cannot resolve `@/lib/vision/fallback`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/vision/fallback.ts
import type { VisionProvider } from "@/lib/vision/types";

/**
 * Composes two providers into one: try `primary`, and if its extract() rejects, retry once with
 * `fallback`. The returned provider's `name` is `primary`'s. `onFallback`, if given, fires exactly
 * once whenever the fallback path is taken — callers use it to signal that a fallback occurred
 * (e.g. adding a warning to the response) without withFallback itself needing to carry that state.
 */
export function withFallback(
  primary: VisionProvider,
  fallback: VisionProvider,
  onFallback?: () => void,
): VisionProvider {
  return {
    name: primary.name,
    async extract(image, meta) {
      try {
        return await primary.extract(image, meta);
      } catch {
        onFallback?.();
        return await fallback.extract(image, meta);
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/vision/fallback.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/vision/fallback.ts lib/vision/fallback.test.ts
git commit -m "Add withFallback: retries a failed provider once with a fallback provider"
```

---

### Task 3: `selectCloudProvider` in `lib/vision/select.ts`

**Files:**

- Modify: `lib/vision/select.ts`
- Modify: `lib/vision/select.test.ts`

**Interfaces:**

- Produces: `selectCloudProvider(): VisionProvider | null` — the single source of truth for "which cloud provider, if any, is configured," same priority order (`GEMINI_API_KEY` > `ANTHROPIC_API_KEY` > `OPENAI_API_KEY` > `GROQ_API_KEY` > `AWS_BEARER_TOKEN_BEDROCK`) `selectProvider` already used. `selectProvider`'s own behavior is unchanged — this step only factors its existing cloud-detection logic out into a reusable, independently-testable function.

- [ ] **Step 1: Write the failing test**

Add to `lib/vision/select.test.ts` (update the import line to include `selectCloudProvider`):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectProvider, providerByName, selectCloudProvider } from "@/lib/vision/select";
```

Add a new `describe` block at the end of the file:

```ts
describe("selectCloudProvider", () => {
  it("returns null when no cloud key is configured", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    expect(selectCloudProvider()).toBeNull();
  });
  it("returns the configured provider honoring the same priority order as selectProvider", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    expect(selectCloudProvider()?.name).toBe("claude");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/vision/select.test.ts`
Expected: FAIL — `selectCloudProvider` is not exported.

- [ ] **Step 3: Refactor `lib/vision/select.ts`**

Replace the file's `selectProvider` export and add `selectCloudProvider` above it:

```ts
/**
 * The single source of truth for "which cloud provider, if any, is configured" — same priority
 * order selectProvider has always used. Exported so the /api/verify route can offer an explicit
 * "cloud" tier choice (the dev-mode tier switcher) and report cloud availability (GET /api/verify)
 * without duplicating this env-var check.
 */
export function selectCloudProvider(): VisionProvider | null {
  if (process.env.GEMINI_API_KEY) return geminiProvider;
  if (process.env.ANTHROPIC_API_KEY) return claudeProvider;
  if (process.env.OPENAI_API_KEY) return openaiProvider;
  if (process.env.GROQ_API_KEY) return groqProvider;
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return bedrockProvider;
  return null;
}

/**
 * Keyless by default. Bundled sample filenames ALWAYS use mock — even when a cloud key is set —
 * so the demo stays deterministic (deliberate deviation recorded in spec §3). Otherwise:
 * key present -> that cloud provider; no key -> local-ocr.
 *
 * SECURITY (address in Task 12 — the /api/verify route): tier selection here trusts `filename`,
 * which is user-controlled on uploads. An upload named e.g. "old-tom-clean.png" would be routed to
 * the mock tier and return fixture data for a DIFFERENT label. The route must pass a trusted signal
 * (an explicit "this is a bundled gallery sample" flag / sample id) rather than let an uploaded
 * filename reach `isMockSample`. Narrowing the fixture set alone does not close this — the name is
 * still spoofable.
 */
export function selectProvider(filename?: string): VisionProvider {
  const forced = process.env.VISION_PROVIDER;
  if (forced) {
    // The mock tier returns fabricated fixture data keyed off the (client-controlled) filename. It is a
    // demo/CI/eval affordance only — never let it be forced in a production deploy, where it would turn
    // any upload named after a fixture into a bogus PASS. Fail closed instead.
    if (forced === "mock" && process.env.NODE_ENV === "production") {
      throw new Error(
        "VISION_PROVIDER=mock is not allowed in production — the mock tier returns fabricated fixture data.",
      );
    }
    return providerByName(forced);
  }
  if (filename && isMockSample(filename)) return mockProvider;
  return selectCloudProvider() ?? localOcrProvider;
}
```

(Only these two functions change — `PROVIDERS`, `providerByName`, and every import at the top of the file stay exactly as they are.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test lib/vision/select.test.ts`
Expected: PASS (all existing `selectProvider` tests plus the 2 new `selectCloudProvider` tests, 11 total). The existing tests must pass unchanged — this is a pure refactor, not a behavior change.

- [ ] **Step 5: Commit**

```bash
git add lib/vision/select.ts lib/vision/select.test.ts
git commit -m "Extract selectCloudProvider from selectProvider (no behavior change)"
```

---

### Task 4: Server — `devTier`-aware routing, `GET /api/verify`, and cloud fallback

**Files:**

- Modify: `app/api/verify/route.ts`
- Modify: `app/api/verify/route.test.ts`

**Interfaces:**

- Consumes: `selectCloudProvider`, `providerByName` (Task 3, existing), `withFallback` (Task 2).
- Produces: `GET` handler returning `{ cloudAvailable: boolean }`. `POST` now reads an optional `devTier` form field (`"local-ocr" | "local-llm" | "cloud"`); any other value (missing, malformed) is treated as absent and falls through to today's `selectProvider(sampleName)` auto-detection unchanged.

- [ ] **Step 1: Write the failing tests**

In `app/api/verify/route.test.ts`, change the import line to include `GET`:

```ts
import { GET, POST } from "@/app/api/verify/route";
```

Add `MOCK_FIXTURES` to the imports (a fixture already shaped as a valid `ExtractedLabel`, reused below to build realistic cloud/local-llm responses):

```ts
import { MOCK_FIXTURES } from "@/lib/vision/mock";
```

Extend the `request()` helper's `overrides` type and body to support a `devTier` field — replace the whole function with:

```ts
function request(
  overrides: {
    filename?: string;
    type?: string;
    size?: number;
    application?: string;
    magic?: number[];
    source?: string;
    bytes?: Uint8Array;
    devTier?: string;
  } = {},
) {
  const fd = new FormData();
  let bytes = overrides.bytes;
  if (!bytes) {
    bytes = new Uint8Array(overrides.size ?? 64);
    bytes.set(overrides.magic ?? PNG_MAGIC, 0);
  }
  fd.set(
    "image",
    new File([new Uint8Array(bytes)], overrides.filename ?? "old-tom-clean.png", {
      type: overrides.type ?? "image/png",
    }),
  );
  fd.set("application", overrides.application ?? JSON.stringify(app));
  if (overrides.source !== undefined) fd.set("source", overrides.source);
  if (overrides.devTier !== undefined) fd.set("devTier", overrides.devTier);

  // Node.js new Request() with FormData doesn't set Content-Length in the test environment.
  // Provide an approximate value so the route's Content-Length precheck works — this mirrors
  // what the real HTTP layer does in production.
  const contentLength = String(bytes.length + 1024);
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? contentLength : null) },
    formData: async () => fd,
  } as unknown as Request;
}
```

Add these tests at the end of the `describe("POST /api/verify", ...)` block, before its closing `});`:

```ts
it("devTier=local-ocr bypasses auto-detection even when a cloud key is configured", async () => {
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } });
  const res = await POST(request({ bytes: OLD_TOM, devTier: "local-ocr" }));
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.tier).toBe("local-ocr");
  expect(body.provider).toBe("local-ocr");
});

it("devTier=local-llm bypasses auto-detection and routes to Ollama", async () => {
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ message: { content: JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]) } }),
  });
  vi.stubGlobal("fetch", fetchMock);
  const res = await POST(request({ bytes: OLD_TOM, devTier: "local-llm" }));
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.tier).toBe("local-llm");
  expect(body.provider).toBe("local-llm");
});

it("devTier=local-llm returns a clear error naming Ollama when the call fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
  const res = await POST(request({ bytes: OLD_TOM, devTier: "local-llm" }));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toMatch(/ollama/i);
});

it("devTier=cloud with a key configured uses the cloud provider", async () => {
  // Bedrock, not Gemini/Groq: it's a plain fetch() call with no SDK in front of it (gemini.ts
  // uses @google/generative-ai, groq.ts uses the openai SDK, both of which can retry/reshape a
  // rejection internally) — a raw-fetch provider keeps this test's mock predictable.
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GROQ_API_KEY", "");
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
  const text = JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ output: { message: { content: [{ text }] } } }),
      text: async () => "",
    }),
  );
  const res = await POST(request({ bytes: OLD_TOM, devTier: "cloud" }));
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.tier).toBe("cloud");
  expect(body.provider).toBe("bedrock");
});

it("devTier=cloud with nothing configured returns a clear 400", async () => {
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GROQ_API_KEY", "");
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
  const res = await POST(request({ bytes: OLD_TOM, devTier: "cloud" }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/cloud tier requires an api key/i);
});

it("falls back to local-ocr and adds a warning when the cloud call fails", async () => {
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GROQ_API_KEY", "");
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
  mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("cloud down")));
  const res = await POST(request({ bytes: OLD_TOM, devTier: "cloud" }));
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.provider).toBe("bedrock");
  expect(body.tier).toBe("cloud");
  expect(body.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/fell back to local ocr/i)]));
});

it("an invalid devTier value is ignored and falls back to normal auto-detection", async () => {
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GROQ_API_KEY", "");
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
  mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } });
  const res = await POST(request({ bytes: OLD_TOM, devTier: "not-a-real-tier" }));
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.tier).toBe("local-ocr");
});
```

Add a new top-level `describe` block after `describe("POST /api/verify", ...)`'s closing `});`:

```ts
describe("GET /api/verify", () => {
  it("returns cloudAvailable: true when a cloud key is configured", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const res = await GET();
    expect((await res.json()).cloudAvailable).toBe(true);
  });

  it("returns cloudAvailable: false when no cloud key is configured", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    const res = await GET();
    expect((await res.json()).cloudAvailable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test app/api/verify/route.test.ts`
Expected: FAIL — `GET` is not exported, and `devTier` is not read by `POST` (auto-detection ignores it, so `devTier=local-ocr`/`local-llm`/`cloud`-specific assertions fail; the fallback-warning and 400-on-unconfigured-cloud assertions fail too).

- [ ] **Step 3: Rewrite `app/api/verify/route.ts`**

```ts
import { NextResponse } from "next/server";
import sharp from "sharp";
import { ApplicationDataSchema, ExtractedLabelSchema } from "@/lib/schema";
import { selectProvider, selectCloudProvider, providerByName } from "@/lib/vision/select";
import { withFallback } from "@/lib/vision/fallback";
import { isGenuineSample } from "@/lib/vision/sample-hashes";
import { verifyLabel } from "@/lib/matching/verify";
import type { VisionProvider } from "@/lib/vision/types";

export const runtime = "nodejs";

const MAX_BYTES = 8 * 1024 * 1024;
// Cap the whole request from its declared Content-Length before req.formData() buffers it. Vercel's
// ~4.5 MB platform cap fires first in production, but off-Vercel (self-hosted / pnpm dev) nothing bounds
// the body — so reject early rather than buffer a huge multipart payload into memory. Headroom over
// MAX_BYTES covers the application JSON field and multipart boundaries.
const MAX_REQUEST_BYTES = MAX_BYTES + 1024 * 1024;
// Bound the DECODED raster, not just the compressed bytes: a ~1 MB uniform PNG can declare a
// multi-gigabyte raster (decompression bomb) that OOM-kills the instance or pegs the shared OCR worker.
// 25 MP comfortably covers a 300-dpi US-letter scan (~8.4 MP); anything larger is rejected before any tier.
const MAX_PIXELS = 25_000_000;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const EXTRACT_TIMEOUT_MS = 8_000; // hard deadline (threat model LLM10); under Vercel Hobby's ~10 s cap
const DEV_TIERS = new Set(["local-ocr", "local-llm", "cloud"]);

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  // clearTimeout in finally so a fast success/failure doesn't leave the deadline timer holding the event
  // loop open (matters on serverless, where a dangling timer can delay/complicate teardown).
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Magic-byte sniff (threat model A05): declared MIME must match actual content. */
function sniffMime(b: Buffer): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  return null;
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** mock/local-ocr/local-llm report their own name as the tier; every other provider is "cloud". */
function tierFor(providerName: string): string {
  if (providerName === "mock" || providerName === "local-ocr" || providerName === "local-llm") return providerName;
  return "cloud";
}

/** Lets the dev-mode tier switcher know whether "Cloud" is actually usable, without exposing which provider or any key material. */
export async function GET() {
  return NextResponse.json({ cloudAvailable: selectCloudProvider() !== null });
}

export async function POST(req: Request) {
  const rawLength = req.headers.get("content-length");
  if (rawLength === null) {
    // Missing Content-Length: a client using chunked encoding can send an arbitrarily large body
    // that bypasses the pre-check. Reject in production; allow in dev/test for tooling convenience.
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "Request too large — the image must be at most 8 MB." }, { status: 413 });
    }
  } else {
    const declaredLength = Number(rawLength);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: "Request too large — the image must be at most 8 MB." }, { status: 413 });
    }
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("Expected multipart form data with an image and application fields.");
  }

  const image = form.get("image");
  const appRaw = form.get("application");
  if (!(image instanceof File) || typeof appRaw !== "string") {
    return bad("Missing the label image or the application data.");
  }
  if (!ALLOWED_TYPES.has(image.type)) {
    return bad("Unsupported image type — please upload a PNG, JPEG, or WebP.");
  }
  if (image.size === 0 || image.size > MAX_BYTES) {
    return bad("Image must be non-empty and at most 8 MB.");
  }

  let appJson: unknown;
  try {
    appJson = JSON.parse(appRaw);
  } catch {
    return bad("Application data is not valid JSON.");
  }
  const parsed = ApplicationDataSchema.safeParse(appJson);
  if (!parsed.success) {
    return bad(`Application data is incomplete: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }

  const buffer = Buffer.from(await image.arrayBuffer());
  if (sniffMime(buffer) !== image.type) {
    return bad("The file's content does not match its declared image type — upload a real PNG, JPEG, or WebP.");
  }

  // Decompression-bomb guard (threat model DoS): read the header only (no full decode) and reject before
  // any tier touches the raster. metadata() parses dimensions without allocating width×height×channels.
  let width = 0;
  let height = 0;
  try {
    ({ width = 0, height = 0 } = await sharp(buffer).metadata());
  } catch {
    return bad("Could not read this image — please upload a valid PNG, JPEG, or WebP.");
  }
  const pixels = width * height;
  if (pixels <= 0 || pixels > MAX_PIXELS) {
    return bad(
      `This image is too large to process — its dimensions exceed ${MAX_PIXELS / 1_000_000} megapixels. Downscale it and try again.`,
    );
  }

  // Trusted-sample gate (security sweep): the mock tier may be reached ONLY when the client says
  // source=sample AND the uploaded bytes ARE a genuine bundled sample (content hash). `source` and the
  // filename are both client-controlled, so checking them alone let a caller force a fabricated mock
  // PASS for arbitrary artwork; the byte-hash makes that impossible — a spoofed upload hashes to
  // nothing known and falls through to real extraction (local-ocr / cloud), never mock.
  const sampleName = form.get("source") === "sample" && isGenuineSample(image.name, buffer) ? image.name : undefined;
  const devTierRaw = form.get("devTier");
  const devTier = typeof devTierRaw === "string" && DEV_TIERS.has(devTierRaw) ? devTierRaw : undefined;

  const started = Date.now();
  let provider: VisionProvider | undefined;
  let fellBackToLocalOcr = false;
  try {
    if (devTier === "local-ocr") {
      provider = providerByName("local-ocr");
    } else if (devTier === "local-llm") {
      provider = providerByName("local-llm");
    } else if (devTier === "cloud") {
      const cloud = selectCloudProvider();
      if (!cloud) {
        return NextResponse.json(
          { error: "Cloud tier requires an API key configured on the server." },
          { status: 400 },
        );
      }
      provider = withFallback(cloud, providerByName("local-ocr"), () => {
        fellBackToLocalOcr = true;
      });
    } else {
      // Provider selection can throw (e.g. VISION_PROVIDER=mock in production) — keep it inside the try so
      // a misconfiguration fails closed with a friendly 5xx, never a raw 500 or a fabricated verdict.
      provider = selectProvider(sampleName);
      if (tierFor(provider.name) === "cloud") {
        provider = withFallback(provider, providerByName("local-ocr"), () => {
          fellBackToLocalOcr = true;
        });
      }
    }

    const tier = tierFor(provider.name);
    // Every tier's output crosses one validated boundary here (architecture rule 2).
    const extracted = ExtractedLabelSchema.parse(
      await withTimeout(provider.extract(buffer, { filename: image.name, mimeType: image.type }), EXTRACT_TIMEOUT_MS),
    );
    const result = verifyLabel(parsed.data, extracted);
    if (provider.name === "local-ocr" && !fellBackToLocalOcr) {
      result.warnings.push(
        "Extracted with local OCR (no cloud model) — lower accuracy; low-confidence fields are flagged for review.",
      );
    }
    if (fellBackToLocalOcr) {
      result.warnings.push("Cloud extraction failed — fell back to local OCR.");
    }
    return NextResponse.json({
      ...result,
      processingMs: Date.now() - started,
      tier,
      provider: provider.name,
      beverageType: parsed.data.beverageType,
    });
  } catch (e) {
    if (e instanceof TimeoutError) {
      return NextResponse.json(
        { error: "Verification took too long — try a smaller or clearer image, or try again." },
        { status: 504 },
      );
    }
    if ((e as { status?: number }).status === 429) {
      return NextResponse.json(
        { error: "The extraction service is rate-limited right now — try again in a few seconds." },
        { status: 429 },
      );
    }
    if (provider?.name === "local-llm") {
      console.error("local-llm verify failed:", e instanceof Error ? e.message : e);
      return NextResponse.json(
        { error: "Local LLM extraction failed — is Ollama running and reachable?" },
        { status: 502 },
      );
    }
    console.error("verify failed:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: "Could not analyze this label image. Try a clearer image, or try again in a moment." },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test app/api/verify/route.test.ts`
Expected: PASS (all existing tests plus the 9 new ones — 2 GET, 7 POST devTier cases).

- [ ] **Step 5: Commit**

```bash
git add app/api/verify/route.ts app/api/verify/route.test.ts
git commit -m "Add devTier-aware provider selection, GET cloudAvailable, and cloud fallback to /api/verify"
```

---

### Task 5: `DevModeConfirm` dialog + wire into `DevModeToggle`

**Files:**

- Create: `components/dev-mode-confirm.tsx`
- Test: `components/dev-mode-confirm.test.tsx`
- Modify: `components/dev-mode-toggle.tsx`
- Modify: `components/dev-mode-toggle.test.tsx`

**Interfaces:**

- Produces: `<DevModeConfirm open={boolean} onConfirm={() => void} onCancel={() => void} />`. Renders nothing (`null`) when `open` is `false`.

- [ ] **Step 1: Write the failing test for the dialog**

```tsx
// components/dev-mode-confirm.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DevModeConfirm } from "@/components/dev-mode-confirm";

afterEach(cleanup);

describe("DevModeConfirm", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<DevModeConfirm open={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the confirmation copy when open", () => {
    render(<DevModeConfirm open={true} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Enable dev mode?")).toBeInTheDocument();
  });

  it("calls onConfirm when Enable is clicked", () => {
    const onConfirm = vi.fn();
    render(<DevModeConfirm open={true} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = vi.fn();
    render(<DevModeConfirm open={true} onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the dialog's native cancel event fires (Escape key)", () => {
    const onCancel = vi.fn();
    const { container } = render(<DevModeConfirm open={true} onConfirm={vi.fn()} onCancel={onCancel} />);
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test components/dev-mode-confirm.test.tsx`
Expected: FAIL — cannot resolve `@/components/dev-mode-confirm`.

- [ ] **Step 3: Write the implementation**

```tsx
// components/dev-mode-confirm.tsx
"use client";
import { useEffect, useRef } from "react";

export function DevModeConfirm({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // The <dialog> element mounts fresh each time `open` becomes true (see the `if (!open) return
  // null` below), so a plain mount effect is enough to show it as a real native modal (backdrop,
  // focus trap, Escape-to-cancel) — no imperative open/close toggling to keep in sync.
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault(); // stay controlled: onCancel (not the browser) decides what happens next
        onCancel();
      }}
      className="rounded-xl border border-border bg-card p-0 text-foreground shadow-lg backdrop:bg-black/40"
    >
      <div className="max-w-sm p-5">
        <p className="text-base font-semibold text-foreground">Enable dev mode?</p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Dev mode reveals technical debugging tools, like a character-by-character comparison of extracted label text.
          It&apos;s meant for testing, not everyday review.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Enable
          </button>
        </div>
      </div>
    </dialog>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test components/dev-mode-confirm.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing tests for `DevModeToggle`'s new gating**

Replace `components/dev-mode-toggle.test.tsx` entirely:

```tsx
// components/dev-mode-toggle.test.tsx
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DevModeToggle } from "@/components/dev-mode-toggle";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("DevModeToggle", () => {
  it("defaults to off", () => {
    render(<DevModeToggle />);
    expect(screen.getByRole("switch", { name: "Dev mode" })).toHaveAttribute("aria-checked", "false");
  });

  it("clicking while off opens the confirmation dialog without enabling yet", () => {
    render(<DevModeToggle />);
    fireEvent.click(screen.getByRole("switch", { name: "Dev mode" }));
    expect(screen.getByText("Enable dev mode?")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Dev mode" })).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("devMode")).toBeNull();
  });

  it("confirming the dialog turns it on and persists the choice", () => {
    render(<DevModeToggle />);
    fireEvent.click(screen.getByRole("switch", { name: "Dev mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(screen.getByRole("switch", { name: "Dev mode" })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("devMode")).toBe("true");
  });

  it("cancelling the dialog leaves it off", () => {
    render(<DevModeToggle />);
    fireEvent.click(screen.getByRole("switch", { name: "Dev mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("switch", { name: "Dev mode" })).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("devMode")).toBeNull();
  });

  it("clicking while on turns it off immediately, no confirmation needed", () => {
    localStorage.setItem("devMode", "true");
    render(<DevModeToggle />);
    fireEvent.click(screen.getByRole("switch", { name: "Dev mode" }));
    expect(screen.getByRole("switch", { name: "Dev mode" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("Enable dev mode?")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm test components/dev-mode-toggle.test.tsx`
Expected: FAIL — a single click while off still flips `aria-checked` to `"true"` immediately (no confirmation gate exists yet).

- [ ] **Step 7: Rewrite `components/dev-mode-toggle.tsx`**

```tsx
"use client";
import { useState } from "react";
import { useDevMode, setDevMode } from "@/hooks/use-dev-mode";
import { DevModeConfirm } from "@/components/dev-mode-confirm";

export function DevModeToggle() {
  const enabled = useDevMode();
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Dev mode"
        title="Dev mode: technical debugging tools for testing"
        onClick={() => (enabled ? setDevMode(false) : setConfirming(true))}
        className={`rounded-md px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
          enabled
            ? "bg-white/20 text-primary-foreground"
            : "text-primary-foreground/60 hover:bg-white/10 hover:text-primary-foreground/90"
        }`}
      >
        Dev
      </button>
      <DevModeConfirm
        open={confirming}
        onConfirm={() => {
          setDevMode(true);
          setConfirming(false);
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test components/dev-mode-toggle.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 9: Commit**

```bash
git add components/dev-mode-confirm.tsx components/dev-mode-confirm.test.tsx components/dev-mode-toggle.tsx components/dev-mode-toggle.test.tsx
git commit -m "Require confirmation before dev mode turns on"
```

---

### Task 6: `TierSwitcher` component

**Files:**

- Create: `components/tier-switcher.tsx`
- Test: `components/tier-switcher.test.tsx`

**Interfaces:**

- Consumes: `useDevMode` (existing), `useDevTier`/`setDevTier`/`DevTier` (Task 1), `GET /api/verify` (Task 4, via `fetch`).
- Produces: `<TierSwitcher />` — no props. Renders `null` when `useDevMode()` is `false`. When dev mode is on, renders a `role="radiogroup"` of three `role="radio"` buttons ("Local OCR", "Local LLM", "Cloud"); "Cloud" is `aria-disabled` (with a `title` reason) until a `GET /api/verify` call resolves `{ cloudAvailable: true }`.

- [ ] **Step 1: Write the failing test**

```tsx
// components/tier-switcher.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TierSwitcher } from "@/components/tier-switcher";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("devMode", "true");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(cloudAvailable: boolean) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cloudAvailable }) }));
}

describe("TierSwitcher", () => {
  it("renders nothing when dev mode is off", () => {
    localStorage.setItem("devMode", "false");
    stubFetch(true);
    const { container } = render(<TierSwitcher />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders all three tier options when dev mode is on", () => {
    stubFetch(true);
    render(<TierSwitcher />);
    expect(screen.getByRole("radio", { name: "Local OCR" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Local LLM" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Cloud" })).toBeInTheDocument();
  });

  it("defaults to Cloud selected", () => {
    stubFetch(true);
    render(<TierSwitcher />);
    expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-checked", "true");
  });

  it("enables Cloud once the server reports it's available", async () => {
    stubFetch(true);
    render(<TierSwitcher />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Cloud" })).not.toHaveAttribute("aria-disabled"));
  });

  it("disables Cloud when the server reports no cloud key is configured", async () => {
    stubFetch(false);
    render(<TierSwitcher />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-disabled", "true"));
  });

  it("disables Cloud when the availability fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<TierSwitcher />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-disabled", "true"));
  });

  it("selecting Local OCR persists the choice", () => {
    stubFetch(true);
    render(<TierSwitcher />);
    fireEvent.click(screen.getByRole("radio", { name: "Local OCR" }));
    expect(screen.getByRole("radio", { name: "Local OCR" })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("devTier")).toBe("local-ocr");
  });

  it("clicking Cloud while disabled does not select it", async () => {
    stubFetch(false);
    render(<TierSwitcher />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(screen.getByRole("radio", { name: "Cloud" }));
    expect(localStorage.getItem("devTier")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test components/tier-switcher.test.tsx`
Expected: FAIL — cannot resolve `@/components/tier-switcher`.

- [ ] **Step 3: Write the implementation**

```tsx
// components/tier-switcher.tsx
"use client";
import { useEffect, useState } from "react";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useDevTier, setDevTier, type DevTier } from "@/hooks/use-dev-tier";

const OPTIONS: { value: DevTier; label: string }[] = [
  { value: "local-ocr", label: "Local OCR" },
  { value: "local-llm", label: "Local LLM" },
  { value: "cloud", label: "Cloud" },
];

export function TierSwitcher() {
  const devMode = useDevMode();
  const tier = useDevTier();
  // Fail closed: Cloud starts (and stays, on any error) disabled until the server explicitly
  // confirms a key is configured — never assume it's available.
  const [cloudAvailable, setCloudAvailable] = useState(false);

  useEffect(() => {
    if (!devMode) return;
    let cancelled = false;
    fetch("/api/verify")
      .then((res) => (res.ok ? res.json() : { cloudAvailable: false }))
      .then((body: { cloudAvailable?: boolean }) => {
        if (!cancelled) setCloudAvailable(body.cloudAvailable === true);
      })
      .catch(() => {
        if (!cancelled) setCloudAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [devMode]);

  if (!devMode) return null;

  return (
    <div
      role="radiogroup"
      aria-label="Extraction tier"
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1"
    >
      {OPTIONS.map(({ value, label }) => {
        const disabled = value === "cloud" && !cloudAvailable;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={tier === value}
            aria-disabled={disabled || undefined}
            title={disabled ? "No cloud API key configured on the server" : undefined}
            onClick={() => {
              if (disabled) return;
              setDevTier(value);
            }}
            className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${
              tier === value
                ? "bg-primary text-primary-foreground"
                : disabled
                  ? "cursor-not-allowed text-muted-foreground/40"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test components/tier-switcher.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add components/tier-switcher.tsx components/tier-switcher.test.tsx
git commit -m "Add TierSwitcher: dev-mode-only Local OCR / Local LLM / Cloud picker"
```

---

### Task 7: Mount `TierSwitcher` in the header

**Files:**

- Modify: `app/layout.tsx`
- Modify: `app/layout.test.tsx`

**Interfaces:**

- Consumes: `<TierSwitcher />` (Task 6).

- [ ] **Step 1: Write the failing test**

In `app/layout.test.tsx`, extend the shared `afterEach` (it currently only does `vi.unstubAllGlobals(); vi.restoreAllMocks();`) to also clear `localStorage`, so this new test's `devMode` flag never leaks into the other tests in the file:

```tsx
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});
```

Add a new test inside `describe("RootLayout", ...)`, after the `"mounts ThemeToggle"` test:

```tsx
it("mounts TierSwitcher when dev mode is already on", () => {
  localStorage.setItem("devMode", "true");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cloudAvailable: true }) }));
  render(<RootLayout>content</RootLayout>);
  expect(screen.getByRole("radiogroup", { name: "Extraction tier" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test app/layout.test.tsx`
Expected: FAIL — no element with role `radiogroup` named "Extraction tier" exists yet.

- [ ] **Step 3: Wire `TierSwitcher` into `app/layout.tsx`**

Add the import alongside the existing component imports:

```tsx
import { TierSwitcher } from "@/components/tier-switcher";
```

Change the toggle wrapper span in the nav from:

```tsx
<span className="ml-1 flex items-center gap-2 border-l border-white/20 pl-2">
  <DevModeToggle />
  <ThemeToggle />
</span>
```

to:

```tsx
<span className="ml-1 flex items-center gap-2 border-l border-white/20 pl-2">
  <DevModeToggle />
  <TierSwitcher />
  <ThemeToggle />
</span>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test app/layout.test.tsx`
Expected: PASS (all existing tests plus the 1 new one, 9 total).

- [ ] **Step 5: Commit**

```bash
git add app/layout.tsx app/layout.test.tsx
git commit -m "Mount TierSwitcher in the header next to the dev-mode toggle"
```

---

### Task 8: `useVerify` sends `devTier`

**Files:**

- Modify: `hooks/use-verify.ts`
- Modify: `hooks/use-verify.test.ts`

**Interfaces:**

- Consumes: `useDevMode` (existing), `useDevTier` (Task 1).

- [ ] **Step 1: Write the failing tests**

In `hooks/use-verify.test.ts`, add a `beforeEach` import and call (the file currently has no `beforeEach` — add the import to the existing `vitest` import line and add the hook):

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVerify } from "@/hooks/use-verify";
import type { ApplicationData } from "@/lib/schema";
```

```ts
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
```

Add two tests at the end of the `describe("useVerify", ...)` block:

```ts
it("does not include devTier when dev mode is off", async () => {
  const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({ overall: "PASS", fields: [], warnings: [], processingMs: 5, tier: "mock", provider: "mock" }),
  } as Response);
  const { result } = renderHook(() => useVerify());
  await act(async () => {
    await result.current.verify(app, file);
  });
  const [, init] = fetchSpy.mock.calls[0];
  const fd = init?.body as FormData;
  expect(fd.get("devTier")).toBeNull();
});

it("includes devTier when dev mode is on", async () => {
  localStorage.setItem("devMode", "true");
  localStorage.setItem("devTier", "local-ocr");
  const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      overall: "PASS",
      fields: [],
      warnings: [],
      processingMs: 5,
      tier: "local-ocr",
      provider: "local-ocr",
    }),
  } as Response);
  const { result } = renderHook(() => useVerify());
  await act(async () => {
    await result.current.verify(app, file);
  });
  const [, init] = fetchSpy.mock.calls[0];
  const fd = init?.body as FormData;
  expect(fd.get("devTier")).toBe("local-ocr");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test hooks/use-verify.test.ts`
Expected: FAIL — the second new test's `fd.get("devTier")` is `null` (the hook never reads dev mode/tier yet).

- [ ] **Step 3: Update `hooks/use-verify.ts`**

```ts
"use client";
import { useCallback, useState } from "react";
import type { ApplicationData, BeverageType, VerificationResult } from "@/lib/schema";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useDevTier } from "@/hooks/use-dev-tier";

export type VerifyResponse = VerificationResult & { tier: string; provider: string; beverageType: BeverageType };

interface State {
  loading: boolean;
  result: VerifyResponse | null;
  error: string | null;
}

export function useVerify() {
  const [state, setState] = useState<State>({ loading: false, result: null, error: null });
  const devMode = useDevMode();
  const devTier = useDevTier();
  const verify = useCallback(
    async (app: ApplicationData, file: File, source?: "sample" | "upload") => {
      setState({ loading: true, result: null, error: null });
      const fd = new FormData();
      fd.set("application", JSON.stringify(app));
      fd.set("image", file);
      if (source) fd.set("source", source);
      if (devMode) fd.set("devTier", devTier);
      try {
        const res = await fetch("/api/verify", { method: "POST", body: fd, signal: AbortSignal.timeout(30_000) });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Verification failed.");
        setState({ loading: false, result: body as VerifyResponse, error: null });
      } catch (e) {
        setState({ loading: false, result: null, error: e instanceof Error ? e.message : "Verification failed." });
      }
    },
    [devMode, devTier],
  );
  // Clear a prior verdict when the inputs change (image removed/replaced) so a stale PASS/FAIL is
  // never shown for an image that hasn't been verified.
  const reset = useCallback(() => setState({ loading: false, result: null, error: null }), []);
  return { ...state, verify, reset };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test hooks/use-verify.test.ts`
Expected: PASS (all existing tests plus the 2 new ones, 7 total).

- [ ] **Step 5: Commit**

```bash
git add hooks/use-verify.ts hooks/use-verify.test.ts
git commit -m "useVerify: forward devTier to /api/verify when dev mode is on"
```

---

### Task 9: `useBatch` sends `devTier`

**Files:**

- Modify: `hooks/use-batch.ts`
- Modify: `hooks/use-batch.test.ts`

**Interfaces:**

- Consumes: `useDevMode` (existing), `useDevTier`/`DevTier` (Task 1). `verifyOne` is a plain async function, not a hook, so it cannot call `useDevTier()`/`useDevMode()` itself — `useBatch()` (the hook) reads them once and passes the resolved tier into `verifyOne` as a parameter.

- [ ] **Step 1: Write the failing tests**

In `hooks/use-batch.test.ts`, add a `beforeEach` (the file currently has none — add the import and call):

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBatch } from "@/hooks/use-batch";
import type { BatchRow } from "@/lib/csv";
import type { VerifyResponse } from "@/hooks/use-verify";
```

```ts
beforeEach(() => localStorage.clear());
```

Add two tests at the end of the `describe("useBatch", ...)` block:

```ts
it("does not include devTier when dev mode is off", async () => {
  const fetchMock = vi.fn(async () => ok());
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useBatch());
  const { rows, files } = rowsAndFiles(1);
  await act(async () => {
    await result.current.run(rows, files);
  });
  const [, init] = fetchMock.mock.calls[0];
  const fd = init.body as FormData;
  expect(fd.get("devTier")).toBeNull();
});

it("includes devTier on every request when dev mode is on", async () => {
  localStorage.setItem("devMode", "true");
  localStorage.setItem("devTier", "cloud");
  const fetchMock = vi.fn(async () => ok());
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useBatch());
  const { rows, files } = rowsAndFiles(2);
  await act(async () => {
    await result.current.run(rows, files);
  });
  for (const call of fetchMock.mock.calls) {
    const [, init] = call;
    const fd = init.body as FormData;
    expect(fd.get("devTier")).toBe("cloud");
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test hooks/use-batch.test.ts`
Expected: FAIL — the second new test's `fd.get("devTier")` is `null` for every call (the hook never reads dev mode/tier yet).

- [ ] **Step 3: Update `hooks/use-batch.ts`**

```ts
"use client";
import { useCallback, useState } from "react";
import type { BatchItem, BatchRow } from "@/lib/csv";
import type { VerifyResponse } from "@/hooks/use-verify";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useDevTier, type DevTier } from "@/hooks/use-dev-tier";

const CONCURRENCY = 5;

async function verifyOne(row: BatchRow, file: File, devTier?: DevTier): Promise<VerifyResponse> {
  const fd = new FormData();
  fd.set("application", JSON.stringify(row.application));
  fd.set("image", file);
  if (devTier) fd.set("devTier", devTier);
  const res = await fetch("/api/verify", { method: "POST", body: fd, signal: AbortSignal.timeout(30_000) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Verification failed.");
  return body as VerifyResponse;
}

export function useBatch() {
  const [items, setItems] = useState<BatchItem[]>([]);
  const [running, setRunning] = useState(false);
  const devMode = useDevMode();
  const devTier = useDevTier();

  const run = useCallback(
    async (rows: BatchRow[], files: Map<string, File>) => {
      const effectiveDevTier = devMode ? devTier : undefined;
      const update = (filename: string, patch: Partial<BatchItem>) =>
        setItems((prev) => prev.map((it) => (it.filename === filename ? { ...it, ...patch } : it)));

      setRunning(true);
      setItems(
        rows.map((r) => ({
          filename: r.filename,
          status: files.has(r.filename) ? "queued" : "error",
          error: files.has(r.filename) ? undefined : "No uploaded image matches this filename.",
        })),
      );
      const queue = rows.filter((r) => files.has(r.filename));
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
          const row = queue.shift();
          if (!row) break;
          update(row.filename, { status: "running" });
          try {
            const result = await verifyOne(row, files.get(row.filename) as File, effectiveDevTier);
            update(row.filename, { status: "done", result });
          } catch (e) {
            update(row.filename, { status: "error", error: e instanceof Error ? e.message : "Failed." });
          }
        }
      });
      await Promise.all(workers);
      setRunning(false);
    },
    [devMode, devTier],
  );

  return { items, running, run };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test hooks/use-batch.test.ts`
Expected: PASS (all existing tests plus the 2 new ones, 8 total).

- [ ] **Step 5: Commit**

```bash
git add hooks/use-batch.ts hooks/use-batch.test.ts
git commit -m "useBatch: forward devTier to every /api/verify request when dev mode is on"
```

---

### Task 10: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 3: Full unit test suite**

Run: `pnpm test`
Expected: all test files pass (the pre-existing files plus the new/modified ones from Tasks 1–9).

- [ ] **Step 4: Production build**

Run: `pnpm build`
Expected: builds cleanly.

- [ ] **Step 5: Boot and smoke-check dev mode, the confirmation prompt, and the tier switcher**

Run: `pnpm start` (background), then load `http://localhost:3000` in a browser (or drive it with the Playwright MCP).

Check:

1. Click the "Dev" switch in the header — a dialog appears ("Enable dev mode?"), the switch is still off.
2. Click Cancel — dialog closes, switch stays off.
3. Click "Dev" again, click "Enable" — dialog closes, switch shows on, and a three-way "Local OCR / Local LLM / Cloud" control appears in the header. If no cloud API key is set locally, "Cloud" should render visibly disabled (grayed, with a tooltip reason) and "Local OCR" should be selectable.
4. Load a sample, select "Local OCR" in the switcher, and verify — confirm the response's `tier`/`provider` reflect `local-ocr` regardless of any configured cloud key.
5. Click "Dev" to turn it off — the tier switcher disappears; verifying again uses normal auto-detection.
6. Console stays free of errors/warnings throughout.

- [ ] **Step 6: Confirm the eval harness is unaffected**

Run: `pnpm eval`
Expected: identical pass/accuracy numbers to the pre-change baseline (no `lib/matching` changes were made).

- [ ] **Step 7: Commit (only if any fixes were needed above)**

```bash
git add -A
git commit -m "fix: address issues found in the full verification pass"
```

---

## Self-Review

**Spec coverage:**

- Warning prompt before dev mode enables → Task 5. ✓
- Tier switcher (Local OCR / Local LLM / Cloud), dev-mode-only, defaults to Cloud → Task 6, Task 7. ✓
- Cloud disabled with a reason when unconfigured, fail-closed on a failed availability check → Task 6. ✓
- Local LLM always enabled, fails clearly (no silent fallback) → Task 4 (dedicated error branch), Task 6 (always-enabled option). ✓
- Automatic cloud→local-ocr fallback, applies globally, warns in the response → Task 2, Task 4. ✓
- `devTier` request plumbing from both single-label and batch flows → Task 8, Task 9. ✓
- `GET /api/verify` cloud-availability check, no key material exposed → Task 4. ✓
- Malformed `devTier` treated as absent → Task 4 (explicit test). ✓
- Sample images unaffected by `devTier` → unchanged code path (`sampleName`/`isMockSample` untouched by this plan; Task 4's rewrite preserves it verbatim). ✓
- No new runtime dependency (native `<dialog>`) → Task 5. ✓
- `tierFor` correctly reports `"local-llm"` (fixing the pre-existing mis-tagging as `"cloud"`) → Task 4. ✓

**Placeholder scan:** No TBD/TODO; every step shows complete code, not a description of code.

**Type consistency:** `DevTier` (Task 1) is imported and used identically in Task 6 (`tier-switcher.tsx`), Task 8 (`use-verify.ts`), and Task 9 (`use-batch.ts`). `withFallback`'s signature (Task 2: `(primary, fallback, onFallback?)`) matches its two call sites in Task 4. `selectCloudProvider(): VisionProvider | null` (Task 3) matches its use in Task 4's `POST` handler and `GET` handler. `tierFor` (introduced in Task 4) is used consistently for both the explicit-`devTier` branches and the default auto-detection branch.

**Ambiguity:** `verifyOne`'s `devTier` parameter is explicitly typed `DevTier | undefined` (Task 9) rather than always-required, since dev mode off means no tier should be sent at all — deliberate, matches `useVerify`'s equivalent `if (devMode) fd.set(...)` guard (Task 8).
