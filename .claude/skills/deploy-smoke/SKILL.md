---
name: deploy-smoke
description: Use after every deploy — smoke-tests the LIVE Vercel URL end-to-end (page up, API verifies a sample, batch page renders, a malformed upload is rejected). Counterpart to test-page (local).
---

# Deploy Smoke

Target the URL from README's "Live demo" line (currently `https://proofcheck-ttb.vercel.app`).

1. Page up: `curl -s -o /dev/null -w "%{http_code}" $URL/` → 200. Same for `$URL/batch`.
2. API end-to-end with bundled samples (mock tier resolves by filename, so no key is needed):
   ```
   curl -s -X POST $URL/api/verify -F image=@eval/samples/old-tom-clean.png \
     -F 'application={"beverageType":"distilled-spirits","brandName":"OLD TOM DISTILLERY","classType":"Kentucky Straight Bourbon Whiskey","alcoholContent":"45% Alc./Vol. (90 Proof)","netContents":"750 mL","nameAndAddress":"Old Tom Distillery Co., Bardstown, KY"}'
   ```
   → `"overall":"APPROVED"`. Then the same `application` with `image=@eval/samples/title-case-warning.png`
   → `"overall":"REJECTED"` (title-cased `GOVERNMENT WARNING:` prefix is NON_COMPLIANT, not just needing
   correction — CLAUDE.md invariant 3).
3. Guard check: POST with `-F image=@README.md;type=text/plain` → 400 with a friendly error, no stack trace.
4. Report each check with actual status/latency. Any failure: read the Vercel deploy/function logs
   (Vercel MCP `get_runtime_logs`/`get_deployment_build_logs`) before touching code.
