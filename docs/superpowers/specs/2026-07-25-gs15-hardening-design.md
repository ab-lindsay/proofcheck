# GS-15 Hardening — Design Spec

**Date:** 2026-07-25
**Status:** Approved for planning
**Source:** Four-subsystem senior review (2026-07-25): matching core B−, extraction layer B+, security/DevSecOps A−, eval/testing A−. This spec addresses every HIGH/MEDIUM finding and the priority-ordered "findings that matter" list from that review.

## Motivation

The review confirmed the architecture's load-bearing invariants are real, but found: one **false PASS** defect in the deterministic core (the cardinal failure for a compliance tool), a **dead fallback path** for hung cloud providers, the default cloud tier (Gemini) shipping **untested** behind a 20-req/day quota wall, CI whose only accuracy gate is near-tautological, a security claim resting on n=1, and several DevSecOps hygiene regressions staged but uncommitted. Fixing these — with the same test-first, evidence-committed discipline the repo already demonstrates — is the difference between "impressive prototype" and "I'd trust the numbers in this README."

## Decisions

### D1. Bedrock (Claude Haiku 4.5) becomes the default cloud tier

`selectCloudProvider()` (`lib/vision/select.ts:35-42`) currently prefers Gemini first. New priority: **bedrock → gemini → claude → openai → groq**.

Rationale: Bedrock already defaults to `us.anthropic.claude-haiku-4-5-20251001-v1:0`, chosen empirically (`lib/vision/cloud/bedrock.ts:5-11`); nearly all committed real-world eval evidence (23 runs in `eval/history.jsonl`, including the headline 41/46) is Bedrock; Gemini's free tier has a measured 20-req/day quota wall (`docs/ARCHITECTURE.md` risk table); Bedrock is the FedRAMP/GovCloud-alignable path the README already names for federal use. The model itself does not change.

Additionally, every key check in `selectCloudProvider` switches from truthiness to `?.trim()` (review finding W8: a whitespace-only key currently selects a tier that provably cannot work and makes `GET /api/verify` report `cloudAvailable: true`).

Docs updated in the same change: `.env.example` (which also currently claims Bedrock defaults to "Llama 4 Maverick" — stale, the code says Haiku 4.5), `README.md` tier table, `docs/ARCHITECTURE.md` env-var table.

### D2. Matching-core correctness (the false PASS and the false FAILs)

All three defects live in the fuzzy/normalized layer; all are fixed test-first as pure-function changes.

- **D2a — empty-after-normalize guard (false PASS, HIGH).** `normalizeLoose` (`lib/ttb/normalize.ts:27`) strips `[^a-z0-9\s]`, so all-non-Latin strings normalize to `""` and compare equal; with `normalizedEqualIsMatch: true` (classType, nameAndAddress, countryOfOrigin) that returns MATCH. Fix in `fuzzyVerdict` (`lib/matching/fuzzy.ts`): if either normalized side is `""` while its raw input is non-empty, return REVIEW with reason "could not be compared automatically (non-Latin or symbolic text) — verify by eye". Never MATCH, never MISMATCH.
- **D2b — relative volume tolerance (false FAIL on 750 mL, MED-HIGH).** `ML_TOLERANCE = 1` absolute (`lib/matching/numeric.ts:5`) fails "25.4 FL OZ" vs 750 mL by 0.167 mL. Replace with `max(1, 0.005 × application mL)`. 750 mL tolerance becomes 3.75 mL (25.4 FL OZ = 751.167 passes); 1.75 L becomes 8.75 mL (59.2 FL OZ passes with real headroom instead of 0.25 mL of luck).
- **D2c — European decimal comma (MED).** `normalize.ts:49` strips every digit-adjacent comma as a thousands separator, so `"0,75 L"` parses as 75 000 mL. New rule: a comma is a thousands separator only when followed by exactly three digits and not the last group before the unit; otherwise it is a decimal point. `1,750 mL` → 1750; `0,75 L` → 750; `1,5 L` → 1500.
- **D2d — adversarial/unicode test block.** New tests in `fuzzy.test.ts` and `numeric.test.ts` covering: non-Latin inputs through to verdicts (the D2a class), fl-oz↔mL cross-unit comparisons (the D2b class), decimal-comma volumes (D2c), threshold boundary (`distance === threshold` vs `+1`), and a homoglyph attack on the `GOVERNMENT WARNING:` prefix (Cyrillic `О`) asserting MISMATCH — pinning that fold rules never make it pass.

