# Bedrock (Nova Lite) Cloud Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `bedrock` cloud-tier adapter that calls Amazon Bedrock's Converse API (Nova Lite 1.0) over native `fetch` with bearer-token auth — auto-selected like the other cloud tiers when `AWS_BEARER_TOKEN_BEDROCK` is set.

**Architecture:** `lib/vision/cloud/bedrock.ts` posts directly to `https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse` with `Authorization: Bearer <token>` — no AWS SDK, no SigV4 (Bedrock API keys are bearer-token auth by design; the JS SDK has a documented gap auto-detecting the same env var). Reuses the shared `EXTRACTION_PROMPT`/`extractWithModel` from `lib/vision/model-extraction.ts`. Registered in `select.ts`'s existing auto-selection chain, same as `gemini`/`claude`/`openai`/`groq`.

**Tech Stack:** TypeScript (strict), Node 22 native `fetch`, Vitest with `vi.stubGlobal`/`vi.stubEnv`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-24-bedrock-nova-cloud-tier-design.md` — read it before starting; it records why raw `fetch` over the AWS SDK, and the base64 byte-encoding correction (source.bytes is a base64 **string**, not a JSON array — verified against real-world reports of this exact endpoint, not assumed from paraphrased docs).

## Global Constraints

- **No new dependencies.** Native `fetch` only — do not add `@aws-sdk/client-bedrock-runtime` or any AWS SDK package.
- **No live Bedrock calls in `pnpm test`** — the adapter test stubs `fetch`. Only the manual eval step touches the real endpoint.
- **Secrets:** `AWS_BEARER_TOKEN_BEDROCK` is already set in `.env.local` (gitignored) with the user's real Bedrock API key — never write that real value into `.env.example`, never log it, never put it in a prompt. `.env.example` gets commented-out placeholders only.
- **Vocabulary:** tier name is exactly `bedrock`; it is a `cloud` tier adapter (alongside `gemini`/`claude`/`openai`/`groq`), auto-selected by API-key presence — NOT explicit-opt-in-only like `local-llm`.
- **Byte encoding (exact, verified):** `source.bytes` in the Converse request body must be `image.toString("base64")` — a base64 string. Do NOT spread the Buffer into a numeric array; that is a documented wrong-guess this plan corrects.
- **Commit messages:** plain, authored as the user would write them — no Co-Authored-By/Claude attribution of any kind.
- Path alias `@/` resolves from the repo root. Package manager is pnpm. TS strict mode.

## File Structure

| File                                                | Action | Responsibility                                                                               |
| --------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `lib/vision/cloud/bedrock.ts`                       | Create | The `bedrock` tier: Nova Lite via Bedrock's Converse REST API                                |
| `lib/vision/cloud/bedrock.test.ts`                  | Create | Adapter request-contract + fail-closed tests (stubbed `fetch`)                               |
| `lib/vision/select.ts`                              | Modify | Register `bedrock` in `PROVIDERS`; add to the auto-selection chain; extend the error message |
| `lib/vision/select.test.ts`                         | Modify | One new auto-selection case                                                                  |
| `.env.example`, `docs/ARCHITECTURE.md`, `README.md` | Modify | Document the tier + 3 new optional env vars                                                  |

---

### Task 1: The `bedrock` Nova adapter (TDD)

**Files:**

- Create: `lib/vision/cloud/bedrock.ts`
- Test: `lib/vision/cloud/bedrock.test.ts`

**Interfaces:**

- Consumes: `EXTRACTION_PROMPT`, `extractWithModel` from `@/lib/vision/model-extraction`; `VisionProvider` from `@/lib/vision/types`; `MOCK_FIXTURES` from `@/lib/vision/mock` (test only).
- Produces: `bedrockProvider: VisionProvider` with `name === "bedrock"` — Task 2 registers it.

- [ ] **Step 1: Write the failing test**

Create `lib/vision/cloud/bedrock.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { bedrockProvider } from "@/lib/vision/cloud/bedrock";
import { EXTRACTION_PROMPT } from "@/lib/vision/model-extraction";
import { MOCK_FIXTURES } from "@/lib/vision/mock";

