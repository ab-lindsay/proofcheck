# bedrock cloud tier: Amazon Bedrock — design (2026-07-24)

> **Revision (same day, after initial ship):** the tier originally defaulted to Amazon Nova Lite
> (title/motivation below reflect that starting point). After shipping, a real-world-eval comparison
> against several other Converse-API-reachable Bedrock models found Nova Lite meaningfully
> underperforming this project's `local-ocr` baseline, and **Llama 4 Maverick** clearly ahead of
> every other option tried. `BEDROCK_MODEL`'s default was changed accordingly. See §Model choice
> (added below, after §Motivation) for the full comparison data and reasoning — the rest of this
> document (transport, adapter shape, selection, config, testing) is unchanged and model-agnostic.
>
> **Revision (2026-07-25, Claude access granted):** once Anthropic model access was provisioned on
> this account, **Claude Haiku 4.5** beat Llama 4 Maverick on accuracy (real photos 67% vs 33%,
> overall 76% vs 72-80%) while still clearing the 5s p95 latency budget (4431ms). `BEDROCK_MODEL`'s
> default was changed again, to `us.anthropic.claude-haiku-4-5-20251001-v1:0`. See the "Update
> (2026-07-25)" subsection under §Model choice for the full comparison, including why Claude Opus
> 4.5 (higher accuracy still) was rejected on latency grounds.

## Motivation

The `cloud` tier today has four adapters (`gemini`, `claude`, `openai`, `groq`), each a hosted vision LLM
gated by its own API key. Amazon Bedrock is a fifth such provider — the user has an active
`AWS_BEARER_TOKEN_BEDROCK` API key and a Bedrock deployment in `us-east-2`, and wants Amazon Nova Lite
1.0 (`amazon.nova-lite-v1:0`) as the underlying model. Nova Lite is Amazon's multimodal (image/video/text)
tier of the Nova 1.0 family — the only Nova 1.0 model without vision is Nova Micro — so it fits the
extraction task the same way the other cloud adapters do.

## Model choice (2026-07-24, after initial ship)

Nova Lite's real-world-set accuracy (see the plan's validation section) came in well below this
project's `local-ocr` baseline — 28% overall vs. 48%, and worse on genuine real photos specifically
(10% vs. 19%). Since `BEDROCK_MODEL` was already a config-only override and the adapter's transport
(Converse API, `bedrock-runtime.{region}.amazonaws.com`) is shared by many Bedrock-hosted models, a
quick comparison across several — all reachable with **zero code changes**, just a `BEDROCK_MODEL`
env override — was a cheap way to check whether the shortfall was Nova specifically or the tier's
approach generally:

| Model                                                         | Overall         | Real photos    | Degraded fixtures |
| ------------------------------------------------------------- | --------------- | -------------- | ----------------- |
| `local-ocr` (baseline, different tier)                        | 22/46 (48%)     | 4/21 (19%)     | 18/25 (72%)       |
| `amazon.nova-lite-v1:0` (original default)                    | 13/46 (28%)     | 2/21 (10%)     | 11/25 (44%)       |
| `us.amazon.nova-pro-v1:0`                                     | 15/46 (33%)     | **0/21 (0%)**  | 15/25 (60%)       |
| `us.mistral.pixtral-large-2502-v1:0`                          | 20/46 (43%)     | 3/21 (14%)     | 17/25 (68%)       |
| **`us.meta.llama4-maverick-17b-instruct-v1:0` (new default)** | **25/46 (54%)** | **7/21 (33%)** | **18/25 (72%)**   |

Two things stand out:

- **Scaling up within the Nova family didn't help the thing that matters.** Nova Pro beat Nova Lite
  overall (33% vs 28%), but every point of that gain came from the easier degraded/synthetic
  fixtures — real photos went from bad (10%) to _worse_ (0%). This was the signal that the
  shortfall was about the Nova vision encoder's fit for this specific label-photography task, not
  simply "too small a model."
