# Dev-mode warning prompt + tier switcher — design (2026-07-25)

## Motivation

Dev mode (shipped 2026-07-24, see `docs/superpowers/specs/2026-07-24-uswds-inspired-theme-design.md`
Task 11) gates the health-warning character-diff view behind a header switch, off by default. Two
follow-up needs surfaced immediately after shipping:

1. **The switch is a single click away with no friction.** A casual user clicking around the header
   (theme toggle, nav links) could land on it by accident and see a debugging view they don't need —
   contrary to the "usable by a non-technical 73-year-old" bar (`CLAUDE.md`). It needs a small amount
   of deliberate friction, not full concealment (developers/testers still need to find and use it).
2. **No way to compare extraction tiers from the UI.** Tier selection (`lib/vision/select.ts`) is
   entirely server-side today — `VISION_PROVIDER` env var, or auto-detected from which cloud API key
   is set. A developer wanting to see how `local-ocr` handles a real upload, on a deployment where a
   cloud key is configured, currently has no way to do that without changing server config. A small,
   dev-mode-only switcher closes that gap.

## Non-goals

- **Bring-your-own-API-key** (letting a user supply their own cloud credential per-request) is a
  separate, larger feature with its own security review (client-supplied credential transport, abuse
  considerations, UI for entering/never-persisting a key). Explicitly deferred to a follow-up
  brainstorm — not designed or built here.
- **No change to which cloud provider `selectProvider` treats as default** among Gemini/Claude/OpenAI/
  Groq/Bedrock — that priority order is unchanged. Adding `AWS_BEARER_TOKEN_BEDROCK` to the deployed
  environment (so Bedrock becomes the operative cloud provider there) is a Vercel env-var change, not
  a code change, and is out of scope for this document.
- **No live health check for Local LLM.** Whether Ollama is actually reachable can't be known cheaply
  from the server's env vars the way "is a cloud key set" can. The switcher does not probe it — see
  Error Handling.
- **No change to the bundled-sample mock shortcut.** Sample images resolve to the `mock` tier by
  default, unless `devTier` is explicitly set — matching the existing precedent where a forced
  `VISION_PROVIDER` env var also bypasses the mock-sample shortcut today (`lib/vision/select.ts`'s
  `forced` branch runs before the `isMockSample` check) — kept consistent with that precedent, not
  changed here.

## Architecture