const IMAGE = Buffer.from("fake-image-bytes");
const META = { filename: "upload.png", mimeType: "image/png" };
const VALID_CONTENT = JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]);

function okResponse(text: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ output: { message: { content: [{ text }] } } }),
    text: async () => "",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("bedrockProvider", () => {
  it("posts the Converse request contract to the correct URL", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONTENT));
    vi.stubGlobal("fetch", fetchMock);

    await bedrockProvider.extract(IMAGE, META);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://bedrock-runtime.us-east-2.amazonaws.com/model/amazon.nova-lite-v1%3A0/converse");
    expect(init.headers["Authorization"]).toBe("Bearer test-token");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    const content = body.messages[0].content;
    expect(content[0]).toEqual({ text: EXTRACTION_PROMPT });
    expect(content[1].image.format).toBe("png");
    // Regression guard for the byte-encoding correction: base64 STRING, not a number array.
    expect(content[1].image.source.bytes).toBe(IMAGE.toString("base64"));
    expect(typeof content[1].image.source.bytes).toBe("string");
    expect(body.inferenceConfig.maxTokens).toBe(2000);
  });

  it("parses a valid response into an ExtractedLabel", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(VALID_CONTENT)));
    const r = await bedrockProvider.extract(IMAGE, META);
    expect(r.brandName.value).toBe("OLD TOM DISTILLERY");
    expect(r.brandName.present).toBe(true);
  });

  it("fails closed on a non-OK response", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({}),
      text: async () => "AccessDeniedException: not authorized",
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(bedrockProvider.extract(IMAGE, META)).rejects.toThrow(/Bedrock 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses AWS_REGION and BEDROCK_MODEL overrides when set", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    vi.stubEnv("AWS_REGION", "eu-west-1");
    vi.stubEnv("BEDROCK_MODEL", "amazon.nova-pro-v1:0");
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONTENT));
    vi.stubGlobal("fetch", fetchMock);
    await bedrockProvider.extract(IMAGE, META);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://bedrock-runtime.eu-west-1.amazonaws.com/model/amazon.nova-pro-v1%3A0/converse",
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run lib/vision/cloud/bedrock.test.ts`
Expected: FAIL — cannot resolve `@/lib/vision/cloud/bedrock` (the module doesn't exist yet).

- [ ] **Step 3: Implement the adapter**

Create `lib/vision/cloud/bedrock.ts`:

```ts
import type { VisionProvider } from "@/lib/vision/types";
import { EXTRACTION_PROMPT, extractWithModel } from "@/lib/vision/model-extraction";

const DEFAULT_REGION = "us-east-2";
const DEFAULT_MODEL = "amazon.nova-lite-v1:0";
const DEFAULT_TIMEOUT_MS = 30_000;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const bedrockProvider: VisionProvider = {
  name: "bedrock",
  async extract(image, meta) {
    const region = process.env.AWS_REGION ?? DEFAULT_REGION;
    const model = process.env.BEDROCK_MODEL ?? DEFAULT_MODEL;
    const timeoutMs = envInt("BEDROCK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    const format = meta.mimeType.split("/")[1] ?? "png";

    return extractWithModel(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(
          `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`,
            },
            signal: controller.signal,
            body: JSON.stringify({
              messages: [
                {
                  role: "user",
                  content: [
                    { text: EXTRACTION_PROMPT },
                    // source.bytes is a base64 STRING over raw HTTP (the AWS SDK accepts a Uint8Array
                    // from your code and base64-encodes it for you onto the wire; building the JSON
                    // body directly means doing that encoding step ourselves).
                    { image: { format, source: { bytes: image.toString("base64") } } },
                  ],
                },
              ],
              // Nova's Converse schema has no JSON-mode field (unlike OpenAI/Ollama's response_format);
              // EXTRACTION_PROMPT's own "Return ONLY a JSON object" instruction plus extractWithModel's
              // fence-stripping + one-retry parse loop carry reliability, same as gemini.ts/claude.ts.
              inferenceConfig: { maxTokens: 2000 },
            }),
          },
        );
        if (!res.ok) {
          throw new Error(`Bedrock ${res.status} ${res.statusText}: ${await res.text()}`);
        }
        const json = (await res.json()) as {
          output?: { message?: { content?: { text?: string }[] } };
        };
        return json.output?.message?.content?.[0]?.text ?? "";
      } finally {
        clearTimeout(timer);
      }
    });
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/vision/cloud/bedrock.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Full gates, then commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git add lib/vision/cloud/bedrock.ts lib/vision/cloud/bedrock.test.ts
git commit -m "Add bedrock cloud tier: Nova Lite via Bedrock's Converse API"
```

---

### Task 2: Register `bedrock` in the tier selector (TDD)

**Files:**

- Modify: `lib/vision/select.ts`
- Test: `lib/vision/select.test.ts`

**Interfaces:**

- Consumes: `bedrockProvider` from `@/lib/vision/cloud/bedrock` (Task 1).
- Produces: `providerByName("bedrock")` resolves to the provider; `AWS_BEARER_TOKEN_BEDROCK` presence
  auto-selects it — Task 4's manual eval relies on this.

- [ ] **Step 1: Add the failing test case**

In `lib/vision/select.test.ts`, after the existing Groq-selection test (`"a configured Groq key
selects groq when no higher-priority key is set"`), add:

