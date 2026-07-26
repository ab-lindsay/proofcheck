---
name: test-page
description: Use before pushing UI changes — local dev smoke test that boots the app and walks the single-label happy path (counterpart to deploy-smoke, which tests the live URL).
---

# Test Page (local dev smoke)

1. Boot: `pnpm dev --port 3111` in the background; wait for HTTP 200 on http://localhost:3111.
2. API check: POST a bundled sample through the real route:
   `curl -s -X POST http://localhost:3111/api/verify -F image=@eval/samples/old-tom-clean.png -F 'application={"beverageType":"distilled-spirits","brandName":"OLD TOM DISTILLERY","classType":"Kentucky Straight Bourbon Whiskey","alcoholContent":"45% Alc./Vol. (90 Proof)","netContents":"750 mL"}'`
   → expect `"overall":"APPROVED"` and `"tier":"mock"`.
3. UI check: `pnpm e2e` (Playwright walks workflows 1–2 against the mock tier).
4. Kill the dev server. Report pass/fail per step with the actual output on failure.
