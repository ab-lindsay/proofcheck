# Bedrock model picker — design (2026-07-25)

## Motivation

Dev mode already has a tier switcher (auto/local-ocr/local-llm/cloud) and an escalation toggle (off/on).
Adding a Bedrock model picker extends this pattern to demonstrate the accuracy/latency/cost tradeoff
that the Bedrock cloud tier evaluation explored — letting a reviewer switch between Claude Haiku 4.5
(fast, passes 5s budget) and Claude Opus 4.5 (highest accuracy, exceeds budget) without a redeploy.

This directly shows the reasoning behind the default model choice (Haiku 4.5) and makes the
tradeoff explicit rather than hidden in an env var.

## Non-goals

- **No provider-agnostic model selection** — Bedrock-only for now. A BYOK (bring-your-own-key)
  feature with model selection across providers is a separate, larger scope.
- **No runtime budget enforcement** — the picker is a deliberate override, not a bug. Visual
  indicators and tooltip text are the warnings, same as the escalation toggle.
- **No token usage/cost display** — deferred to a follow-up feature. The model metadata (speed,
  cost tier, accuracy tier) in tooltips provides the foundation for that.
- **No change to `lib/matching`, `lib/schema.ts`, or verdict logic** — a new dev-mode affordance only.

## Architecture

### Model list

Two Claude models, selected for the cleanest accuracy/latency tradeoff:

| Key     | Full Model ID                                 | Display Name | Speed   | Cost    | Accuracy   | Budget Status            |
| ------- | --------------------------------------------- | ------------ | ------- | ------- | ---------- | ------------------------ |
| `haiku` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Haiku 4.5    | Fastest | Lowest  | Good (76%) | Passes (4431ms p95)      |
| `opus`  | `us.anthropic.claude-opus-4-5-20251101-v1:0`  | Opus 4.5     | Slowest | Highest | Best (89%) | **Exceeds (7586ms p95)** |

**Why not Sonnet 4.5?** It underperformed Maverick on accuracy (63% vs 72-80%) and wasn't
worth latency-testing on that basis alone. Including it would dilute the clean Haiku/Opus tradeoff.

**Why not Nova Lite?** It performed poorly (28% overall, 10% real photos) and including it as a
"bad example" adds noise without improving the demo.

### UI component

A segmented control in the header, mounted only when dev mode is on, positioned next to the
tier switcher.

**Layout:**

```
[Haiku 4.5] [Opus 4.5]
```

**Behavior:**

- **Haiku 4.5** (default): Shows as selected with primary background color
- **Opus 4.5**: When selected, shows with a visual warning indicator (amber/yellow background
  instead of primary color) to signal it exceeds the 5s budget — same framing as the escalation
  toggle's "ON" state
- **Tooltips**: Hovering shows metadata:
  - Haiku: "Fastest, lowest cost — passes 5s p95 budget (4431ms)"
  - Opus: "Highest accuracy (89%) — **exceeds 5s p95 budget (7586ms)**"

**State management:**

- New hook: `hooks/use-dev-model.ts` following the same `useSyncExternalStore` + localStorage
  pattern as `hooks/use-dev-tier.ts` and `hooks/use-dev-escalation.ts`
- Storage key: `devBedrockModel`
- Default: `haiku` (maps to the full model ID server-side)
- Type: `DevBedrockModel = "haiku" | "opus"`

### Data flow

**Current flow:**

1. Client sends image + application data to `POST /api/verify`
2. Route reads `process.env.BEDROCK_MODEL` once, server-side
3. Uses that model for all requests

**New flow:**

1. Client sends image + application data + `devBedrockModel` field (when dev mode is on)
2. Route reads `devBedrockModel` from form data
3. If present and valid, maps to full model ID:
   ```ts
   const MODEL_MAP: Record<DevBedrockModel, string> = {
     haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
     opus: "us.anthropic.claude-opus-4-5-20251101-v1:0",
   };
   ```
4. Passes model ID to `bedrockProvider.extract()` via a new optional parameter

**Implementation detail:**

- `bedrockProvider.extract()` currently reads `process.env.BEDROCK_MODEL` internally
- Modified to accept an optional `modelOverride?: string` parameter
- If provided, uses it instead of `process.env.BEDROCK_MODEL`
- Pattern: similar to how `devTier` is passed — form data field read in route, passed to provider