```ts
it("a configured Bedrock token selects bedrock when no higher-priority key is set", () => {
  vi.stubEnv("VISION_PROVIDER", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GROQ_API_KEY", "");
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
  expect(selectProvider("upload.png").name).toBe("bedrock");
});
```

Also add `vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "")` to the existing `"no key and unknown file falls
back to local-ocr"` test's env-clearing block, so that test stays a true "no keys at all" case now
that a fifth cloud key exists.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run lib/vision/select.test.ts`
Expected: FAIL — `selectProvider(...).name` is `"local-ocr"`, not `"bedrock"` (no `bedrock` branch
exists yet).

- [ ] **Step 3: Register the provider and add the auto-selection branch**

In `lib/vision/select.ts`:

```ts
// add with the other imports:
import { bedrockProvider } from "@/lib/vision/cloud/bedrock";
```

```ts
// OLD:
const PROVIDERS: Record<string, VisionProvider> = {
  mock: mockProvider,
  "local-ocr": localOcrProvider,
  "local-llm": localLlmProvider,
  gemini: geminiProvider,
  claude: claudeProvider,
  openai: openaiProvider,
  groq: groqProvider,
};
// NEW:
const PROVIDERS: Record<string, VisionProvider> = {
  mock: mockProvider,
  "local-ocr": localOcrProvider,
  "local-llm": localLlmProvider,
  gemini: geminiProvider,
  claude: claudeProvider,
  openai: openaiProvider,
  groq: groqProvider,
  bedrock: bedrockProvider,
};
```

```ts
// OLD (inside providerByName):
throw new Error(
  `Unknown VISION_PROVIDER "${name}" (expected mock | local-ocr | local-llm | gemini | claude | openai | groq)`,
);
// NEW:
throw new Error(
  `Unknown VISION_PROVIDER "${name}" (expected mock | local-ocr | local-llm | gemini | claude | openai | groq | bedrock)`,
);
```

```ts
// OLD (end of selectProvider):
if (process.env.GROQ_API_KEY) return groqProvider;
return localOcrProvider;
// NEW:
if (process.env.GROQ_API_KEY) return groqProvider;
if (process.env.AWS_BEARER_TOKEN_BEDROCK) return bedrockProvider;
return localOcrProvider;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run lib/vision/select.test.ts`
Expected: PASS — all cases including the new one.

- [ ] **Step 5: Commit**

```bash
git add lib/vision/select.ts lib/vision/select.test.ts
git commit -m "Register bedrock in the tier selector's auto-selection chain"
```

---

### Task 3: Configuration and docs

No unit tests — verification is grep + lint. Exact old/new text against the current tree (post local-llm-tier merge).

**Files:**

- Modify: `.env.example`
- Modify: `docs/ARCHITECTURE.md` (Decision Summary row, vocabulary Tier row, env-var table, directory layout)
- Modify: `README.md` (tier table)

**Interfaces:**

- Consumes: the three env var names/defaults from Task 1 (`AWS_REGION`, `BEDROCK_MODEL`,
  `BEDROCK_TIMEOUT_MS`) plus the gating var `AWS_BEARER_TOKEN_BEDROCK`.
- Produces: docs only.

- [ ] **Step 1: `.env.example`**

Append after the existing `GROQ_API_KEY` line (before the `local-llm` block that already follows it):

```
# AWS_BEARER_TOKEN_BEDROCK=  # enables the Bedrock cloud tier (Amazon Nova Lite); optional AWS_REGION (default us-east-2), BEDROCK_MODEL, BEDROCK_TIMEOUT_MS
```

Do **not** put a real token here — `AWS_BEARER_TOKEN_BEDROCK` is already set with the real value in
`.env.local` (gitignored), which is where it belongs.

Also update the tier-list comment:

```
OLD: # Force a tier: mock | local-ocr | local-llm | gemini | claude | openai | groq (default: auto)
NEW: # Force a tier: mock | local-ocr | local-llm | gemini | claude | openai | groq | bedrock (default: auto)
```

- [ ] **Step 2: `docs/ARCHITECTURE.md` — four edits**

**(a) Decision Summary, AI/extraction row:**

```
OLD: **Tiered `VisionProvider`** — `mock` \| `local-ocr` (Tesseract.js) \| `local-llm` (Ollama + Qwen2.5-VL, keyless but needs local setup) \| `cloud` (Gemini default, Claude, OpenAI adapters). Keyless by default.
NEW: **Tiered `VisionProvider`** — `mock` \| `local-ocr` (Tesseract.js) \| `local-llm` (Ollama + Qwen2.5-VL, keyless but needs local setup) \| `cloud` (Gemini default, Claude, OpenAI, Groq, Bedrock/Nova adapters). Keyless by default.
```

**(b) Environment Variables table** — update the `VISION_PROVIDER` row's value list and add three rows
after the existing `GROQ_API_KEY` row:

```
OLD: | `VISION_PROVIDER` | No | Force a tier: `mock` \| `local-ocr` \| `local-llm` \| `gemini` \| `claude` \| `openai` \| `groq`. Default: auto (local-ocr for uploads, mock for samples). |
NEW: | `VISION_PROVIDER` | No | Force a tier: `mock` \| `local-ocr` \| `local-llm` \| `gemini` \| `claude` \| `openai` \| `groq` \| `bedrock`. Default: auto (local-ocr for uploads, mock for samples). |
```

Add after the `GROQ_API_KEY` row (before the local-llm `OLLAMA_*` rows, which already follow it):

```
| `AWS_BEARER_TOKEN_BEDROCK` | No | Enables the Bedrock cloud tier (Amazon Nova Lite via the Converse API, bearer-token auth — no AWS SigV4). |
| `AWS_REGION` | No | Bedrock region for the `bedrock` tier (default `us-east-2`). |
| `BEDROCK_MODEL` | No | Bedrock model ID for the `bedrock` tier (default `amazon.nova-lite-v1:0`). |
| `BEDROCK_TIMEOUT_MS` | No | `bedrock` tier hard per-request bound (default 30000) — `fetch` has no built-in timeout, unlike the vendor SDKs the other cloud adapters use. |
```

**(c) Directory Layout** — in the `lib/vision/` block, extend the cloud adapters line:

```
OLD:     cloud/{gemini,claude,openai,groq}.ts
NEW:     cloud/{gemini,claude,openai,groq,bedrock}.ts
```

- [ ] **Step 3: `README.md`**

Update the tier table's cloud row:

```
OLD: | `cloud` (`gemini` / `claude` / `openai` / `groq`) | an API key | Vision LLM — best accuracy, bounding boxes, judgment |
NEW: | `cloud` (`gemini` / `claude` / `openai` / `groq` / `bedrock`) | an API key | Vision LLM — best accuracy, bounding boxes, judgment |
```

- [ ] **Step 4: Verify and commit**

```bash
grep -c "bedrock\|Bedrock" .env.example docs/ARCHITECTURE.md README.md   # each ≥ 1
pnpm lint && pnpm test
git add .env.example docs/ARCHITECTURE.md README.md
git commit -m "Document the bedrock cloud tier and its env vars"
```

---

### Task 4: Live validation against the real Bedrock endpoint

The one step that touches the real API. `AWS_BEARER_TOKEN_BEDROCK` is already set in `.env.local`
with a live key for region `us-east-2`. Manual/local by design — never CI.

- [ ] **Step 1: Preflight — confirm the token is loaded**

```bash
grep -q "AWS_BEARER_TOKEN_BEDROCK" .env.local && echo "token present in .env.local"
```

- [ ] **Step 2: Run the eval on the default (synthetic) set**

Run: `pnpm eval --provider bedrock`
Expected: the harness completes with a per-field accuracy report for provider `bedrock`. Failure
modes to recognize: `Bedrock 401`/`403` → token invalid/expired or lacks Nova Lite model access in
`us-east-2` (check Bedrock console model access for the account); `Bedrock 404` → wrong model ID or
region combination; `Bedrock 400` with a validation message → request-shape bug (check against the
spec's exact field names first).

- [ ] **Step 3: Record the results**

Append a `## Validation results (YYYY-MM-DD)` section to THIS plan file with: overall + per-field
accuracy, planted-violation catch rate, and any per-label errors encountered. No target score is
promised — this measures real accuracy against the eval set for the first time.

