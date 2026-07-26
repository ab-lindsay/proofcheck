# local-llm Tier (Ollama + Qwen2.5-VL-3B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `local-llm` extraction tier that runs Qwen2.5-VL-3B via a local Ollama instance's native `/api/chat` endpoint — keyless vision-LLM extraction with schema-constrained structured outputs.

**Architecture:** The shared model-extraction core (`EXTRACTION_PROMPT` + `extractWithModel`) is promoted out of `cloud/` since it's transport-agnostic; a new adapter posts to Ollama's native API with `fetch` (no SDK, no new dependency), passing the `ExtractedLabel` JSON schema as Ollama's `format` for grammar-constrained sampling. Selection is explicit-only (`VISION_PROVIDER=local-llm`); every failure mode propagates unwrapped so the existing `/api/verify` fail-closed handling applies.

**Tech Stack:** TypeScript (strict), Node 22 native `fetch`, zod 4 (`z.toJSONSchema`), Vitest with `vi.stubGlobal`/`vi.stubEnv`, existing Ollama 0.9.0 install with `qwen2.5vl:3b` already pulled.

**Spec:** `docs/superpowers/specs/2026-07-24-local-llm-ollama-tier-design.md` — read it before starting; it records why the native API (not OpenAI-compat) and why structured outputs.

## Global Constraints

- **Keyless by default:** the app must stay fully functional with zero env vars. `local-llm` is strictly opt-in via `VISION_PROVIDER=local-llm` — never auto-selected, never required.
- **No new dependencies**, runtime or dev. Native `fetch` + zod 4's built-in `z.toJSONSchema` only.
- **No live model calls in `pnpm test`** — all adapter tests stub `fetch`. Only Task 5's manual eval touches the running Ollama.
- **Vocabulary:** the tier name is exactly `local-llm`; extraction backends are "tiers"; the adapter returns only a Zod-validated `ExtractedLabel` — never a verdict (extraction proposes, matching disposes).
- **Commit messages:** plain, authored as the user would write them — no Co-Authored-By/Claude attribution of any kind.
- Path alias `@/` resolves from the repo root (existing `tsconfig.json`). Package manager is pnpm. TS strict mode.

## File Structure

| File                                                | Action                                     | Responsibility                                                                                |
| --------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `lib/vision/model-extraction.ts`                    | Moved from `lib/vision/cloud/core.ts`      | Shared `EXTRACTION_PROMPT`, `extractWithModel`, `ExtractionError` for every model-backed tier |
| `lib/vision/model-extraction.test.ts`               | Moved from `lib/vision/cloud/core.test.ts` | Tests for the shared core (content unchanged)                                                 |
| `lib/vision/cloud/{gemini,claude,openai,groq}.ts`   | Modify (import path only)                  | Cloud adapters                                                                                |
| `lib/vision/local-llm/ollama.ts`                    | Create                                     | The local-llm tier: native Ollama `/api/chat` adapter                                         |
| `lib/vision/local-llm/ollama.test.ts`               | Create                                     | Adapter request-contract + fail-closed tests (stubbed `fetch`)                                |
| `lib/vision/select.ts`                              | Modify                                     | Register `local-llm` in `PROVIDERS`; extend the unknown-provider error message                |
| `lib/vision/select.test.ts`                         | Modify                                     | One new forced-tier case                                                                      |
| `.env.example`, `docs/ARCHITECTURE.md`, `README.md` | Modify                                     | Document the tier + 4 new optional env vars                                                   |

---

### Task 1: Promote `cloud/core.ts` → `model-extraction.ts`

Pure relocation — no logic changes. The existing test suite is the safety net.

**Files:**

- Move: `lib/vision/cloud/core.ts` → `lib/vision/model-extraction.ts`
- Move: `lib/vision/cloud/core.test.ts` → `lib/vision/model-extraction.test.ts`
- Modify: `lib/vision/cloud/gemini.ts`, `lib/vision/cloud/claude.ts`, `lib/vision/cloud/openai.ts`, `lib/vision/cloud/groq.ts` (import path only)

