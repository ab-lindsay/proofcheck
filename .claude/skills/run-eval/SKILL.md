---
name: run-eval
description: Use when checking extraction/matching accuracy, after changing lib/matching, lib/ttb, or lib/vision, or before pushing — runs the eval harness and reports per-tier accuracy and planted-violation catch rate.
---

# Run Eval

1. Run `pnpm eval` (mock tier). This must print 100% overall and 100% violations caught — the mock
   tier is canned extraction, so any miss is a matcher regression. Exit code 1 means fix before push.
2. If extraction code changed, also run `pnpm eval --provider local-ocr` and note the accuracy
   delta vs mock in your report — that gap is the documented tier trade-off.
3. If AWS_BEARER_TOKEN_BEDROCK is configured, optionally run `pnpm eval --provider bedrock` (costs
   real Bedrock spend; skip in CI).
4. Report: table of provider → overall % → violations caught %, plus any files that regressed.
Never weaken eval assertions to make a run pass; fix the matcher or the fixture instead.