- [ ] **Step 4: Full gates one last time, then commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm eval   # mock-tier eval must stay 100%
git add docs/superpowers/plans/2026-07-24-bedrock-nova-cloud-tier.md eval/history.jsonl
git commit -m "Record bedrock tier validation results"
```

## Validation results (2026-07-24)

> **Correction (same day, after this section was first written):** the diagnosis below —
> "a credential/token-format problem" — was **wrong**. Root-caused by decoding the token
> (well-formed `ABSK`-prefixed Bedrock API key, byte-for-byte identical to the console value) and
> confirming with a raw `curl` using the exact same token/region/model that Bedrock accepts it fine
> (HTTP 200, real Nova Lite response). The actual bug: `pnpm eval` runs via plain `tsx`, which —
> unlike `pnpm dev` (a Next.js process, which auto-loads `.env.local`) — never loaded `.env.local`
> at all. `AWS_BEARER_TOKEN_BEDROCK` (and every other cloud-tier key) was `undefined` in the eval
> process, so the adapter sent `Authorization: Bearer undefined`, which Bedrock correctly rejected
> as a malformed key. This also retroactively explains the earlier `groq`/real-world eval entry in
> `eval/history.jsonl` that failed 46/46 — same root cause, silently affecting every cloud tier, not
> a Bedrock-specific or credential-specific problem. Fixed in `eval/run.ts` (explicit
> `process.loadEnvFile(".env.local")`, Node 22 built-in, zero new dependency, `ENOENT` tolerated so
> keyless tiers are unaffected) and hardened in `lib/vision/cloud/bedrock.ts` (fails fast with a
> clear error when the token is genuinely unset, instead of sending a garbage `Bearer undefined`
> request and surfacing a confusing third-party rejection). See the corrected re-run below the
> original (preserved) failed-run record.

Ran `pnpm eval --provider bedrock` against the default (synthetic) 13-entry eval set. The run
**failed entirely** — every label errored before extraction could produce a result. **No accuracy
data was obtained.** _(Superseded — see the correction above and the re-run below.)_

**Preflight:** `AWS_BEARER_TOKEN_BEDROCK` confirmed present in `.env.local` (Step 1 passed).

**Command:** `pnpm eval --provider bedrock`

**Result:** all 13/13 labels errored identically:

```
✗ old-tom-clean.png → ERROR: Bedrock 403 Forbidden: {"Message":"Invalid API Key format: Must start with pre-defined prefix"}
✗ copper-kettle-gin.png → ERROR: Bedrock 403 Forbidden: {"Message":"Invalid API Key format: Must start with pre-defined prefix"}
✗ ridge-creek-table-wine.png → ERROR: Bedrock 403 Forbidden: {"Message":"Invalid API Key format: Must start with pre-defined prefix"}
✗ harbor-point-lager.png → ERROR: Bedrock 403 Forbidden: {"Message":"Invalid API Key format: Must start with pre-defined prefix"}
✗ kirkbride-import-wine.png → ERROR: Bedrock 403 Forbidden: {"Message":"Invalid API Key format: Must start with pre-defined prefix"}
✗ stones-throw-brand-case.png → ERROR: Bedrock 403 Forbidden: {"Message":"Invalid API Key format: Must start with pre-defined prefix"}
✗ title-case-warning.png → ERROR: Bedrock 403 Forbidden: {"Message":"Invalid API Key format: Must start with pre-defined prefix"}
✗ altered-warning.png → ERROR: Bedrock 403 Forbidden: {"Message":"Invalid API Key format: Must start with pre-defined prefix"}
✗ all-caps-warning.png → ERROR: Bedrock 403 Forbidden: {"Message":"Invalid API Key format: Must start with pre-defined prefix"}
✗ wrong-abv.png → ERROR: Bedrock 403 Forbidden: {"Message":"Invalid API Key format: Must start with pre-defined prefix"}
✗ wrong-brand.png → ERROR: Bedrock 403 Forbidden: {"Message":"Invalid API Key format: Must start with pre-defined prefix"}
✗ missing-net-contents.png → ERROR: Bedrock 403 Forbidden: {"Message":"Invalid API Key format: Must start with pre-defined prefix"}
✗ missing-warning.png → ERROR: Bedrock 403 Forbidden: {"Message":"Invalid API Key format: Must start with pre-defined prefix"}

