# Escalation Ladder — Measured Results (2026-07-24)

**Method:** identical eval sets and code path, run with and without the ladder — `--no-escalate`
for the baseline, default for the ladder. The cloud tier (Bedrock, Llama 4 Maverick) is stochastic,
so it was run **3× per condition** and compared by median plus a paired per-label diff
(`eval/compare-escalation.ts`). All runs are appended to
[`eval/history.jsonl`](../../../eval/history.jsonl) with `escalation` and `extraCalls` recorded, so
the aggregate numbers here (medians, overall counts) are reproducible from committed data. The
per-label diffs below (the two named "apparent regressions", "zero labels went FAIL→PASS") come
from `eval/compare-escalation.ts`'s local `eval/.results/` detail files, which are gitignored —
regenerable on demand for the deterministic local-ocr tier, but not reproducible from committed
data for the stochastic bedrock runs (re-running redraws different per-label outcomes even at the
same commit; see the run-to-run variance note above).

## Headline: an honest null result

**The escalation ladder produced no measurable gain in overall verdict accuracy on this eval set,
on either tier** — Bedrock median 33/46 (ladder) vs 34/46 (baseline), inside the ±2 run-to-run
noise band; local-ocr 23/46 either way with zero regressions. It fires, it re-reads weak fields,
and the monotonic merge held empirically — but the fields it recovers are not the fields that decide
verdicts on this set. This is reported as-is; the monotonic merge guarantees the ladder cannot make
a single extraction worse, only spend time. (The first cloud measurement was invalid — repairs were
400-ing on JPEGs; see the bedrock section. Re-measured with the fix, the null holds.)

## local-ocr (deterministic — one pair suffices)

| Condition                  | Overall     | Real photos | Degraded | Extra calls |
| -------------------------- | ----------- | ----------- | -------- | ----------- |
| baseline (`--no-escalate`) | 23/46 (50%) | 5/21        | 18/25    | 0           |
| ladder                     | 23/46 (50%) | 5/21        | 18/25    | 37          |

Paired per-label diff: **46 unchanged, 0 improved, 0 regressed.** The ladder made 37 extra
extraction calls and recovered exactly one field verdict (`netContents` 42→43 at the field level) —
on a label whose overall verdict was already decided by another field. Because the tier is
deterministic, the zero-regression result is a direct empirical confirmation of the monotonic-merge
guarantee.

## bedrock (stochastic — 3× per condition, median + paired)

> **These numbers were re-measured after a JPEG-format bug was fixed** (see the box below). The
> original series was taken with cloud repairs silently 400-ing on every JPEG upload, so it never
> tested the ladder on the cloud tier at all. The corrected series below has repairs actually
> executing (25 extra calls per run, zero 400s).

| Run        | baseline overall | ladder overall  |
| ---------- | ---------------- | --------------- |
| 1          | 34/46            | 33/46           |
| 2          | 33/46            | 33/46           |
| 3          | 35/46            | 33/46           |
| **median** | **34/46 (74%)**  | **33/46 (72%)** |

Real-photo subset medians are identical (baseline 14/21, ladder 14/21); the difference is entirely
in the degraded-synthetic subset, within its own noise. The ladder spent 25 extra extraction calls
per run. **Baseline runs span 33–35/46 here, and 33–37/46 across every bedrock run on this
commit/set** — which is the whole reason the measurement is designed around medians and paired diffs
rather than a single before/after pair (a naive single-pair comparison would have "shown" anything
from −2 to +2 purely from noise).

The paired diff reported 2 apparent regressions (`spirits-old-tub-bourbon-back-blur.jpg` and
`wine-la-crema-saralees-chardonnay-back-glare.png`) — but it necessarily compares baseline-run-3
(35/46) against ladder-run-3 (33/46), which are **independent stochastic draws of the model**, not a
fixed baseline the ladder modified. Those labels are within the run-to-run variance the baseline
series itself exhibits; they are not the ladder degrading a result (which the monotonic merge makes
impossible for a fixed extraction). Zero labels went FAIL→PASS.

> **A bug the re-measurement caught.** The first cloud series was invalid: `applyTransform` always
> emits PNG, but the ladder passed the original upload's `meta` to the repair call, so a JPEG upload
> sent PNG bytes labeled `image/jpeg` — and Bedrock rejected every repair with `400 … image does not
match the specified image format`. All 20 JPEG labels in the real-world set had their repairs
> no-op. Fixed (commit `e728c9b`): the repair call now declares `image/png`. The corrected series
> above shows the null result holds even with repairs working. local-ocr was never affected
> (Tesseract reads the buffer directly and ignores the MIME), so its numbers below stand. This is
> exactly the kind of silent no-op an aggregate before/after would have hidden and the honest
> methodology surfaced.