### D3. Cloud extraction timeout so the fallback can actually fire

Review finding W1 (HIGH): the 8 s route timeout wraps _outside_ `withFallback` (`app/api/verify/route.ts:224-227`), and no cloud adapter times out in under 8 s, so a hung provider produces a 504 instead of the local-OCR degradation.

Fix at the composition site, tier-agnostically: inside the fallback composition, wrap the primary with `withTimeout(primary, CLOUD_PRIMARY_TIMEOUT_MS = 5_000)` so a hang rejects and `withFallback` catches it, leaving ≥3 s of the outer 8 s budget for the local-OCR fallback (warm OCR ≈ 372 ms, cold ≈ 1409 ms — fits). The outer 8 s `withTimeout` stays as the backstop. Additionally set `maxRetries: 0` (or equivalent) and an explicit client timeout on the OpenAI, Groq, and Anthropic SDK constructors so abandoned sockets don't linger past the race — the route owns retry policy, not the SDKs. `BEDROCK_TIMEOUT_MS` keeps its 30 s default for standalone/eval use; the route-level cap governs requests.

Test: a never-resolving primary must produce a local-ocr result (not a 504) within the route timeout, asserted with fake timers; `trace.tier` must name `local-ocr`.

### D4. Gemini adapter test suite

`lib/vision/cloud/gemini.ts` is the only untested adapter (its siblings all have suites). New `gemini.test.ts` mirroring `openai.test.ts` structure: missing/whitespace key fail-fast, happy-path extraction with inline-data contract asserted, malformed-JSON → retry → `ExtractionError` with exactly 2 calls, the safety-block path (`res.response.text()` **throws** on a blocked candidate in `@google/generative-ai` — a different failure shape from the other adapters), and `GEMINI_MODEL` override.

### D5. Schema hardening

`ExtractedFieldSchema.value` (`lib/schema.ts:26`) gains `.max(2000)` — extracted label text has no legitimate reason to exceed this (the health warning is ~300 chars), and it closes the unbounded-model-output path into Levenshtein (O(m×n)), the JSON response, the CSV, and the DOM. Also add a length short-circuit in `fuzzyVerdict`: `if |len(a) − len(b)| > threshold return MISMATCH` — mathematically exact (edit distance ≥ length difference) and eliminates the pathological case independently of the schema.

### D6. Eval/CI gates with teeth