provider: bedrock
set: default (13 entries)
overall verdict accuracy: 0/13 (0%)
per-field verdict accuracy:
planted violations caught: 0/0 (100% — vacuous, no labels extracted successfully)
extraction errors: 13/13
```

Wall-clock time for the run: **1.6s** (`real 0m1.619s`) — every request failed fast at Bedrock's
auth layer, before any model inference happened, so this is not representative of live-label
latency.

**Diagnosis (reported, not fixed):** the failure is a `403` from Bedrock's own gateway, not the
adapter — `{"Message":"Invalid API Key format: Must start with pre-defined prefix"}` is AWS
rejecting the _shape_ of the bearer token itself, before it ever reaches model authorization. This
surfaces at the identical layer for all 13 labels, consistent with a single credential problem
rather than a per-label or code-shape bug. The request layer (`lib/vision/cloud/bedrock.ts`) was
not modified to work around this, per the task's instructions. Two most likely explanations,
neither of which this task attempted to resolve — nor should it:

- The value currently in `.env.local` under `AWS_BEARER_TOKEN_BEDROCK` is not a Bedrock API key in
  the format AWS expects (Bedrock API keys have a specific prefix/encoding distinct from a raw IAM
  secret key or a generic bearer token) — i.e. the token itself is malformed for this auth scheme.
- Less likely given the specific "Invalid API Key format" wording (as opposed to an
  authorization/model-access message): the account/region genuinely lacking Nova Lite model access
  would normally surface as a different message once past the key-format check, so this looks like
  it never got that far.

No further diagnosis (e.g. inspecting the token value) was attempted, in keeping with the
instruction not to modify or work around adapter/credential issues — this is left for the
controller to investigate (e.g. regenerating the Bedrock API key from the AWS console for
`us-east-2` and confirming its format matches what `bedrock-runtime` expects for bearer-token
auth).

**Mock-tier gate (Step 4, run regardless of the above):** `pnpm typecheck && pnpm lint && pnpm test
&& pnpm eval` all passed; `pnpm eval` (mock tier) stayed at 100%. See report for full output.

---

## Corrected re-run (2026-07-24, same day, after the `.env.local`-loading fix)

With `eval/run.ts` now loading `.env.local` and `bedrock.ts` hardened to fail fast on a genuinely
missing token, `pnpm eval --provider bedrock` was re-run against the same default 13-entry set.

**Result: real accuracy data, first time this tier has completed a single extraction.**

```
✓ old-tom-clean.png → PASS (expected PASS)
✓ copper-kettle-gin.png → PASS (expected PASS)
✓ ridge-creek-table-wine.png → PASS (expected PASS)
✓ harbor-point-lager.png → PASS (expected PASS)
✓ kirkbride-import-wine.png → PASS (expected PASS)
✓ stones-throw-brand-case.png → PASS (expected PASS) · violation(brandName): CAUGHT
✓ title-case-warning.png → FAIL (expected FAIL) · violation(healthWarningStatement): CAUGHT
✓ altered-warning.png → FAIL (expected FAIL) · violation(healthWarningStatement): CAUGHT
✓ all-caps-warning.png → PASS (expected PASS) · violation(healthWarningStatement): CAUGHT
✓ wrong-abv.png → FAIL (expected FAIL) · violation(alcoholContent): CAUGHT
✓ wrong-brand.png → FAIL (expected FAIL) · violation(brandName): CAUGHT
✓ missing-net-contents.png → PASS (expected PASS) · violation(netContents): CAUGHT
✓ missing-warning.png → PASS (expected PASS) · violation(healthWarningStatement): CAUGHT

