# Codebase Cleanup for Job Interview — Design Spec

**Date:** 2026-07-25
**Status:** Approved
**Scope:** Provider removal, TTB vocabulary alignment, eval scoring fix, and dead-code cleanup

---

## 1. Provider Cleanup

### Goal

Reduce maintenance burden by removing non-Bedrock cloud providers. Bedrock is the production choice; the other four adapters (Gemini, Claude, OpenAI, Groq) are fully implemented but unused in the active deployment.

### What we remove

- `lib/vision/cloud/gemini.ts` + `gemini.test.ts`
- `lib/vision/cloud/claude.ts` + `claude.test.ts`
- `lib/vision/cloud/openai.ts` + `openai.test.ts`
- `lib/vision/cloud/groq.ts` + `groq.test.ts`
- SDK dependencies from `package.json`: `@google/generative-ai`, `@anthropic-ai/sdk`, `openai`
- Environment variables from `.env.example`: `GEMINI_API_KEY`, `GEMINI_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `GROQ_API_KEY`, `GROQ_MODEL`

### What we keep

- `lib/vision/cloud/bedrock.ts` + `bedrock.test.ts` (sole cloud provider)
- `lib/vision/local-ocr.ts` + tests (keyless default)
- `lib/vision/local-llm/ollama.ts` + tests (local dev/eval)
- `lib/vision/mock.ts` + tests (demo/CI/eval)

### What we update

- `lib/vision/select.ts`: Remove 4 imports, simplify `PROVIDERS` map, `selectCloudProvider()` becomes Bedrock-only check, update `providerByName()` error message
- `lib/vision/select.ts:selectProvider()`: Update JSDoc to reflect Bedrock-only cloud tier
- `.env.example`: Remove 8 env vars (4 API keys + 4 model overrides)
- `docs/ARCHITECTURE.md`: Update provider section — remove Gemini/Claude/OpenAI/Groq references
- `hooks/use-dev-tier.ts`: "cloud" tier now means Bedrock (no code change needed, just works)
- `hooks/use-dev-model.ts`: Only Bedrock model switcher remains (remove non-Bedrock model options)
- Tests referencing removed providers: delete or update

### Files affected

- Delete: 8 files (4 adapters + 4 tests)
- Edit: ~10 files (select.ts, .env.example, ARCHITECTURE.md, hooks, tests)

---

## 2. TTB Vocabulary Rename

### Goal

Align internal vocabulary with real TTB (Alcohol and Tobacco Tax and Trade Bureau) terminology from 27 CFR Parts 4/5/7/16. Shows domain knowledge and makes the system's output read like a TTB compliance report.

### Mapping

| Current                      | New                         | TTB equivalent                                   |
| ---------------------------- | --------------------------- | ------------------------------------------------ |
| `MATCH`                      | `COMPLIANT`                 | Field matches application data                   |
| `MISMATCH`                   | `NON_COMPLIANT`             | Field doesn't match → automatic rejection        |
| `REVIEW`                     | `NEEDS_CORRECTION`          | Unreadable/uncertain → must verify before filing |
| `PASS` (overall)             | `APPROVED`                  | All fields compliant                             |
| `FAIL` (overall)             | `REJECTED`                  | Any field non-compliant                          |
| `correct` (eval metric)      | `compliant`                 | Matches eval terminology                         |
| `per-field verdict accuracy` | `per-field compliance rate` | Matches TTB language                             |

### Eval output format (before → after)

**Before:**

```
overall verdict accuracy: 42/46 (91%)
per-field verdict accuracy: brandName 44/46 · alcoholContent 46/46
planted violations caught: 12/13 (92%)
```

**After:**

```
overall compliance: 42/46 (91%)
per-field compliance: brandName 44/46 · alcoholContent 46/46
fields needing correction: 4/46 (9%)
planted violations caught: 12/13 (92%)
```

### Files affected

- `lib/schema.ts`: Rename `Verdict` type values
- `lib/matching/verify.ts`: Update verdict comparisons
- `lib/matching/fuzzy.ts`: Update verdict returns
- `lib/matching/numeric.ts`: Update verdict returns
- `lib/matching/warning.ts`: Update verdict returns
- `eval/run.ts`: Update scoring logic and output
- `eval/record-run.ts`: Update `RunSummary` and `DetailRow` types
- `app/api/verify/route.ts`: Update verdict references
- `app/api/batch/route.ts`: Update verdict references
- `components/field-row.tsx`: Update UI display
- All test files referencing verdicts
- `docs/ARCHITECTURE.md`: Update vocabulary section
- `docs/superpowers/specs/2026-07-21-alcohol-label-verification-design.md`: Update vocabulary section

---

## 3. Eval Scoring Fix

### Goal

Fix the `tolerant: true` scoring bug where REVIEW (giving up) scores identically to MATCH (being right). Align with TTB semantics: a field that can't be read is "Needs Correction," not "Approved."

### Current behavior

```ts
const base: Verdict[] = entry.tolerant ? ["MATCH", "REVIEW"] : ["MATCH"];
```

Every eval entry has `tolerant: true`, so REVIEW counts as correct. An extractor that returns nothing scores the same as one that reads correctly.

### New behavior

Report three outcomes per field:

- `compliant` — extractor read the field correctly (verdict = COMPLIANT)
- `needs_correction` — extractor gave up or was uncertain (verdict = NEEDS_CORRECTION)
- `non_compliant` — extractor got it wrong (verdict = NON_COMPLIANT)

The headline metric becomes `compliant / total` (accuracy). `needs_correction` is reported separately so it's visible — this is the "fields the reviewer must check by eye" count.

### `tolerant` field semantics change

- **Before:** `tolerant: true` means "REVIEW counts as correct"
- **After:** `tolerant: true` means "REVIEW is an acceptable outcome for this field" (e.g., a genuinely absent field in a bad photo) — but it's still reported as `needs_correction`, not counted as `compliant`

### Impact on eval/history.jsonl

Every number was computed under the old rule. Historical data is NOT rewritten — it's a snapshot of what was measured at the time. The commit message notes the re-baselining.

### Files affected

- `eval/run.ts`: Update `expectedFieldVerdicts()`, scoring logic, output format
- `eval/record-run.ts`: Update `RunSummary` type (add `needsCorrection` count)
- `eval/expected.json` and related: No changes needed (entries stay the same, scoring changes)

---

## 4. openapi.yaml Validation

### Goal

Catch spec drift from routes automatically. The spec is the artifact external consumers trust.

### Approach

- Add `yaml` as a devDependency
- Create `openapi.test.ts` that:
  1. Parses `openapi.yaml`
  2. Asserts every `$ref` resolves to a defined schema
  3. Asserts `BatchRowResult` properties match `lib/batch-schema.ts` keys (the valuable assertion — makes the doc fail when the contract moves)

### Files affected

- `package.json`: Add `yaml` devDependency
- `openapi.test.ts`: New test file

---

## 5. Rate Limiting

### Goal

Basic abuse prevention for the unauthenticated `/api/verify` and `/api/batch` endpoints. Honest about prototype scope.

### Approach

- In-memory sliding window per IP (60 requests per minute default)
- Returns 429 with `Retry-After` header when exceeded
- Configurable via `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX` env vars
- Applied as a wrapper function in the route handlers (not middleware.ts)
- Documented as in-memory — doesn't work across multiple instances

### Implementation

Create `lib/rate-limit.ts` with a `rateLimit(opts)` wrapper that:

- Tracks request timestamps per IP in a Map
- Cleans up stale entries periodically
- Returns `{ ok: true }` or `{ ok: false, retryAfter: number }`

### Files affected

- `lib/rate-limit.ts`: New file
- `app/api/verify/route.ts`: Apply rate limit wrapper
- `app/api/batch/route.ts`: Apply rate limit wrapper
- `docs/ARCHITECTURE.md`: Update rate-limiting status from "production TODO" to "implemented (in-memory)"

---

## 6. Security Hardening

### Goal

Be honest about what's appropriate for a prototype. Don't ship half-built security features.

### Approach

- Keep current CSP (`unsafe-inline` required by Next.js App Router hydration)
- Add explanatory comment in `security-headers.ts` explaining the constraint and what nonce-based CSP would require
- Skip middleware.ts — the rate limiter goes in route handlers directly

### Files affected

- `lib/security-headers.ts`: Add comment

---

## 7. Dead Specs/Plans Cleanup

### Goal

Remove dead references and move legitimate stretch goals to a "future work" section. Clean, focused docs that tell a clear story.

### Items to remove (dead references)

- Pre-cut items from escalation plans: tier escalation as repair action, field-scoped extractField() prompts, recovered boxes into field-of-vision
- Deferred-past-submission items: self-consistency voting, MCP server, token/cost accounting, BYOK
- Structured output / system role prompt (deferred non-goal from gs15-hardening)

### Items to move to "future work" section in ARCHITECTURE.md

- Field-of-vision check (stretch goal #1)
- Beverage-type-aware ABV tolerance
- Multi-image front+back (stretch goal #5)
- Bounding-box overlay (stretch goal #7)
- Verdict feedback capture (stretch goal #8)
- Image-quality warnings (stretch goal #10)
- Table virtualization
- Zip upload for batch
- Per-verification telemetry footer (stretch goal #11)
- Deskew

### Items to update status

- Batch eval tier: mark as "implemented with open follow-ups" (escalation budget, no UI caller)
- Dark mode: mark as "partially implemented (dev-mode gated)"
- Health-warning diff view: mark as "implemented (dev-mode gated)"
- tune-matching skill: mark as "designed, not yet authored" (kept as reference, implemented later — see Section 8)

### Files affected

- `docs/ARCHITECTURE.md`: Major rewrite of future work / stretch goals section
- `docs/superpowers/specs/2026-07-21-alcohol-label-verification-design.md`: Update stretch goal statuses
- `docs/deferred-items-and-tradeoffs-2026-07-25.md`: Mark items as addressed or stale

---

## 8. tune-matching Skill (deferred)

### Status

Designed but not yet implemented. Reference kept in ARCHITECTURE.md as "designed, not yet authored."

### Why deferred

Depends on the eval scoring fix (Section 3) — the skill needs accurate scoring to know which verdicts are actually wrong. Implement after the cleanup lands.

### What it would do

Automated feedback loop: mis-verdict → unit test + eval entry → adjust normalizers/thresholds → re-eval → repeat until green.

---

## 9. Items intentionally NOT addressed

- **Batch endpoint** — another agent is wiring it up
- **GS-15 hardening** — user is still actively working on it
- **`pnpm format`** — already done, `format:check` in CI

---

## Execution order

1. Provider cleanup (Section 1) — standalone, no dependencies
2. TTB vocabulary rename (Section 2) — large but mechanical
3. Eval scoring fix (Section 3) — depends on Section 2 for new vocab
4. openapi.yaml validation (Section 4) — standalone
5. Rate limiting (Section 5) — standalone
6. Security hardening comment (Section 6) — standalone
7. Dead specs/plans cleanup (Section 7) — standalone

Sections 1, 4, 5, 6, 7 are independent and could be parallelized.
Sections 2 → 3 are sequential (vocabulary must land before scoring uses it).