**Interfaces:**

- Consumes: nothing new.
- Produces: `EXTRACTION_PROMPT: string`, `extractWithModel(call: () => Promise<string>): Promise<ExtractedLabel>`, `class ExtractionError extends Error` — all now importable from `@/lib/vision/model-extraction`. Task 2 depends on this path existing.

- [ ] **Step 1: Confirm the pre-move suite is green**

Run: `pnpm test`
Expected: PASS (all suites). If anything is red before you start, stop and report — do not proceed on a broken baseline.

- [ ] **Step 2: Move both files with git mv**

```bash
cd /media/storage/repos/misc/instructions
git mv lib/vision/cloud/core.ts lib/vision/model-extraction.ts
git mv lib/vision/cloud/core.test.ts lib/vision/model-extraction.test.ts
```

- [ ] **Step 3: Update every import of the old path**

Exactly five files reference `@/lib/vision/cloud/core` (verified by grep): the four adapters and the moved test file. In each, change:

```ts
// OLD (in gemini.ts, claude.ts, openai.ts, groq.ts):
import { EXTRACTION_PROMPT, extractWithModel } from "@/lib/vision/cloud/core";
// NEW:
import { EXTRACTION_PROMPT, extractWithModel } from "@/lib/vision/model-extraction";
```

```ts
// OLD (in the moved lib/vision/model-extraction.test.ts):
import { extractWithModel, ExtractionError } from "@/lib/vision/cloud/core";
// NEW:
import { extractWithModel, ExtractionError } from "@/lib/vision/model-extraction";
```

One-liner alternative:

```bash
sed -i 's|@/lib/vision/cloud/core|@/lib/vision/model-extraction|' \
  lib/vision/cloud/gemini.ts lib/vision/cloud/claude.ts \
  lib/vision/cloud/openai.ts lib/vision/cloud/groq.ts \
  lib/vision/model-extraction.test.ts
```

- [ ] **Step 4: Verify nothing still references the old path, and the suite is still green**

```bash
grep -rn "cloud/core" lib --include="*.ts" ; pnpm typecheck && pnpm test
```

Expected: grep prints nothing; typecheck clean; all tests PASS (same counts as Step 1).

- [ ] **Step 5: Commit**

```bash
git add lib/vision/model-extraction.ts lib/vision/model-extraction.test.ts \
  lib/vision/cloud/core.ts lib/vision/cloud/core.test.ts \
  lib/vision/cloud/gemini.ts lib/vision/cloud/claude.ts \
  lib/vision/cloud/openai.ts lib/vision/cloud/groq.ts
git commit -m "Promote shared extraction core out of cloud/ to lib/vision/model-extraction"
```

---

### Task 2: The `local-llm` Ollama adapter (TDD)

**Files:**

- Create: `lib/vision/local-llm/ollama.ts`
- Test: `lib/vision/local-llm/ollama.test.ts`

**Interfaces:**

- Consumes: `EXTRACTION_PROMPT`, `extractWithModel` from `@/lib/vision/model-extraction` (Task 1); `ExtractedLabelSchema` from `@/lib/schema`; `VisionProvider` from `@/lib/vision/types`; `MOCK_FIXTURES` from `@/lib/vision/mock` (test only).
- Produces: `localLlmProvider: VisionProvider` with `name === "local-llm"` — Task 3 registers it.

- [ ] **Step 1: Write the failing test**