**Warning prompt.** `DevModeToggle` (`components/dev-mode-toggle.tsx`) gains a confirmation step.
Clicking it while off opens `<DevModeConfirm>`, a small dialog ("Dev mode reveals technical debugging
tools — Cancel / Enable"); `setDevMode(true)` fires only on explicit confirmation. Clicking it while
on turns off immediately — disabling has no risk, so no prompt.

**Tier switcher.** A new `<TierSwitcher>` renders in the header next to `<DevModeToggle>`, mounted
only when dev mode is on. It reads/writes a new `useDevTier()` hook — same `useSyncExternalStore` +
localStorage pattern as `hooks/use-dev-mode.ts`, key `"devTier"`, values `"local-ocr" | "local-llm" |
"cloud"`, defaulting to `"cloud"` when nothing is stored (matches today's own auto-detection
preference order, where a configured cloud key already wins over local-ocr).

**Request flow.** `useVerify` and `useBatch` — the two hooks that POST to `/api/verify` — read
`useDevTier()` and, only when dev mode is also on, append a `devTier` field to the multipart form
body alongside the existing `image`/`application`/`source` fields. `app/api/verify/route.ts` reads
`devTier`: if present and one of the three valid values, it selects that provider directly instead of
running `selectProvider`'s auto-detection; if absent, malformed, or dev mode is off, behavior is
byte-identical to today.

**Fallback.** Whenever the effective tier is `cloud` — whether via `devTier=cloud` or today's default
auto-detection when `devTier` is absent — the extraction call goes through a new `withFallback`
wrapper: try the cloud provider, and if it throws, retry once with `local-ocr`. This applies globally,
not only when dev mode is on, since cloud outages/rate-limits are a real-world concern for every user,
not just testers.

```
Header: [DEV switch] → click → <DevModeConfirm> → confirm → devMode=true (localStorage)
                                                            → <TierSwitcher> mounts
                                                              (reads/writes devTier, localStorage)

useVerify/useBatch: build FormData
  devMode? → append devTier field
  POST /api/verify

route.ts:
  devTier present & valid?
    "local-ocr" → localOcrProvider.extract()
    "local-llm" → localLlmProvider.extract()  (no fallback — explicit choice, fails clearly)
    "cloud"     → withFallback(cloudProvider, localOcrProvider).extract()
  devTier absent/invalid → selectProvider(sampleName) as today
                            (if that resolves to a cloud provider → still wrapped in withFallback)
```

## Components

**New files:**

- `hooks/use-dev-tier.ts` + `hooks/use-dev-tier.test.ts` — `export type DevTier = "local-ocr" |
"local-llm" | "cloud"`; `useDevTier(): DevTier`; `setDevTier(value: DevTier): void`. Structurally
  identical to `hooks/use-dev-mode.ts` (module-level listener `Set`, `useSyncExternalStore`,
  `getServerSnapshot` returns `"cloud"`).
- `components/dev-mode-confirm.tsx` + test — a native `<dialog>` element (built-in focus trap and
  Escape-to-close, zero new dependency), styled with existing tokens. Props: `open: boolean`,
  `onConfirm: () => void`, `onCancel: () => void`. Copy: a short sentence explaining dev mode reveals
  a technical view, plus Cancel/Enable buttons.
- `components/tier-switcher.tsx` + test — three-way segmented control, visually matching
  `ThemeToggle`'s `role="radiogroup"` of `role="radio"` buttons pattern. Local OCR and Local LLM are
  always enabled. Cloud is disabled (`aria-disabled="true"` + a `title` tooltip reason) when the
  client has learned no cloud provider is configured (see below).
- `lib/vision/fallback.ts` + test — `export function withFallback(primary: VisionProvider, fallback:
VisionProvider): VisionProvider`. Pure composition: returns a `VisionProvider` whose `name` is
  `primary.name`, whose `extract()` calls `primary.extract()`, and on rejection calls
  `fallback.extract()` instead. Independently unit-testable with two stub providers.

**Cloud availability (client-side).** The client can't read server env vars directly. `TierSwitcher`
fetches a new lightweight `GET /api/verify` endpoint (added alongside the existing `POST` handler in
`route.ts`) once, when dev mode turns on, returning `{ cloudAvailable: boolean }` — computed by
checking the same env vars `selectProvider` already checks (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GROQ_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`), without exposing which one or any key
material. The result is held in `TierSwitcher`'s local component state (not persisted) — dev mode
being off unmounts the switcher, so it's naturally re-checked each time dev mode is turned back on.

**Modified files:**

- `components/dev-mode-toggle.tsx` — render `<DevModeConfirm>`, gate `setDevMode(true)` on its
  confirmation.
- `app/layout.tsx` — mount `<TierSwitcher />` next to `<DevModeToggle />`, conditionally on
  `useDevMode()`.
- `hooks/use-verify.ts` — read `useDevMode()` + `useDevTier()` at the top of the hook (valid: hooks
  can call other hooks) and append `devTier` to the `FormData` when dev mode is on.
- `hooks/use-batch.ts` — `verifyOne` is a plain async function, not a hook, so it cannot call
  `useDevTier()`/`useDevMode()` itself. Instead, `useBatch()` (the hook, where calling other hooks is
  valid) reads `useDevMode()` + `useDevTier()` once and passes the resolved `devTier: DevTier |
undefined` into `verifyOne(row, file, devTier)` as a parameter, which sets the `FormData` field the
  same way `useVerify` does.
- `app/api/verify/route.ts` — read `form.get("devTier")`, validate against the three known values,
  branch provider selection accordingly (see Architecture); add the new `GET` handler; wrap cloud
  calls (both `devTier="cloud"` and today's auto-detected-cloud path) in `withFallback`.
- `lib/vision/select.ts` — no signature change; `withFallback` lives in its own file to keep
  `select.ts` focused on provider lookup/auto-detection, not retry policy.

## Error Handling

- **Local LLM explicitly requested, extraction fails:** no automatic fallback — picking this tier is
  a deliberate choice to test it, so a failure should be visible, not silently masked by a different
  tier's result. `route.ts` gets a dedicated catch branch: when `devTier === "local-llm"` and the
  call throws, return a clear message naming the problem (e.g. "Local LLM extraction failed — is
  Ollama running and reachable?") instead of the existing generic catch-all ("Could not analyze this
  label image...").
- **Cloud explicitly requested, nothing configured server-side (defense in depth):** the UI disables
  this case, but the server re-validates independently — `devTier === "cloud"` with no cloud env var
  set returns a clear `400` ("Cloud tier requires an API key configured on the server"), never a
  silent substitution. UI disabling is the primary defense; this is the backstop for a stale UI state
  or a direct API call.
- **Cloud configured but the live call fails (any cause — network, rate limit, outage):**
  `withFallback` retries with `local-ocr` and the request succeeds. Per the existing principle that a
  response is always honest about what actually produced it (the current code already appends a
  warning when the `local-ocr` tier itself runs), the response's `warnings` array gets an additional
  entry: "Cloud extraction failed — fell back to local OCR." The tester (or any user, since this
  applies globally) can see a fallback happened, not just get a quietly-substituted result.
- **Malformed/unrecognized `devTier` value:** treated as absent — falls back to today's normal
  `selectProvider` auto-detection. A bad client value is never a hard request-level error, since the
  field is only a preference.
- **`GET /api/verify` failing or being slow:** `TierSwitcher` treats a failed/erroring fetch the same
  as `cloudAvailable: false` (Cloud stays disabled) rather than assuming availability — consistent
  with the project's fail-closed invariant (`CLAUDE.md` #7), applied here to a UI affordance rather
  than a verdict.

## Testing

- `hooks/use-dev-tier.test.ts` — mirrors `use-dev-mode.test.ts`: defaults to `"cloud"` with nothing
  stored, reflects a stored value, notifies every subscribed instance on `setDevTier`.
- `components/dev-mode-confirm.test.tsx` — dialog renders when `open`, `onCancel`/`onConfirm` fire on
  the respective buttons, Escape triggers cancel.
- `components/dev-mode-toggle.test.tsx` (extended) — clicking while off opens the confirm dialog and
  does NOT call `setDevMode` until confirmed; clicking while on calls `setDevMode(false)` immediately,
  no dialog.
- `components/tier-switcher.test.tsx` — all three options render; Cloud is `aria-disabled` when
  `cloudAvailable: false`; selecting an option calls `setDevTier` and persists it; renders nothing
  (or is simply not mounted) when dev mode is off — covered at the `app/layout.test.tsx` level.
- `lib/vision/fallback.test.ts` — pure unit tests with two stub `VisionProvider`s: primary resolves →
  fallback's `extract` is never called; primary rejects → fallback is called once and its result is
  returned; primary rejects and fallback also rejects → the fallback's rejection propagates (no
  swallowing a second failure).
- `app/api/verify/route.test.ts` (extended) — `devTier="local-ocr"`/`"local-llm"` route to the right
  provider bypassing auto-detection; `devTier="cloud"` with a key configured succeeds; `devTier=
"cloud"` with nothing configured returns 400; a forced cloud-provider failure (mocked to reject)
  with `devTier="cloud"` returns a 200 with the local-ocr result and the new warning text; a forced
  local-llm failure with `devTier="local-llm"` returns the dedicated clear error message; malformed
  `devTier` values fall through to today's behavior unchanged; new `GET` handler returns
  `cloudAvailable: true/false` matching whichever env vars are stubbed.
- Full regression: `pnpm test && pnpm typecheck && pnpm lint`, plus `pnpm eval` to confirm no
  `lib/matching`-adjacent behavior changed (this design touches only `lib/vision` and the API route's
  provider-selection branch, never `lib/matching` or `lib/ttb`).

## Alternatives considered

- **Query param instead of a form field for `devTier`:** rejected — the existing request is already
  multipart form data; a form field fits without adding URL-construction logic on the client.
- **Inlining the cloud→local-ocr retry directly in `route.ts`** instead of a `withFallback` wrapper:
  rejected — tangles retry policy into the route handler and is harder to unit-test in isolation than
  a small pure composition function, inconsistent with how `lib/matching` is built (pure,
  independently tested units).
- **Tier switcher inline in each verify form** (single-label page, batch page) instead of the header:
  rejected — it's one global testing preference, not something that varies per-upload; a header-level
  control backed by a shared hook avoids building and wiring the same control twice.
- **Live Ollama health check** to gray out Local LLM: rejected for this round — adds a network
  round-trip and a second source of staleness (the check could pass and the actual call still fail a
  moment later). "Always enabled, fails clearly" gives an equally honest signal with less machinery.
- **Native `window.confirm()`** for the dev-mode warning: rejected — visually inconsistent with the
  design system just shipped; a small custom dialog costs little more and fits the app's polish bar.