- **Llama 4 Maverick is the only option tried that beats the `local-ocr` baseline outright**, on
  every axis (overall, real photos, and tied on degraded fixtures) — not a marginal edge, roughly
  1.7x local-ocr's real-photo accuracy. Per-field it's strong broadly: `alcoholContent` 46/46,
  `netContents` 45/46, `nameAndAddress` 33/36.

Claude (Anthropic) models were not part of this comparison — the AWS account this was tested against
had no Anthropic model access provisioned in Bedrock (`403: ... is not available for this account`),
a console-side model-access grant outside this project's control, not a code limitation. Structurally
Claude models on Bedrock use the same Converse API and `bedrock-runtime` endpoint this adapter already
speaks (confirmed via Claude Opus 4.8's model card), so if access is granted later, comparing it is
the same zero-code-change `BEDROCK_MODEL` override used above. Groq's real-world comparison (a
different cloud tier, not Bedrock) was inconclusive — its free-tier daily token quota was exhausted
after 7 of 46 entries.

### Update (2026-07-25): Claude access provisioned — comparison run

Anthropic model access has since been granted on this account. Two things worth recording for
whoever tries this next:

- **Model ID gotcha:** bare model IDs (`anthropic.claude-sonnet-4-5-20250929-v1:0`) 400 with
  `"Invocation of model ID ... with on-demand throughput isn't supported. Retry your request with
the ID or ARN of an inference profile that contains this model."` The fix is the `us.`-prefixed
  cross-region inference profile ID (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) — same
  `BEDROCK_MODEL` override, no code change, just the right string.
- **Newest model ≠ granted model:** the Bedrock foundation-models catalog lists
  `anthropic.claude-sonnet-5` as `ACTIVE` in-region, but invoking it 403s
  (`"anthropic.claude-sonnet-5 is not available for this account"`). Being listed in the catalog and
  having invoke access granted are two different things; check the latter empirically, not just the
  listing.

With that resolved, `--set real-world` results for the two Claude models that _were_ invokable:

| Model                                                           | Overall           | Real photos                     | Degraded        | Violations | Latency (p50/p95/max)                           |
| --------------------------------------------------------------- | ----------------- | ------------------------------- | --------------- | ---------- | ----------------------------------------------- |
| `us.meta.llama4-maverick-17b-instruct-v1:0` (previous default)  | 33-37/46 (72-80%) | ~33% (per original table above) | —               | 5/5        | within 5s budget                                |
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0`                  | 29/46 (63%)       | 8/21 (38%)                      | 21/25 (84%)     | 5/5        | not measured (lost on accuracy already)         |
| `us.anthropic.claude-opus-4-5-20251101-v1:0`                    | **41/46 (89%)**   | **17/21 (81%)**                 | **24/25 (96%)** | 5/5        | **6692/7586/7985 ms — FAILS the 5s p95 budget** |
| **`us.anthropic.claude-haiku-4-5-20251001-v1:0` (new default)** | **35/46 (76%)**   | **14/21 (67%)**                 | **21/25 (84%)** | 5/5        | **3654/4431/4646 ms — passes, ~570ms margin**   |

Opus 4.5 is the outright accuracy winner — far ahead of Maverick, especially on real photos (81% vs
33%) — but it isn't a viable default as-is: `pnpm check-latency --provider bedrock --set real-world`
puts it at roughly 1.5-2x the 5000ms p95 budget (Sarah's adoption-killer requirement), with every
percentile over budget, not just the tail. Sonnet 4.5 underperforms Maverick on accuracy and wasn't
worth latency-testing on that basis alone. **Haiku 4.5 is the model that actually clears both bars**
— it captures most of the Claude-family accuracy gain (real photos 67% vs Maverick's 33%) while
staying inside the latency budget, so `BEDROCK_MODEL`'s default was switched to it
(`lib/vision/cloud/bedrock.ts`).

**Models with vision support that were _not_ directly comparable** because they don't speak the
Converse API at all — Google Gemma 4 and OpenAI's GPT-5.5/5.6 on Bedrock are both `bedrock-runtime:
❌` / `Converse: ❌`, reachable only via a different host (`bedrock-mantle`) and a different API shape
(OpenAI-compatible Chat Completions or Responses, not Converse's `messages`/`inferenceConfig`).
Testing either would mean a second, structurally different adapter (closer in shape to `groq.ts` than
to this one), not a `BEDROCK_MODEL` swap — out of scope for this same-day comparison, left as a
candidate future tier if OpenAI's frontier-class vision models turn out to matter enough to justify
the extra adapter.

## Non-goals

- No changes to `lib/matching`, `lib/schema.ts`, or verdict logic — a new `VisionProvider` only.
- No SigV4 request signing, no IAM credential chain, no `@aws-sdk/client-bedrock-runtime` dependency —
  see §Design and §Alternatives considered for why.
- No support for other Bedrock-hosted models (Claude on Bedrock, Titan, etc.) — this adapter is scoped
  to the one model the user asked for. `BEDROCK_MODEL` makes swapping it a config change, not a code
  change, but no other model is tested here. _(Superseded by §Model choice above — several other
  Converse-reachable models WERE tried, via that same config-only override, the day this shipped.
  Non-Converse models — Gemma, OpenAI on Bedrock — remain untried, and would need a new adapter.)_
- No streaming (`ConverseStream`) — a single-label extraction call doesn't need it, and the other cloud
  adapters don't stream either.
- No CI wiring — like every cloud adapter, this never runs in CI (no live cloud calls in tests).

## Design

### 1. Transport: native `fetch`, not the AWS SDK

Amazon Bedrock API keys (bearer tokens) authenticate over plain HTTP: `Authorization: Bearer <token>`,
no request signing. AWS's own docs show a complete, self-contained `curl`/`requests` example against
`https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse` using only that header — no
AWS SDK, no credential provider. Separately, `@aws-sdk/client-bedrock-runtime` has a
[documented compatibility gap](https://github.com/aws/aws-sdk-js-v3/issues/7204): as of a recent
release the JS SDK did not reliably auto-detect `AWS_BEARER_TOKEN_BEDROCK`, requiring a manual
credential-provider workaround to inject the bearer token. Given a fully-documented REST contract
exists and the SDK path carries a real, unresolved version risk, this adapter uses `fetch` directly —
the same choice already made for `local-llm/ollama.ts`, and for the same reason: no new dependency, no
SDK-version gamble, the auth is a static bearer header well within `fetch`'s reach.

### 2. The adapter

New file `lib/vision/cloud/bedrock.ts`, structurally close to `ollama.ts` (hand-built `fetch` request,
`AbortController` timeout, non-OK throws) but posting to Bedrock's Converse API shape instead of
Ollama's native chat shape:

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
    const format = meta.mimeType.split("/")[1] ?? "png"; // "image/png" -> "png"

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

**Byte encoding — verified, not assumed:** AWS's docs say the Converse API takes image `bytes` as a
"byte array," which describes what the _SDK_ accepts as input (a `Uint8Array`) before it base64-encodes
the value onto the wire — Smithy `blob` shapes serialize to base64 strings in AWS's JSON-based
protocols. Building the JSON body directly (bypassing the SDK) means doing that encoding step
ourselves: `source.bytes` must be `image.toString("base64")`, a base64 **string**, not a JSON array of
byte values. `format` is derived from `meta.mimeType` (`"image/png"` → `"png"`) rather than hardcoded,
matching the four formats Nova's Converse schema accepts (`jpeg`, `png`, `webp`, `gif`).

### 3. Wiring into `select.ts`

```ts
import { bedrockProvider } from "@/lib/vision/cloud/bedrock";

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

`providerByName`'s unknown-provider error message gains `bedrock` in its expected-values list.

### 4. Selection: auto, like every other cloud tier

Unlike `local-llm` (no credential to gate on), Bedrock has a real API key, so it fits the existing
auto-selection chain exactly:

```ts
if (process.env.GROQ_API_KEY) return groqProvider;
if (process.env.AWS_BEARER_TOKEN_BEDROCK) return bedrockProvider;
return localOcrProvider;
```