Create `lib/vision/local-llm/ollama.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { localLlmProvider } from "@/lib/vision/local-llm/ollama";
import { MOCK_FIXTURES } from "@/lib/vision/mock";

const IMAGE = Buffer.from("fake-image-bytes");
const META = { filename: "upload.png", mimeType: "image/png" };
const VALID_CONTENT = JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]);

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ message: { content } }),
    text: async () => "",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("localLlmProvider", () => {
  it("posts the extraction request contract to /api/chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONTENT));
    vi.stubGlobal("fetch", fetchMock);

    await localLlmProvider.extract(IMAGE, META);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/chat");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.model).toBe("qwen2.5vl:3b");
    expect(body.stream).toBe(false);
    // structured outputs: the full ExtractedLabel JSON schema rides in `format`
    expect(Object.keys(body.format.properties)).toEqual(
      expect.arrayContaining([
        "brandName",
        "classType",
        "alcoholContent",
        "netContents",
        "nameAndAddress",
        "countryOfOrigin",
        "healthWarningStatement",
      ]),
    );
    // num_ctx present and raised — the regression guard for silent image-token truncation
    expect(body.options.num_ctx).toBe(8192);
    expect(body.options.temperature).toBe(0);
    // native API: bare base64 in images[], no data: URI prefix
    expect(body.messages[0].images[0]).toBe(IMAGE.toString("base64"));
    expect(body.messages[0].content).toMatch(/GOVERNMENT WARNING/);
  });

  it("parses a valid response into an ExtractedLabel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(VALID_CONTENT)));
    const r = await localLlmProvider.extract(IMAGE, META);
    expect(r.brandName.value).toBe("OLD TOM DISTILLERY");
    expect(r.brandName.present).toBe(true);
  });

  it("fails closed on a non-OK response (model not pulled)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({}),
      text: async () => 'model "qwen2.5vl:3b" not found',
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(localLlmProvider.extract(IMAGE, META)).rejects.toThrow(/Ollama 404/);
    // transport errors propagate unwrapped on the first attempt — extractWithModel only
    // retries JSON/schema failures, so exactly one fetch:
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default num_ctx when the env override is malformed", async () => {
    vi.stubEnv("OLLAMA_NUM_CTX", "abc");
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONTENT));
    vi.stubGlobal("fetch", fetchMock);
    await localLlmProvider.extract(IMAGE, META);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options.num_ctx).toBe(8192);
  });

  it("tolerates a trailing slash in OLLAMA_BASE_URL", async () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://gpu-box:11434/");
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONTENT));
    vi.stubGlobal("fetch", fetchMock);
    await localLlmProvider.extract(IMAGE, META);
    expect(fetchMock.mock.calls[0][0]).toBe("http://gpu-box:11434/api/chat");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run lib/vision/local-llm/ollama.test.ts`
