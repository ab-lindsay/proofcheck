# ProofCheck — Full Sweep: Bugs, Test Coverage, Brief Alignment (2026-07-24)

**Method:** Seven parallel per-dimension finders (matching/TTB logic, vision-tier code, security,
UI/hooks, test coverage, brief alignment, factual accuracy) — Haiku generating candidate findings,
each independently **adversarially verified** by a second Sonnet reviewer that read the current file
and either confirmed or refuted the claim against the live code, the prior 2026-07-21/22/23/24 audits,
and the project's documented accepted trade-offs. 19 raw findings → **13 confirmed**, 6 refuted as
already-fixed or false-positive.

**Result:** 0 new bugs in matching/TTB logic, UI/hooks, or security — the 2026-07-21/22 security
remediation still holds, and the newest surface (Bedrock, Ollama, local-ocr preprocessing) introduced
no fresh exploit. All findings below are resolved as of this pass.

> **Resolution status (verified 2026-07-24): 12 of 12 documented findings fixed**, plus one
> incidental lint-config gap found during verification.
>
> | #   | Finding                                                                         | Severity | Status   | Resolution                                                                                                                                                                                       |
> | --- | ------------------------------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
> | 1   | README shipped the literal `<DEPLOY_URL>` placeholder                           | Critical | ✅ Fixed | Replaced with the verified-live `https://proofcheck-blush.vercel.app` (confirmed served without an SSO wall, unlike the `-ustreasury` alias)                                                     |
> | 2   | Bedrock fetch timeout/abort path untested                                       | High     | ✅ Fixed | Fake-timer test in `bedrock.test.ts` proves the abort actually fires at `BEDROCK_TIMEOUT_MS`                                                                                                     |
> | 3   | Ollama fetch timeout/abort path untested                                        | High     | ✅ Fixed | Same pattern added to `ollama.test.ts`                                                                                                                                                           |
> | 4   | No test file for `lib/vision/cloud/claude.ts`                                   | High     | ✅ Fixed | New `claude.test.ts`; also added a fail-fast guard for a missing/blank `ANTHROPIC_API_KEY` (previously relied on the SDK's lazy, generic error)                                                  |
> | 5   | No test file for `lib/vision/cloud/openai.ts`                                   | High     | ✅ Fixed | New `openai.test.ts`, including the `choices[0]` indexing edge cases                                                                                                                             |
> | 6   | No test file for `lib/vision/cloud/groq.ts`                                     | High     | ✅ Fixed | New `groq.test.ts`, including the `reasoning_effort: "none"` Qwen workaround                                                                                                                     |
> | 7   | Brief's <5s latency budget asserted, never measured                             | High     | ✅ Fixed | New `pnpm check-latency` (`scripts/check-latency.ts`) + `.claude/skills/check-latency/` measuring p50/p95 for mock/local-ocr against the budget — both PASS (mock p95=2ms, local-ocr p95=1471ms) |
> | 8   | Bedrock `BEDROCK_TIMEOUT_MS` envInt fallback untested                           | Medium   | ✅ Fixed | Covered by the same bedrock.test.ts pass as #2                                                                                                                                                   |
> | 9   | Ollama `OLLAMA_TIMEOUT_MS` envInt fallback untested                             | Medium   | ✅ Fixed | Covered by the same ollama.test.ts pass as #3                                                                                                                                                    |
> | 10  | `eval/print-history.ts` crashed on one malformed JSONL line                     | Medium   | ✅ Fixed | `parseHistory` now skips and counts malformed lines with a `console.warn`, instead of throwing                                                                                                   |
> | 11  | README never documented Groq/Bedrock env vars                                   | Medium   | ✅ Fixed | Added to the same README pass as #1                                                                                                                                                              |
> | 12  | `lib/ttb/citations.ts` could silently lose a citation if a new field were added | Low      | ✅ Fixed | Field list now derived from `ExtractedLabelSchema` instead of hand-copied; new tests fail loudly on schema drift unless explicitly allowlisted                                                   |
>
> **Bonus (found during verification, not in the original 19):** `eslint.config.mjs` didn't ignore
> `.vercel/**` alongside the other generated-artifact ignores it already lists (`coverage/**`,
> `playwright-report/**`, etc.), so `pnpm lint` broke locally whenever a Vercel build output existed.
> Added `.vercel/**` to the existing ignore list.
>
> 342 tests pass (up from prior baseline), `pnpm lint` clean, `tsc --noEmit` clean.

---

## Details

### 1. README's `<DEPLOY_URL>` placeholder (critical, brief-alignment)

`README.md` shipped the literal placeholder text in three places (the "Live demo" line and two
sample-download links) instead of the deployed URL — a required brief deliverable. The project's own
MVP plan flagged this placeholder as one that "must not survive past Task 20"; it had. Confirmed via
the Vercel API which of the project's domain aliases actually serves the app without an auth wall
(`proofcheck-ustreasury.vercel.app` requires Vercel SSO; `proofcheck-blush.vercel.app` does not).

### 2–3, 8–9. Cloud/local-LLM adapter timeout paths untested (high/medium, test-coverage)

`bedrock.ts` and `ollama.ts` both wire an `AbortController` + `setTimeout` to enforce
`BEDROCK_TIMEOUT_MS` / `OLLAMA_TIMEOUT_MS`, backed by an `envInt()` helper with a numeric fallback.
Neither adapter's test suite proved the timeout actually fired — only that a signal object of the
right type was passed. Added fake-timer tests (with a `hangingFetch()` helper that only settles when
the abort signal fires) proving the timeout genuinely triggers, plus tests proving a malformed env
value falls back to the documented default rather than degrading silently. Verified non-tautological
by sabotaging the abort-wiring and the envInt fallback in turn and confirming each corresponding new
test failed.

### 4–6. Untested cloud adapters (high, test-coverage)

Of five cloud/local-LLM providers, only `bedrock.ts` and `ollama.ts` had dedicated test files —
`claude.ts`, `openai.ts`, and `groq.ts` had none, and were never invoked by any existing test (only
their tier-name selection was checked in `select.test.ts`). Added a test file for each, covering
credential fail-fast behavior, the exact request contract, and the one behavior unique to each adapter
(Claude's multi-block text joining, OpenAI's `choices[0]` indexing, Groq's `reasoning_effort: "none"`
workaround) without duplicating the shared retry/JSON-parsing coverage that already lives in
`model-extraction.test.ts`. `claude.ts` also got a small fail-fast guard for a missing/blank
`ANTHROPIC_API_KEY`, matching `bedrock.ts`'s existing pattern, since the Anthropic SDK previously only
surfaced a generic error lazily on the first API call.

### 7. No automated check against the brief's <5s latency budget (high, brief-alignment)

`docs/ARCHITECTURE.md`'s skill table promised a `check-latency` skill; it was never built, and nothing
else in the repo aggregated or enforced the budget across the sample set (only a per-request
`processingMs` was returned). Built `scripts/check-latency.ts` + `pnpm check-latency` +
`.claude/skills/check-latency/SKILL.md`, scoped to the keyless, deterministic tiers (mock,
local-ocr) so it stays CI-safe with no live cloud calls. Both tiers currently PASS well inside budget
(mock p50=0ms/p95=2ms; local-ocr p50=624ms/p95=1471ms).

### 10. `eval/print-history.ts` crash on malformed JSONL (medium, bug)

`parseHistory` had no error handling around `JSON.parse`; one malformed line in the committed,
hand-appended-to `eval/history.jsonl` would crash `pnpm eval:history` entirely. Test-first: added a
failing test reproducing the crash, then fixed `parseHistory` to skip and count malformed lines with
a `console.warn` instead of throwing.

### 11. README never documented Groq/Bedrock setup (medium, brief-alignment)

The "Optional cloud tier" setup instructions only named `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and
`OPENAI_API_KEY` — `GROQ_API_KEY` and `AWS_BEARER_TOKEN_BEDROCK` were real, working tiers mentioned
only in a features table, with no setup guidance. Extended the same sentence to name both, with their
optional companion vars.

### 12. `lib/ttb/citations.ts` schema-drift gap (low, test-coverage)

`CITATIONS` is typed `Partial<Record<Field, Citation>>`, so TypeScript won't force a new entry when a
field is added to `ExtractedLabelSchema`, and the test's field list was a hand-copied literal rather
than derived from the schema — a future field could silently end up uncited with no test failure.
Fixed by deriving the field list from `ExtractedLabelSchema.shape` and adding an explicit
`UNCITED_BY_DESIGN` allowlist so any undeclared gap fails loudly. Verified red→green by temporarily
adding a schema field and confirming the new test caught it with an actionable message.

---

## Clean dimensions (no confirmed findings)

- **Matching/TTB logic** (`lib/matching/`, `lib/ttb/`) — no new bugs found.
- **UI/hooks** (`app/`, `components/`, `hooks/`) — the 2026-07-22 bug-audit fixes (sample-load error
  handling, CSV-reupload image reset, duplicate React keys) all re-verified intact.
- **Security** — all 8 checklist items from the 2026-07-22 security review still pass; no new
  exploitable issue in the Bedrock/Ollama/local-ocr-preprocessing surface added since.
