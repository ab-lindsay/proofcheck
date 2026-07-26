---
name: security-review
description: Use before deploys and submission — reviews pending changes against ProofCheck's documented threat model (prompt injection via artwork, upload handling, key hygiene, CSV escaping, fail-closed). Intentionally shadows the built-in /security-review with a project-specific superset.
---

# Security Review (ProofCheck)

Review the diff (or whole repo pre-submission) against `docs/ARCHITECTURE.md` § Security Considerations:

1. **LLM01 prompt injection via artwork:** extraction prompt still frames image text as untrusted data;
   no code path lets model output decide a verdict (verdicts only from lib/matching).
2. **Key hygiene:** no `process.env.*KEY*` in any "use client" file; keys never logged, never in
   error responses, never in the prompt. `git grep -n "API_KEY" app components hooks` to verify.
3. **Uploads:** MIME allowlist + 8 MB cap still enforced in app/api/verify; no disk writes; no shell-outs.
4. **LLM05 output handling:** all model output passes through ExtractedLabelSchema before use.
5. **CSV export:** escapeCsvCell still guards `= + - @` formula injection (lib/csv.test.ts covers it).
6. **Fail-closed:** extraction errors → 502 with generic message; no stack traces in responses.
7. **Supply chain:** run `pnpm audit --prod`; report highs/criticals.
8. Also run a general review of the pending changes for injection, XSS, and secret leaks.
Report findings by severity with file:line; fix or explicitly accept each before deploy/submission.