- **D6a — local-ocr accuracy floor in CI.** Add a `--min-overall <n>` flag to `eval/run.ts`: after the report, exit 1 if overall correct < n. CI gains a step running the real-world set on local-ocr (keyless, deterministic — reproduces 23/46 to the integer across runs) with `--min-overall 22`. This gives CI its first non-tautological accuracy gate; the mock gate stays as the matcher canary.
- **D6b — red-team evidence beyond n=1.** Run `pnpm eval --set adversarial --provider bedrock` **3×, on a clean tree**, recording to `eval/history.jsonl`. Then update the README's injection claim to cite the clean multi-run evidence. Local-only (needs the Bedrock token); never in CI. If any run shows a gate violation, that is a release-blocking finding, not a documentation problem.
- **D6c — trend-reporting honesty.** `eval/print-history.ts` renders `escalation` and `subset` markers (they're recorded but dropped, so ladder-on and 1-label subset runs are indistinguishable from clean full runs), and `0/0` planted violations renders as `n/a`, not `100%` (`print-history.ts:61`, same bug in `run.ts:213`).

### D7. Widen the escalation lint boundary to the answer key

`eslint.config.mjs`'s `no-restricted-imports` for `lib/vision/escalation/**` blocks the matchers but not `lib/ttb/warning.ts` (the canonical `HEALTH_WARNING_TEXT` — the one string a ladder could converge against) or `lib/ttb/warning-diff.ts`. Add both to the restricted patterns with a message explaining the retry-toward-PASS risk. Verification is the repo's own non-tautology standard: temporarily add the import, confirm lint goes red, revert.

### D8. DevSecOps hygiene

- **D8a — fix `security-audit.yml` before it commits.** The staged workflow uses mutable action tags, omits `permissions:`, `timeout-minutes`, and `concurrency`, and runs `pnpm audit` without `--prod` — regressing findings the 2026-07-21 audit records as closed. Pin SHAs (copy the exact pins from `ci.yml`), add `permissions: contents: read`, `timeout-minutes`, `concurrency`, and `--prod`.
- **D8b — unstage and ignore coverage dumps.** `coverage-output.txt`, `coverage-output-full.txt`, `coverage-full.txt` are staged; `git rm --cached` them and add root-level `coverage*.txt` to `.gitignore`. Test-output dumps are a known accidental-secret channel.
- **D8c — gate client cost multipliers.** `devTier`, `devBedrockModel`, and `escalate=1` are honored anonymously (`app/api/verify/route.ts:150-155, 181-188, 213`) and multiply the documented no-rate-limiting gap. New server env `DEV_CONTROLS_ENABLED`: when unset in production, the route ignores all three fields (400 with a plain reason if present); in development (`NODE_ENV !== "production"`) they work as today. Documented in `.env.example` and the ARCHITECTURE threat-model table (closing the "undocumented hole" classification).
- **D8d — stale-doc sweep.** Delete the `select.ts:55-60` "SECURITY (address in Task 12)" comment describing a hole that `route.ts:149` closed (replace with a pointer to the fix); fix `.env.example`'s "Llama 4 Maverick by default" (covered by D1); reconcile the ~72% vs ~75% ladder-latency figures between `.env.example` and `route.ts:199`.
- **D8e — pin floating model aliases.** `gemini-flash-latest`, `gpt-4o-mini`, `claude-sonnet-5` float; a silent alias rollover invalidates recorded eval numbers. Pin each adapter's default to a dated snapshot ID where the provider offers one, with a comment naming the pin-for-eval-comparability rationale (Bedrock already does this).

## Non-goals (deferred, documented)

- Per-user rate limiting (already a documented production TODO; D8c narrows the blast radius).
- Unifying structured-output strictness across providers (W5) and moving the prompt to the system role (W4) — real improvements, but they change extraction behavior and would invalidate committed eval baselines mid-hardening; each deserves its own measured spec.
- Batch-table virtualization; beverage-type-aware ABV tolerance (needs a signature change and regulatory sourcing — flagged in `numeric.ts` as future work).

## Acceptance criteria

1. `pnpm test`, `pnpm lint`, `pnpm typecheck` green; new tests fail when their guard is deliberately sabotaged (the repo's non-tautology standard).
2. `pnpm eval` (mock) still 13/13, 8/8 — matcher changes must not regress the canary.
3. `pnpm eval --set real-world --provider local-ocr` ≥ 22/46, and CI enforces it.
4. With `GEMINI_API_KEY` and `AWS_BEARER_TOKEN_BEDROCK` both set, the selected cloud tier is bedrock.
5. A hung cloud provider yields a local-ocr verdict, not a 504.
6. `"日本"` vs `"中国"` on countryOfOrigin → REVIEW; 750 mL vs "25.4 FL OZ" → MATCH; "0,75 L" vs 750 mL → MATCH.
7. Three clean-tree bedrock adversarial runs recorded in `eval/history.jsonl` with `dirty: false`, zero gate violations; README claim updated to cite them.
8. `security-audit.yml` matches `ci.yml`'s pinning/permissions discipline; no `coverage*.txt` tracked.
9. In production without `DEV_CONTROLS_ENABLED`, `devTier`/`devBedrockModel`/`escalate` are inert.