provider: bedrock
set: default (13 entries)
overall verdict accuracy: 13/13 (100%)
per-field verdict accuracy: healthWarningStatement 13/13 · brandName 9/13 · classType 13/13 · alcoholContent 11/11 · netContents 12/13 · nameAndAddress 1/1 · countryOfOrigin 1/1
planted violations caught: 8/8 (100%)
```

**Wall-clock:** 53.7s for 13 labels (`real 0m53.699s`) — ≈4.1s/label average, normal range for a
real cloud vision API call (not comparable to the earlier 1.6s auth-rejection run, which never
reached model inference).

**Reading the numbers:**

- **Overall verdict accuracy is 13/13 (100%)** and **all 8 planted violations were caught** — every
  PASS/FAIL decision matched the eval set's ground truth, including every deliberately-injected
  error (title-case warning, altered warning text, wrong ABV, brand-case mismatch, missing fields).
- **`brandName` is the weakest field at 9/13**, the only field below its own field's total. This did
  **not** produce any wrong overall verdict — consistent with brand-name matching's designed
  fuzzy/near-miss-to-REVIEW behavior (spec: near-miss brand names route to REVIEW, not a hard
  MISMATCH, so a shaky extraction here is absorbed rather than flipping PASS/FAIL).
- `alcoholContent` (11/11) and `nameAndAddress`/`countryOfOrigin` (1/1 each) are perfect but on small
  denominators (only some entries have those fields populated in the default set) — not yet a broad
  signal either way.
- This is the synthetic **default** set (13 entries), not the 46-entry **real-world** photo set —
  the harder, more realistic accuracy signal (like the `local-ocr`/`local-llm` real-world numbers
  elsewhere in this project) remains unmeasured for `bedrock`. Recommended next step, not performed
  here: `pnpm eval --set real-world --provider bedrock`.

**Full gates re-run one more time:** `pnpm typecheck && pnpm lint && pnpm test` — clean, 303/303
tests (302 + 1 new: the missing-token fail-fast guard). `pnpm eval` (mock tier) unaffected, still
100%.

---

## Real-world set (2026-07-24)

**First attempt** (`pnpm eval --set real-world --provider bedrock`, before a second bug fix below):
22 of 46 entries — every `.jpg` file — errored with `Bedrock 400 Bad Request:
{"message":"The model returned the following errors: The detected file MIME type image/jpeg does
not match the expected type image/png. Reformat your input and try again."}`. Root cause: a
**pre-existing bug in `eval/run.ts`** (unrelated to the bedrock tier itself, predates this branch)
hardcoded `mimeType: "image/png"` for every file regardless of actual extension. The real
`/api/verify` route (`app/api/verify/route.ts`) was never affected — it detects the real type from
magic bytes rather than trusting a declared value. Gemini/Claude/OpenAI/Groq likely carry the same
latent harness bug but tolerate it by sniffing the real bytes; Nova is simply the first provider
strict enough to reject the mismatch outright, which is what surfaced it.

**Fix:** `eval/run.ts` now derives the real MIME type from the file extension
(`mimeTypeFor()`, matching `ALLOWED_TYPES` in `app/api/verify/route.ts`) instead of hardcoding PNG.
Also added a `--only <comma-separated files>` flag so a targeted re-check doesn't re-spend cloud
calls on entries that already produced a real result — used below to re-run only the 22 previously
MIME-mismatched files rather than all 46 again.

**Re-run of just the 22 previously-errored entries**
(`pnpm eval --set real-world --provider bedrock --only <22 files>`): all 22 now produce real
extractions, zero remaining MIME errors — confirming the fix. Accuracy on this specific subset is
low (5/22, 23%) — see the reconciled full-set numbers below for why that's not surprising.

**Reconciled 46-entry result** (hand-combined from the two runs above — the original run's 24
non-error entries + the 22-entry re-run's results; not a single `pnpm eval` invocation, so no
corresponding synthetic line was added to `eval/history.jsonl` beyond the two real runs' own
entries):

```
overall verdict accuracy: 13/46 (28%)
per-field verdict accuracy: healthWarningStatement 30/46 (65%) · brandName 30/46 (65%) ·
  classType 39/46 (85%) · alcoholContent 44/46 (96%) · netContents 46/46 (100%) ·
  nameAndAddress 17/36 (47%) · countryOfOrigin 10/10 (100%)
planted violations caught: 5/5 (100%)
extraction errors: 0/46 (after the MIME fix — was 22/46 before it)
split: real photos 2/21 (10%) · degraded fixtures 11/25 (44%)
```

**Reading the numbers:**

- **Bedrock/Nova Lite's real-world overall accuracy (28%) is _worse_ than `local-ocr`'s plain
  Tesseract-OCR baseline on the same set (22/46, 48%** — see `eval/history.jsonl`'s most recent
  `local-ocr`/`real-world` entry). This is a genuinely useful, if humbling, signal: Nova **Lite**
  (the cheapest/fastest tier of the Nova family) struggles noticeably on this project's messy
  real-world photography — heavy glare, skew, low-resolution captures, and non-frontal label shots
  — worse than a plain OCR-plus-heuristics pipeline does. This is not a claim about Nova Pro or
  other Bedrock-hosted models, only the specific `amazon.nova-lite-v1:0` this tier defaults to.
- **All 5 planted violations were still caught (100%)** — the deliberately-injected errors (wrong
  ABV, brand-case mismatch) remain detectable even though overall accuracy on genuine real photos is
  weak, meaning the failures are concentrated in extraction quality on hard images, not in the
  matching logic swallowing real problems.
- **Real photos (10%) score far worse than degraded synthetic fixtures (44%)** — the reverse of what
  "degraded" implies, and the same inversion the `local-ocr` real-world eval work independently
  documented (see `docs/superpowers/specs/2026-07-24-local-ocr-prominence-and-confidence-design.md`
  and related eval history) for a different reason (image-preprocessing quality). Real-world label
  photography is the harder problem for every extraction backend tried so far in this project, not
  a `bedrock`-specific weakness.
- `netContents` and `countryOfOrigin` are perfect (100%), `alcoholContent` strong (96%); `brandName`
  and `healthWarningStatement` (65% each) and especially `nameAndAddress` (47%) are the weak fields
  — a similar shape to this project's other tiers, where brand name and multi-line free-text fields
  are consistently the hardest to extract reliably from real photography.

**Full gates re-run once more:** `pnpm typecheck && pnpm lint && pnpm test` clean, 303/303 tests
(unchanged by the `eval/run.ts` fix — no new test file added for it, matching the file's existing
no-unit-test precedent; validated instead by the two real re-runs above, which are the natural
integration test for a harness bug). `pnpm eval` (mock tier) re-confirmed at 100%.

---

## Model default changed (2026-07-24, same day)

The 13/46 (28%) Nova Lite result above prompted a same-day comparison against Nova Pro, Mistral
Pixtral Large, and Llama 4 Maverick — all reachable via the same adapter with just a `BEDROCK_MODEL`
override, no code change. Llama 4 Maverick won clearly (25/46, 54% — the only one to beat the
`local-ocr` baseline). `BEDROCK_MODEL`'s default was changed from `amazon.nova-lite-v1:0` to
`us.meta.llama4-maverick-17b-instruct-v1:0`. Full comparison table and reasoning:
`docs/superpowers/specs/2026-07-24-bedrock-nova-cloud-tier-design.md` §Model choice.