## Why the ladder doesn't move this metric

The ladder re-reads **low-confidence** fields (`confidence < 0.5`, or absent). But on this eval set,
overall FAILs are driven predominantly by **confident-but-wrong** extractions — a fuzzy near-miss
the model reported with high confidence, which is never flagged weak and so is never re-read. The
ladder is deliberately blind to the application data (spec §3.2), so it cannot target "the field
that disagrees with the application" — doing so is the motivated-reasoning path that would
manufacture PASSes. That conservatism is correct, and it also caps what the ladder can achieve on a
strict all-fields metric: the verdict-deciding errors here are not the ones extraction was unsure
about.

Where the ladder _would_ pay off is a genuinely unreadable field (glare/blur that yields low
confidence or an absent read) whose correct value then matches — exactly Jenny Park's bad-photo
case in [`docs/BRIEF.md`](../../BRIEF.md). This set has few such labels: the degraded-synthetic
subset is legible enough that Bedrock reads it at 80–88% even without the ladder, and the genuinely
hard real photos fail on confident misreads, not low-confidence ones.

## Decision: the ladder ships OFF by default (2026-07-25)

Accuracy was a null. Once latency was measured properly, the cost side turned out to be large — so
the ladder became **opt-in** (`ESCALATION_ENABLED=1`, or dev mode's "Re-read weak fields" switch) rather than
part of the default path. A cost with no demonstrated benefit does not belong in the hot path.

| Tier / set              | Single-shot (default)                 | With ladder                           | Ladder cost                                  |
| ----------------------- | ------------------------------------- | ------------------------------------- | -------------------------------------------- |
| mock, synthetic         | p95 2 ms                              | p95 2 ms                              | none (fixture tier is excluded)              |
| local-ocr, synthetic    | p95 1494 ms                           | p95 1486 ms                           | none measurable                              |
| bedrock, synthetic      | p50 1922 / p95 **2539** ms            | p50 3745 / p95 **4370** ms            | **+72% p95**                                 |
| bedrock, real photos    | p50 2155 / p95 2852 / max **4368** ms | p50 3094 / p95 4771 / max **5089** ms | **+67% p95, and the max crosses the budget** |
| local-ocr, real photos  | p50 456 / p95 4131 / max 6731 ms      | p50 947 / p95 4539 / max 6615 ms      | +108% p50, +10% p95                          |
| Model calls (46 labels) | 46                                    | ~71                                   | **+55%**                                     |

Two findings worth separating, because an earlier draft of the ARCHITECTURE risk row conflated them:

1. **The ladder alone pushed the cloud tier past the budget.** On real photos the slowest single-shot
   request is 4368 ms; with the ladder it is 5089 ms. Turning the ladder off returns every cloud
   request to inside budget.
2. **`local-ocr` already breached the budget without the ladder** — max 6731 ms single-shot on real
   photos. That is a pre-existing large-JPEG cost, _not_ caused by the ladder, and it is still
   unmitigated. It went unnoticed because `check-latency` measured only the 13 small synthetic
   samples, where the same tier reads p95 1494 ms. Recorded as its own risk row.

The subsystem, its tests, and this measurement are kept: the null result and the reasoning behind
disabling it are the useful artifacts. `pnpm eval --escalate` and `pnpm check-latency --escalate`
still measure it on demand, and both tools default to OFF so they track what the app actually runs.

## Latency (ladder in the path)

`pnpm check-latency` after the ladder landed: **mock p50 0 / p95 2 ms; local-ocr p50 415 / p95
1507 ms** — both well inside the 5 000 ms budget. The per-transform deadline estimate means a repair
only fires when it fits.

## What this validates

- The **monotonic-merge safety guarantee** — empirically, zero regressions on the deterministic
  tier across 46 labels.
- The **variance-aware methodology** — same-commit runs vary by ±3/46, so the medians-and-paired
  approach was necessary, not decorative; a single-pair claim would have been noise.
- The **injection red-team** (separate from accuracy): 5/5 planted injections inert on both
  local-ocr and Bedrock (see the README security section and `eval/history.jsonl`).

## What to try next (deferred, spec §"Cut and deferred")

The ladder's ceiling on the strict metric is a _trigger_ limitation, not a _mechanism_ one. A
future, carefully-bounded escalation on **suspected-MISMATCH** fields — cross-checking a confident
read against an independent extractor rather than against the application answer — could target the
verdict-deciding errors without reopening the manufacture-passes hole. That is a deliberate,
separately-reviewable design, not an incremental tweak.