Expected: FAIL — cannot resolve `@/lib/vision/local-llm/ollama` (the module doesn't exist yet).

- [ ] **Step 3: Implement the adapter**

Create `lib/vision/local-llm/ollama.ts`:

```ts
import { z } from "zod";
import type { VisionProvider } from "@/lib/vision/types";
import { ExtractedLabelSchema } from "@/lib/schema";
import { EXTRACTION_PROMPT, extractWithModel } from "@/lib/vision/model-extraction";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen2.5vl:3b";
const DEFAULT_NUM_CTX = 8192;
const DEFAULT_TIMEOUT_MS = 60_000;

// Computed once at module load. Enforces JSON *structure* at generation time via Ollama's
// grammar-constrained sampling; Zod still validates at the boundary in extractWithModel
// (invariant 3) — grammars can't express numeric ranges, so post-hoc validation stays authoritative.
const EXTRACTION_FORMAT = z.toJSONSchema(ExtractedLabelSchema);

// A malformed override (e.g. OLLAMA_TIMEOUT_MS=abc → NaN) would otherwise reach setTimeout as NaN
// (fires immediately → every request insta-aborts) or serialize as null in the request body.
// Fall back to the default on anything but a positive integer.
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const localLlmProvider: VisionProvider = {
  name: "local-llm",
  async extract(image, _meta) {
    const baseUrl = (process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const model = process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
    const numCtx = envInt("OLLAMA_NUM_CTX", DEFAULT_NUM_CTX);
    const timeoutMs = envInt("OLLAMA_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

    return extractWithModel(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            stream: false,
            format: EXTRACTION_FORMAT,
            // temperature 0 → deterministic extraction (this tier feeds the eval harness);
            // num_ctx raised so a label's visual tokens + prompt + JSON output are not silently
            // truncated (Ollama's default is 2048 — too small for a vision request).
            options: { num_ctx: numCtx, temperature: 0 },
            messages: [
              {
                role: "user",
                content: EXTRACTION_PROMPT,
                images: [image.toString("base64")], // native API: bare base64, no data: prefix
              },
            ],
          }),
        });
        if (!res.ok) {
          // Non-2xx (e.g. 404 "model not found" when qwen2.5vl:3b isn't pulled) throws here so it
          // propagates as an error, never gets JSON.parse'd as if it were an extraction. Fail closed.
          throw new Error(`Ollama ${res.status} ${res.statusText}: ${await res.text()}`);
        }
        const json = (await res.json()) as { message?: { content?: string } };
        return json.message?.content ?? "";
      } finally {
        clearTimeout(timer);
      }
    });
  },
};
```

Note: `_meta` is deliberately unused — the native API takes bare base64 and infers the image type, so `meta.mimeType` isn't needed; the parameter stays because it's part of the `VisionProvider` interface. If ESLint flags it, the leading underscore is the project-standard suppression.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/vision/local-llm/ollama.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Full gates, then commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add lib/vision/local-llm
git commit -m "Add local-llm tier: Ollama /api/chat adapter with schema-constrained output"
```

---

### Task 3: Register `local-llm` in the tier selector (TDD)

**Files:**

- Modify: `lib/vision/select.ts:9-22`
- Test: `lib/vision/select.test.ts`

**Interfaces:**

- Consumes: `localLlmProvider` from `@/lib/vision/local-llm/ollama` (Task 2).
- Produces: `providerByName("local-llm")` and `VISION_PROVIDER=local-llm` both resolve to the provider — Task 5's `pnpm eval --provider local-llm` relies on this.

- [ ] **Step 1: Add the failing test case**

In `lib/vision/select.test.ts`, after the existing `"VISION_PROVIDER forces a tier"` case, add:

```ts
it("VISION_PROVIDER=local-llm forces the local-llm tier", () => {
  vi.stubEnv("VISION_PROVIDER", "local-llm");
  expect(selectProvider("upload.png").name).toBe("local-llm");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run lib/vision/select.test.ts`
Expected: FAIL — `providerByName` throws `Unknown VISION_PROVIDER "local-llm"`.

- [ ] **Step 3: Register the provider**

In `lib/vision/select.ts`: add the import, the `PROVIDERS` entry, and extend the error message.

```ts
// add with the other imports:
import { localLlmProvider } from "@/lib/vision/local-llm/ollama";
```

```ts
// OLD:
const PROVIDERS: Record<string, VisionProvider> = {
  mock: mockProvider,
  "local-ocr": localOcrProvider,
  gemini: geminiProvider,
// NEW:
const PROVIDERS: Record<string, VisionProvider> = {
  mock: mockProvider,
  "local-ocr": localOcrProvider,
  "local-llm": localLlmProvider,
  gemini: geminiProvider,
```

```ts
// OLD (inside providerByName):
throw new Error(`Unknown VISION_PROVIDER "${name}" (expected mock | local-ocr | gemini | claude | openai | groq)`);
// NEW:
throw new Error(
  `Unknown VISION_PROVIDER "${name}" (expected mock | local-ocr | local-llm | gemini | claude | openai | groq)`,
);
```

No change to `selectProvider`'s auto-selection body — explicit-only is the spec'd behavior (§4): no key exists to gate on, and probing localhost per-request to decide routing is a side effect selection must not have.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/vision/select.test.ts`
Expected: PASS — all cases including the new one.

- [ ] **Step 5: Commit**

```bash
git add lib/vision/select.ts lib/vision/select.test.ts
git commit -m "Register local-llm in the tier selector (explicit VISION_PROVIDER only)"
```

---

### Task 4: Configuration and docs

No unit tests — verification is grep + lint. All edits below give exact old/new text against the current working tree.

**Files:**

- Modify: `.env.example`
- Modify: `docs/ARCHITECTURE.md` (Decision Summary row, vocabulary Tier row, env-var table, directory layout)
- Modify: `README.md` (tier table + run instructions)

**Interfaces:**

- Consumes: the four env var names/defaults from Task 2 (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_NUM_CTX`, `OLLAMA_TIMEOUT_MS`).
- Produces: docs only.

- [ ] **Step 1: `.env.example`**

```
# OLD line:
# Force a tier: mock | local-ocr | gemini | claude | openai | groq (default: auto)
# NEW:
# Force a tier: mock | local-ocr | local-llm | gemini | claude | openai | groq (default: auto)
```

Append at the end of the file:

```
# Local vision LLM via Ollama — keyless, fully local. Requires Ollama running with the model
# pulled (`ollama pull qwen2.5vl:3b`) and VISION_PROVIDER=local-llm (never auto-selected).
# OLLAMA_BASE_URL=http://localhost:11434
# OLLAMA_MODEL=qwen2.5vl:3b
# OLLAMA_NUM_CTX=8192
# OLLAMA_TIMEOUT_MS=60000
```

- [ ] **Step 2: `docs/ARCHITECTURE.md` — four edits**

**(a) Decision Summary, AI/extraction row** — change the decision cell:

```
OLD: **Tiered `VisionProvider`** — `mock` \| `local-ocr` (Tesseract.js) \| `cloud` (Gemini default, Claude, OpenAI adapters). Keyless by default.
NEW: **Tiered `VisionProvider`** — `mock` \| `local-ocr` (Tesseract.js) \| `local-llm` (Ollama + Qwen2.5-VL, keyless but needs local setup) \| `cloud` (Gemini default, Claude, OpenAI adapters). Keyless by default.
```

**(b) Vocabulary table, Tier row:**

```
OLD: | **Tier** | One extraction backend: `mock` \| `local-ocr` \| `cloud`. |
NEW: | **Tier** | One extraction backend: `mock` \| `local-ocr` \| `local-llm` \| `cloud`. `local-llm` is a vision LLM on a local Ollama — keyless like `local-ocr`, but not zero-setup (needs Ollama + a pulled model); explicit opt-in only. |
```

**(c) Environment Variables table** — update the `VISION_PROVIDER` row's value list to `mock` \| `local-ocr` \| `local-llm` \| `gemini` \| `claude` \| `openai` \| `groq`, and add after the `GROQ_API_KEY` row:

```
| `OLLAMA_BASE_URL` | No | Ollama host for the local-llm tier (default `http://localhost:11434`). |
| `OLLAMA_MODEL` | No | Model tag for the local-llm tier (default `qwen2.5vl:3b`). |
| `OLLAMA_NUM_CTX` | No | local-llm context window (default 8192 — covers image tokens + prompt + output; Ollama's own default of 2048 silently truncates vision requests). |
| `OLLAMA_TIMEOUT_MS` | No | local-llm hard per-request bound (default 60000) so a stuck model fails closed. |
```

**(d) Directory Layout** — in the `lib/` block:

```
OLD:
  vision/
    index.ts               # VisionProvider interface + tier selector
    mock.ts                # canned results for bundled samples
    local-ocr.ts           # Tesseract.js + text→fields parser
    cloud/{gemini,claude,openai,groq}.ts
NEW:
  vision/
    index.ts               # VisionProvider interface + tier selector
    mock.ts                # canned results for bundled samples
    local-ocr.ts           # Tesseract.js + text→fields parser
    local-llm/ollama.ts    # native Ollama /api/chat (Qwen2.5-VL) — keyless local vision LLM
    model-extraction.ts    # shared EXTRACTION_PROMPT + extractWithModel (all model-backed tiers)
    cloud/{gemini,claude,openai,groq}.ts
```

- [ ] **Step 3: `README.md` — two edits**

**(a) Tier table** — add between the `local-ocr` and `cloud` rows:

```
| `local-llm` | [Ollama](https://ollama.com/) + `ollama pull qwen2.5vl:3b` | Vision LLM running fully local — no API key, no cloud call; opt in with `VISION_PROVIDER=local-llm` |
```

**(b) "Run it" section** — after the "Optional cloud tier:" sentence, add:

```
Fully local vision LLM instead: install [Ollama](https://ollama.com/), run
`ollama pull qwen2.5vl:3b`, and set `VISION_PROVIDER=local-llm` in `.env.local`.
```

- [ ] **Step 4: Verify and commit**

```bash
grep -c "local-llm" .env.example docs/ARCHITECTURE.md README.md   # each ≥ 1
pnpm lint && pnpm test
git add .env.example docs/ARCHITECTURE.md README.md
git commit -m "Document the local-llm tier and its OLLAMA_* env vars"
```

---

### Task 5: Live validation against the running Ollama

The one step that touches the real model (`qwen2.5vl:3b` is already pulled — verify with `ollama list`). This is manual/local by design — never CI.

- [ ] **Step 1: Preflight**

```bash
curl -s http://localhost:11434/api/version    # expect {"version":"0.9.0"} or similar
ollama list | grep qwen2.5vl                  # expect qwen2.5vl:3b
```

- [ ] **Step 2: Run the eval on the default (synthetic) set**

Run: `pnpm eval --provider local-llm`
Expected: the harness completes with a per-field accuracy report for provider `local-llm` — **no target score is promised** (this is a 3B model; the point is to measure). Failure modes to recognize: connection refused → Ollama not running; `Ollama 404` → model tag not pulled; abort after ~60 s/label → model stuck or severely CPU-bound (see hardware note below).

**Hardware note (measured on this machine, 2026-07-24):** the host GPU is an RTX A1000 Laptop with 4 GB VRAM, ~3.2 GB of which the desktop occupies at idle — so expect partial CPU offload of even the 3B model and per-label times well above GPU-resident benchmarks. First request additionally pays model load; Ollama's default `keep_alive` (~5 min) keeps subsequent labels warm. Closing GPU-heavy apps before the run is the cheapest speedup.

- [ ] **Step 3: Record the results**

Append a `## Validation results (YYYY-MM-DD)` section to THIS plan file with: overall + per-field accuracy, planted-violation catch rate, first-label (cold) and median warm per-label seconds, and whether `eval/history.jsonl` recorded the run. If warm per-label time exceeds the 5 s budget, note it as expected-and-accepted per spec §6 (this tier is not the deployed path) — do not tune anything in this task.

- [ ] **Step 4: Full gates one last time, then commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm eval   # mock-tier eval must stay 100%
git add docs/superpowers/plans/2026-07-24-local-llm-ollama-tier.md eval/history.jsonl
git commit -m "Record local-llm tier validation results"
```

- [ ] **Step 5 (optional, time permitting): real-world set**

Run: `pnpm eval --set real-world --provider local-llm` (46 images — budget up to ~30 min CPU-bound). Append its numbers to the same validation section; this is the honest comparison against local-ocr's 17/46 baseline.

---

## Validation results (2026-07-24)

**Preflight (Step 1):** `curl -s http://localhost:11434/api/version` → `{"version":"0.9.0"}`. `ollama list | grep qwen2.5vl` → `qwen2.5vl:3b  fb90415cde1e  3.2 GB`. Both as expected.

**Cold model-load probe (pre-eval, text-only warmup, per the brief):** `time curl -s http://localhost:11434/api/chat -d '{"model":"qwen2.5vl:3b","stream":false,"messages":[{"role":"user","content":"hi"}]}'` → Ollama-reported `load_duration` 2.186 s, `eval_duration` 0.431 s for a 10-token reply, `total_duration` 3.120 s; wall clock (`time`) 3.127 s. This measures only text-path model load into memory (weights served from OS page cache) — it does **not** represent real per-label cost, since it carries no image and a 1-word prompt.

**Eval run (Step 2):** `pnpm eval --provider local-llm` against the default/synthetic set (13 entries). Run with per-line wall-clock timestamps captured independently alongside the command's own stdout, then cross-checked against `eval/history.jsonl`.

- **Result: 13/13 extraction errors.** Every label's `provider.extract()` call threw `This operation was aborted` — the adapter's `AbortController` firing at `OLLAMA_TIMEOUT_MS` (default 60000 ms). No connection-refused, no 404, no JSON/schema failure — a uniform timeout abort on every single label.
- **Overall verdict accuracy:** 0/13 (0%). The matcher (`verifyLabel`) never ran for any label — extraction failed closed on every item, so `eval/run.ts` hit its per-item `catch`/`continue` before reaching matching (architecture rule 7: fail closed per item, one bad label never aborts the batch — the harness itself never aborted, it just recorded 13 honest failures).
- **Per-field accuracy:** n/a — `perField: {}` in `eval/history.jsonl`. `verifyLabel` was never invoked, so no field-level verdict exists to score.
- **Planted-violation catch rate:** 0/0 "assessable" — the harness only increments `violationsTotal` after a successful extraction reaches the violation-check block, so none of the default set's 8 planted-violation entries were ever reached. The recorded `violationsCaught/violationsTotal = 0/0` (harness prints this as 100%) is **not** a genuine catch rate; it means zero opportunities to catch anything, not zero misses.
- **Timing:** gaps between consecutive per-label abort log lines (12 gaps across 13 aborts) ranged 60.002–60.011 s — median 60.004 s, mean 60.005 s. Every one of the 13 labels, including the 12 "warm" ones after the first, hit essentially the same ~60.0 s wall (first label: 60.85 s from process start, the extra ~0.85 s being Node/tsx/provider startup before the request was even issued). Total wall for the whole `pnpm eval --provider local-llm` invocation: 781.06 s (13.02 min) for 13 labels → 60.08 s/label mean including all overhead. Because every request was killed by the timeout, **true per-label inference time was never observed to completion** — 60 s is a measured floor, not the actual latency; the model may need substantially longer to finish a real extraction on this hardware.
- **Hardware during the run:** GPU had roughly 800 MB–1 GB free of 4 GB VRAM (the desktop already held ~3.2–3.3 GB), and the `ollama runner` process ran at ~800% CPU (`--threads 8`), confirming the predicted near-total CPU offload of the 3.2 GB model.
- **`eval/history.jsonl` recorded the run:** yes, line 8 — `{"timestamp":"2026-07-24T15:21:08.346Z","gitSha":"5cebde941e9815f12c5f208b3787e602251c0f7f","dirty":false,"provider":"local-llm","set":"default","entries":13,"overallCorrect":0,"overallTotal":13,"perField":{},"violationsCaught":0,"violationsTotal":0,"extractionErrors":13}`.

**5 s latency budget (spec §6):** blown by more than an order of magnitude (~60 s vs. 5 s, and real completion may exceed even that). **Expected-and-accepted** — `local-llm` is explicit opt-in only (`VISION_PROVIDER=local-llm`), never the deployed default, and the spec promised no target score or latency for a 3B model split across a 4 GB-VRAM laptop GPU and CPU.

**Per-label errors:** all 13 — uniform `This operation was aborted` (AbortController timeout), never a silent PASS. Every failure fails closed exactly as designed (invariant 7).

**Interpretation:** this run measured the 60 s `OLLAMA_TIMEOUT_MS` budget, not model accuracy — on this GPU/CPU-split hardware the model never got far enough to complete a single extraction inside the timeout window, so no conclusion can be drawn here about qwen2.5vl:3b's actual field-extraction accuracy. The honest, actionable follow-up — **not performed in this task**, per the no-tuning rule — would be a config-only rerun with `OLLAMA_TIMEOUT_MS` raised (e.g. 300000) and/or GPU VRAM freed by closing other GPU consumers; no code change is implicated by anything observed here.

**Step 5 (optional real-world set): skipped** for this session (time budget), per plan.