**Fallback:**

- If `devBedrockModel` is absent or invalid, use `process.env.BEDROCK_MODEL` (existing behavior)
- If dev mode is off, `devBedrockModel` is never sent (existing pattern)

## Components

**New files:**

- `hooks/use-dev-model.ts` + `hooks/use-dev-model.test.ts` — `export type DevBedrockModel = "haiku" |
"opus"`; `useDevBedrockModel(): DevBedrockModel`; `setDevBedrockModel(value: DevBedrockModel): void`.
  Structurally identical to `hooks/use-dev-tier.ts`.
- `components/model-picker.tsx` + `components/model-picker.test.tsx` — segmented control with two
  options, visual warning for Opus, tooltips with metadata. Follows `TierSwitcher`'s pattern.

**Modified files:**

- `lib/vision/cloud/bedrock.ts` — `extract()` gains optional `modelOverride?: string` parameter.
  When provided, uses it instead of `process.env.BEDROCK_MODEL`. Default behavior unchanged.
- `app/api/verify/route.ts` — reads `devBedrockModel` from form data, validates against known
  values, maps to full model ID, passes to `bedrockProvider.extract()` when present.
- `hooks/use-verify.ts` — reads `useDevMode()` + `useDevBedrockModel()` and appends
  `devBedrockModel` to the `FormData` when dev mode is on.
- `hooks/use-batch.ts` — `useBatch()` reads `useDevMode()` + `useDevBedrockModel()` and passes
  `devBedrockModel` into `verifyOne()` as a parameter.
- `app/layout.tsx` — mount `<ModelPicker />` next to `<TierSwitcher />`, conditionally on
  `useDevMode()`.

## Error Handling

- **Model override invalid:** if `devBedrockModel` is present but not one of the valid values
  (`haiku`, `opus`), treat as absent — fall back to `process.env.BEDROCK_MODEL` (existing behavior).
  Never a hard error.
- **Model call fails:** same as today: `bedrockProvider.extract()` throws, `withFallback` retries
  with `local-ocr`, warning appended to response. No special handling needed — the model picker
  doesn't change error behavior.
- **Budget exceeded (Opus):** no runtime enforcement — the picker is a deliberate override, not a
  bug. Visual indicator (amber background) and tooltip text ("exceeds 5s p95 budget") are the
  warnings. Same principle as escalation toggle: "this is a deliberate override, not the shipped
  behavior."
- **Dev mode off:** model picker unmounts, `devBedrockModel` is never sent, server uses
  `process.env.BEDROCK_MODEL`.

## Testing

- `hooks/use-dev-model.test.ts` — mirrors `use-dev-tier.test.ts`: defaults to `"haiku"` with
  nothing stored, reflects a stored value, notifies every subscribed instance on `setDevModel`.
- `components/model-picker.test.tsx` — both options render; Haiku is default; selecting an option
  calls `setDevModel` and persists it; Opus shows visual warning indicator; renders nothing when
  dev mode is off.
- `app/api/verify/route.test.ts` (extended) — `devBedrockModel="haiku"` routes to Haiku model ID;
  `devBedrockModel="opus"` routes to Opus model ID; `devBedrockModel` absent falls back to
  `process.env.BEDROCK_MODEL`; malformed `devBedrockModel` falls back to existing behavior.
- Manual verification: `pnpm eval --provider bedrock` with each model to confirm accuracy/latency
  matches spec data. Visual check: model picker appears in header when dev mode is on, Opus shows
  warning indicator.
- Full regression: `pnpm test && pnpm typecheck && pnpm lint`, plus `pnpm eval` to confirm no
  `lib/matching`-adjacent behavior changed.

## Alternatives considered

- **Dropdown/select menu:** more space for metadata, but different pattern from existing controls.
  The tier switcher and escalation toggle both use segmented controls; matching that pattern keeps
  the header consistent.
- **Confirmation dialog for Opus:** would add friction for a deliberate override. The escalation
  toggle already establishes the precedent: visual indicator + tooltip text is sufficient warning.
- **All three Claude models (Haiku + Sonnet + Opus):** Sonnet underperformed Maverick on accuracy
  and wasn't worth including. Two models give the cleanest tradeoff demo.
- **Include Nova Lite as a "bad example":** adds noise without improving the demo. The eval data
  in the Bedrock design spec already documents its poor performance.
