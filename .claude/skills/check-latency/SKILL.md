---
name: check-latency
description: Use when checking end-to-end verify latency against the < 5 s budget — after changing lib/vision, lib/matching, or app/api/verify/route.ts, or before a deploy/submission — measures every configured tier (including cloud when a key is present) and reports p50/p95 per tier.
---

# Check Latency

1. Run `pnpm check-latency`. It replays a sample set through the same extract → verify span
   `app/api/verify/route.ts` reports as `processingMs`, and measures **every tier reachable in this
   environment**: `mock` and `local-ocr` always, plus the configured cloud tier whenever a key is
   present (unconfigured tiers are *skipped*, not failed, so CI stays keyless and green).
2. Every measured tier must print **APPROVED** — p95 at or under the **5 s budget** (the brief's
   adoption-killer requirement). Exit code 1 means a tier missed budget; fix before push/deploy. (The
   script's infrastructure gate uses APPROVED/REJECTED vocabulary — those words stay reserved for
   label verdicts in the app proper.)
3. **Read `max`, not just p95.** p95 can pass while the slowest request breaches the budget — that is
   exactly how the 5-language OCR regression hid (max 7136 ms on real photos while p95 passed) until
   the English-only revert brought real-photo latency to p95 ~1.5 s / max ~2.4 s on the current 46-label
   real-world set. The multilingual packs measured zero verdict gain for 3.3× latency and were reverted
   (see docs/ARCHITECTURE.md:285 RESOLVED row and lib/vision/local-ocr.ts:50-53 controlled table).
4. **Match the flags to what ships.** Defaults mirror `route.ts`: single-shot, synthetic set. The
   numbers only mean something if the measured pipeline is the one users run.
   - `--set real-world` — real photographed labels. **Use this before a deploy**: the synthetic set is
     small and clean, so it materially understates the worst case.
   - `--escalate` — include the escalation ladder. Only meaningful if `ESCALATION_ENABLED=1` or dev
     mode's "Re-read weak fields" switch is in play; it is off by default.
   - `--provider <tier>` — one tier, including `local-llm` (needs Ollama running).
5. If a tier regressed, note p50/p95/max and compare against the recorded figures in
   `docs/ARCHITECTURE.md`'s risk table to see whether it's cold-start, per-item, or systemic.
6. Report: table of tier → p50 → p95 → max → APPROVED/REJECTED, which set and flags were used, and
   any extraction errors logged during the run.

**Two traps this skill has already fallen into — don't reintroduce them:** it measured only the two
keyless tiers (so the cloud tier a reviewer actually hits was never timed) and it timed bare
`provider.extract` while the route wrapped every request in the escalation ladder (so it verified a
shorter pipeline than the app ran). Both produced a passing gate that proved nothing.
