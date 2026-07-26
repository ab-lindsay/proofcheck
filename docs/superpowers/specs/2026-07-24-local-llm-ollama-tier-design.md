# local-llm tier: Ollama + Qwen2.5-VL-3B — design (2026-07-24)

> **Revision history (same day, pre-implementation):**
>
> 1. First draft used Ollama's OpenAI-compatible `/v1/chat/completions` via the `openai` package
>    (mirroring `groq.ts`). Rejected after confirming — from
>    [Ollama's OpenAI-compat docs](https://docs.ollama.com/openai) and a
>    [known-truncation issue](https://github.com/openclaw/openclaw/issues/4028) — that the
>    OpenAI-compat endpoint **cannot** set `num_ctx` and silently caps context at a conservative
>    default (2048/4096). For a vision model that silently truncates the image's visual tokens,
>    producing confident-wrong extractions — the exact failure mode
>    `2026-07-24-local-ocr-prominence-and-confidence-design.md` exists to prevent. Moved to the
>    native `/api/chat` endpoint, which accepts `options.num_ctx`.
> 2. Second pass upgraded plain JSON mode (`format: "json"`) to **structured outputs** — the full
>    `ExtractedLabel` JSON schema passed as `format`, enforced by Ollama's grammar-constrained
>    sampling — after confirming zod 4 (`z.toJSONSchema`, in-repo at 4.4.3) and Ollama ≥ 0.5
>    (installed: 0.9.0) make it a zero-dependency one-liner. Also fixed env-var `NaN` handling,
>    base-URL trailing-slash handling, and documented the temp-0 retry redundancy and bbox-quality
>    caveat. See §"Alternatives considered".

## Motivation

The extraction tiers today are `mock | local-ocr | cloud`. `local-ocr` (Tesseract.js) is fully
keyless and air-gapped but is text OCR, not a vision-judgment model — no bounding boxes worth
trusting, no semantic understanding of layout. `cloud` gets both (bounding boxes, judgment, better
accuracy) but needs a hosted provider's API key. `README.md` already names the gap: _"a production
deployment would slot a self-hosted model into the cloud tier's place."_

Ollama running locally with a small vision-capable model (Qwen2.5-VL-3B) fills that gap: cloud-tier
extraction quality/shape (a real vision LLM, bounding boxes) without a network call to a third party
and without any API key — while still not being "zero setup" the way `local-ocr` is, since it
requires Ollama installed and the model pulled on the host. That distinction is real enough that it
gets its own tier name rather than folding into `cloud` (which per the vocabulary means "a hosted
provider needing a key") or `local-ocr` (which means "text OCR, no vision judgment").

## Non-goals

- No changes to `lib/matching`, `lib/schema.ts`, or any verdict logic — this is purely a new
  `VisionProvider` implementation. Invariant 1 (extraction proposes, matching disposes) is untouched.
- No auto-detection of a running Ollama instance. Selecting this tier is always explicit
  (`VISION_PROVIDER=local-llm`) — see §Selection for why.
- No changes to `eval/run.ts` — it already selects providers generically via `providerByName`, so
  `pnpm eval --provider local-llm` works with zero eval-harness changes.
- No image downscaling before the model. Ollama resizes internally for the vision encoder, and the
  raised `num_ctx` (see §Configuration) gives token headroom; adding a `sharp` downscale step here
  would duplicate `local-ocr`'s `prepareForOcr` for no measured benefit (YAGNI). The cloud adapters
  don't downscale either — consistency argues against it.
- No CI wiring — like the other model-backed tiers, this never runs in CI (no live model calls in
  tests, per the existing Testing Strategy table). It's a manual/local check only.

## Design

### 1. Promoting the shared extraction core

`lib/vision/cloud/core.ts` holds `EXTRACTION_PROMPT` and `extractWithModel` (the JSON-parse +
one-retry loop, shared today by `gemini.ts`/`claude.ts`/`openai.ts`/`groq.ts`). None of that logic is
actually cloud-specific — it's generic "call a chat-completions-shaped model, validate the JSON."
The `extractWithModel(call: () => Promise<string>)` seam is transport-agnostic: it takes a thunk that
returns the model's raw text and knows nothing about how that text was fetched. Now that `local-llm`
needs the same helper, it moves to `lib/vision/model-extraction.ts` (no logic changes, pure
relocation). The four existing cloud adapters update their import path only. Its test file moves with
it: `cloud/core.test.ts` → `model-extraction.test.ts` (same tests, same assertions).

### 2. The adapter

New file `lib/vision/local-llm/ollama.ts`, calling Ollama's native `POST /api/chat` with `fetch`
(built into Node 22 — no new dependency, and no `openai`-package fake-API-key hack). The native
endpoint provides the three things the OpenAI-compat path can't or won't:

- **`options.num_ctx`** — context headroom so the image's visual tokens aren't silently truncated.
- **Structured outputs** — the full `ExtractedLabel` JSON schema as `format`, which Ollama compiles
  to a sampling grammar: the model _cannot emit_ structurally invalid JSON. For a 3B model this is
  the single biggest reliability lever available, and it costs one line because zod 4 converts the
  existing schema (`z.toJSONSchema(ExtractedLabelSchema)`). Division of labor: the grammar enforces
  **structure** at generation time; Zod (inside `extractWithModel`) remains the authoritative
  boundary validator (invariant 3) for what grammars can't express — e.g. `confidence` ∈ [0, 1].
  The `EXTRACTION_PROMPT` still carries the **semantics** (verbatim transcription, never guess,
  untrusted-data framing) — schema and prompt are complements, not duplicates.
- **A clean timeout hook** — `AbortController`, so a stuck local model fails closed.

Native chat images are base64 **without** a `data:` prefix, passed in the message's `images` array.
The raw `message.content` string is handed to the shared `extractWithModel`, so fence-stripping, Zod
validation, and the one-retry loop are identical to every other tier.

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

`_meta` is unused: unlike the base64 `data:${mimeType};base64,...` URI the cloud adapters build, the
native API takes bare base64 in `images[]` and infers the type itself, so `meta.mimeType` isn't
needed. (`meta` stays in the signature — it's part of the `VisionProvider` interface.)

**Retry under temperature 0 (accepted redundancy):** structured outputs make structurally invalid
JSON nearly impossible, so `extractWithModel`'s retry only fires on the residual — a schema-shaped
response that still fails Zod (e.g. an out-of-range `confidence`). With `temperature: 0` that retry
re-runs an identical generation and will likely fail identically, then fail closed with
`ExtractionError`. Accepted: worst case is bounded at ~2× `OLLAMA_TIMEOUT_MS`, determinism is worth
more to the eval harness than a coin-flip second chance, and special-casing this adapter out of the
shared retry loop would fork the one code path every tier shares.

### 3. Wiring into `select.ts`

```ts
import { localLlmProvider } from "@/lib/vision/local-llm/ollama";

const PROVIDERS: Record<string, VisionProvider> = {
  mock: mockProvider,
  "local-ocr": localOcrProvider,
  "local-llm": localLlmProvider,
  gemini: geminiProvider,
  claude: claudeProvider,
  openai: openaiProvider,
  groq: groqProvider,
};
```

The unknown-provider error message in `providerByName` is updated to list `local-llm` in its
expected set.

### 4. Selection: explicit only

Unlike the cloud adapters, there's no API key whose presence can drive auto-selection, and probing
`localhost:11434` during tier selection would mean a network call (and a live-or-not branch) on every
request just to decide routing. `selectProvider()` gets no new auto-detect branch — `local-llm` is
reachable only via the existing forced-tier path (`VISION_PROVIDER=local-llm`), the same mechanism as
forcing `mock` or `local-ocr` today. Failure modes all propagate unwrapped out of `extractWithModel`
by design (identical to how a cloud 401/429 propagates today):

- **Ollama not running** → `fetch` rejects (connection refused).
- **Model not pulled** → `res.ok` is false (404) → the adapter throws with the status + body.
- **Model hangs past the timeout** → `AbortController` fires → `fetch` rejects with an abort error.

The `/api/verify` route's existing fail-closed handling turns any of these into a REVIEW/error per
label, never a silent PASS. No new error-handling code in the route is needed.

### 5. Configuration

Four new optional env vars:

| Var                 | Required? | Default                  | Purpose                                                                                                                        |
| ------------------- | --------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `OLLAMA_BASE_URL`   | No        | `http://localhost:11434` | Ollama host (native API base; the adapter appends `/api/chat`; trailing slashes tolerated).                                    |
| `OLLAMA_MODEL`      | No        | `qwen2.5vl:3b`           | Model tag to run.                                                                                                              |
| `OLLAMA_NUM_CTX`    | No        | `8192`                   | Context window. Must cover image tokens + prompt + output; the default gives comfortable headroom for one label on a 3B model. |
| `OLLAMA_TIMEOUT_MS` | No        | `60000`                  | Hard bound on a single request so a stuck model fails closed instead of hanging.                                               |

The two numeric vars fall back to their defaults on any non-positive-integer value (see `envInt` —
a typo'd env var must not produce a baffling insta-abort). `.env.example` gains commented-out lines
for all four, following the existing `# ENABLES_X` comment style. `ARCHITECTURE.md`'s Environment
Variables table gains a row for each, and `VISION_PROVIDER`'s row's expected-values list gains
`local-llm`.

### 6. Latency & the < 5 s budget

The single-label budget (< 5 s end-to-end) is a first-class project constraint, and a 3B vision
model on Ollama is the tier most at risk of missing it — inference time depends entirely on the host
(GPU vs CPU, VRAM, whether the model is warm in memory). This is treated the way `local-ocr`'s cold-
start risk was: **measured, not assumed.** After implementation, run
`pnpm eval --provider local-llm` and record warm/cold per-label timing in the plan's validation step
(the same spirit as the `pnpm spike:ocr` numbers in `ARCHITECTURE.md`'s Risks table). Ollama's
default `keep_alive` keeps the model resident for ~5 minutes after a request, so an eval sweep or a
batch pays the model-load cost once, not per label — no code needed for that.

Honest positioning, carried into the docs: **local-llm is a local-dev / air-gapped-server option,
not the deployed demo path.** The Vercel deployment has no local Ollama, so the deployed URL's
accuracy path stays `cloud`; the 5 s budget is enforced against that path via the `check-latency`
skill. local-llm's job is "keyless vision extraction on a machine you control," where a first
(cold/model-load) request slower than 5 s is acceptable and bounded by `OLLAMA_TIMEOUT_MS`.

### 7. Docs

- `ARCHITECTURE.md`: vocabulary table's **Tier** row becomes `mock | local-ocr | local-llm | cloud`;
  the **AI / extraction** row in the Decision Summary mentions the local-llm tier; Directory Layout
  gains `lib/vision/local-llm/ollama.ts` and reflects the `cloud/core.ts` → `model-extraction.ts`
  rename; Dependency Manifest note: **no new dependency** (native `fetch`; schema conversion is
  zod 4's built-in `z.toJSONSchema`).
- `README.md`: the tier table gains a `local-llm` row (needs: Ollama installed + `qwen2.5vl:3b`
  pulled; what it does: vision-LLM extraction, fully local, no API key).
- Both docs note the tier is keyless but **not** zero-setup, unlike `local-ocr` — it needs Ollama
  running locally with the model pulled (`ollama pull qwen2.5vl:3b`).

## Testing

- `model-extraction.test.ts` (renamed from `cloud/core.test.ts`): unchanged tests, new location.
- `select.test.ts`: one new case — `VISION_PROVIDER=local-llm` selects the provider named
  `"local-llm"` — following the existing `VISION_PROVIDER forces a tier` test shape.
- **`local-llm/ollama.test.ts` (new).** Unlike the SDK-based cloud adapters (which delegate all
  request plumbing to a vendor SDK and so have no adapter-level tests), this adapter hand-assembles
  the HTTP request and parses the response, so that plumbing earns a test. With `fetch` stubbed via
  `vi.stubGlobal` (no live Ollama):
  - **Request contract:** posts to `…/api/chat`; body has `format` carrying the JSON schema (assert
    all seven field keys appear under `format.properties`), `options.num_ctx > 0`, and
    `messages[0].images[0]` equal to the image's bare base64 (no `data:` prefix). This is the
    regression guard for the truncation + structure fixes — it locks `num_ctx` and the schema into
    the request.
  - **Happy path:** a stubbed `{ message: { content: <valid ExtractedLabel JSON> } }` round-trips
    through `extractWithModel` to a parsed `ExtractedLabel` (reuse a `MOCK_FIXTURES` entry as the
    canned content, exactly as `model-extraction.test.ts` does).
  - **Fail closed:** a stubbed non-OK response (404) makes `.extract()` reject (never returns a
    fabricated pass).
  - **Env sanitization:** with `OLLAMA_NUM_CTX=abc` stubbed, the request body still carries the
    default `num_ctx` (8192), not `null`.
- Real integration check is manual: `pnpm eval --provider local-llm` against the running local
  Ollama (already pulled: `qwen2.5vl:3b`, confirmed via `ollama list`). Not part of `pnpm test` or
  CI. Record warm/cold timing here per §6.

## Alternatives considered

- **OpenAI-compat endpoint (`/v1/chat/completions`) via the `openai` package** — the first draft's
  approach, structurally identical to `groq.ts`. Rejected: Ollama's OpenAI-compat layer does not
  accept `num_ctx` and silently caps context at a conservative default (2048/4096), truncating a
  vision request's image tokens and yielding confident-wrong extractions. It also requires a
  placeholder API key (the SDK demands a truthy value) and offers no clean timeout hook. The native
  API removes all three problems and adds no dependency. The only thing lost is surface-level
  symmetry with the four SDK adapters, which is not worth a known correctness defect.
- **Custom `Modelfile` bumping `num_ctx`, kept on OpenAI-compat** — would fix truncation while
  keeping the SDK adapter, but adds an out-of-band `ollama create` setup step, means the tier does
  not work against the plain `qwen2.5vl:3b` tag the user already pulled, and still leaves the
  fake-key/timeout warts. Native API is simpler and works out of the box.
- **Plain JSON mode (`format: "json"`) instead of the full schema** — the second draft's choice.
  Superseded: zod 4's built-in `z.toJSONSchema` makes grammar-level structure enforcement free (no
  new dependency, no hand-written schema duplicating `ExtractedLabelSchema`), and for a 3B model,
  malformed/mis-shaped JSON is the top reliability risk. JSON mode remains the one-line fallback if
  Ollama's schema-to-grammar conversion ever misbehaves on this schema (none of its constructs —
  objects, nullable strings, numbers, booleans — are exotic).

## Known limitations (accepted, not solved here)

- Requires Ollama installed and the model pulled on whatever machine runs the app — useless on
  Vercel's deployment target (no local Ollama there). It's a local-dev / air-gapped-server option,
  not something the hosted demo can use; `cloud` remains the accuracy path for the deployed URL.
- No warm-up handling — the first request after Ollama has evicted the model from memory pays the
  model-load cost and may exceed the 5 s budget; bounded by `OLLAMA_TIMEOUT_MS` and accepted per §6.
- **Bounding-box quality is unvalidated for this model.** Qwen2.5-VL's grounding training uses
  absolute pixel coordinates; the shared prompt asks for 0..1 fractions of the image, and a 3B model
  may produce noisy or quantized boxes. Safe by architecture: the field-of-vision check that consumes
  boxes is advisory (REVIEW, never FAIL), and `BoundingBoxSchema` rejects out-of-range values — a bad
  box degrades one field to REVIEW, never a wrong verdict. Measure alongside accuracy in the eval run.
- `OLLAMA_NUM_CTX` is a fixed headroom default, not computed from the actual image. A pathologically
  large label could still exceed it; the fail-closed path (low-confidence → REVIEW, never silent
  PASS) covers the residual, and the default is generous for the single-label workflow.