Placed last among the cloud checks (lowest priority) since it's the newest addition — if a user has
multiple cloud keys set, the existing four are checked first, unchanged.

### 5. Configuration

Three new optional env vars:

| Var                        | Required?        | Default                 | Purpose                                                                                                          |
| -------------------------- | ---------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `AWS_BEARER_TOKEN_BEDROCK` | No (opt-in gate) | —                       | Bedrock API key. Presence auto-selects the `bedrock` tier.                                                       |
| `AWS_REGION`               | No               | `us-east-2`             | Bedrock region (per the user's account setup).                                                                   |
| `BEDROCK_MODEL`            | No               | `amazon.nova-lite-v1:0` | Bedrock model ID.                                                                                                |
| `BEDROCK_TIMEOUT_MS`       | No               | `30000`                 | Hard per-request bound — `fetch` has no built-in timeout, unlike the vendor SDKs the sibling cloud adapters use. |

`.env.example` gains a commented-out block; `ARCHITECTURE.md`'s Environment Variables table and the
`VISION_PROVIDER`/vocabulary/Decision-Summary/Directory-Layout mentions of the cloud tier gain
`bedrock` alongside `gemini`/`claude`/`openai`/`groq`.

### 6. Error handling

Non-2xx → throws with status + body before any JSON parse is attempted (fail closed, identical
pattern to every other adapter). Missing/invalid token → Bedrock returns 401/403, surfaced the same
way. Timeout → `AbortController` fires, `fetch` rejects. All of this propagates unwrapped out of
`extractWithModel`, exactly as designed for the other four cloud adapters — the `/api/verify` route's
existing fail-closed handling covers it; no new route code.

## Testing

- No dedicated adapter test file for the _transport-boilerplate_ reason (matching `gemini.ts` /
  `claude.ts` / `openai.ts` / `groq.ts`, none of which have one) — **except** this adapter hand-builds
  the HTTP request the way `ollama.ts` does, so it earns the same kind of request-contract test
  `ollama.ts` got: `lib/vision/cloud/bedrock.test.ts`, stubbing `fetch`, asserting the URL (region +
  model interpolated correctly), the `Authorization: Bearer` header, **`content[1].image.source.bytes`
  is a base64 string equal to `image.toString("base64")`** (the regression guard for the byte-encoding
  correction above — a plain array here would be silently wrong against the real API and only a test
  catches it), and a fail-closed case on a non-OK response.
- `select.test.ts`: one new case — `AWS_BEARER_TOKEN_BEDROCK` set (no `VISION_PROVIDER` override, no
  higher-priority key) selects `"bedrock"`.
- Real integration check is manual: `pnpm eval --provider bedrock` against the live Bedrock endpoint,
  using the token already in `.env.local`. Not part of `pnpm test` or CI.

## Alternatives considered

- **`@aws-sdk/client-bedrock-runtime` + `BedrockRuntimeClient`/`ConverseCommand`** — the "obvious"
  choice, and the one every official AWS code example uses. Rejected: it's a real new dependency
  (pulls in the AWS SDK v3 credential/middleware stack) for a service whose bearer-token auth is
  simpler than what the SDK is built around (SigV4-signed IAM credentials), and its handling of
  `AWS_BEARER_TOKEN_BEDROCK` specifically has an open compatibility report. The raw REST path is
  officially documented and sidesteps both problems.
- **SigV4-signed requests with IAM access keys** — not applicable; the user has a bearer-token API
  key, not IAM access/secret keys, and Bedrock's bearer-token auth mode exists specifically to avoid
  SigV4 signing.

## Known limitations (accepted, not solved here)

- `BEDROCK_MODEL` is user-configurable, but only `amazon.nova-lite-v1:0` has been considered/discussed
  here — switching models is a config change with no code-level guarantee of continued correctness
  (e.g. a text-only model like Nova Micro would silently degrade extraction, since nothing validates
  that the configured model is vision-capable).
- No validation that the account/region combination actually has Nova Lite access provisioned —
  a 403/404 from Bedrock surfaces as a normal fail-closed adapter error, same as any other
  authorization problem.
