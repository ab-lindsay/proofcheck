---
name: tune-matching
description: Use when a field or overall verdict is wrong (false NON_COMPLIANT/NEEDS_CORRECTION/COMPLIANT, or a wrong APPROVED/NEEDS_CORRECTION/REJECTED overall) — captures the case as a failing test + eval sample, then tunes matcher rules/thresholds until green.
---

# Tune Matching

The eval-driven feedback loop for matcher quality.

1. Reproduce: get the exact application value, the extracted label value, and the wrong verdict
   (field-level and/or overall).
2. Capture FIRST, test-driven: add a failing unit test in the right suite — `fuzzy.test.ts`,
   `numeric.test.ts`, `warning.test.ts`, or `verify.test.ts` for aggregation/precedence — asserting
   the CORRECT verdict. If extraction realism matters (not just matching logic), also add an eval
   sample via the `add-test-label` skill.
3. Fix minimally: adjust the specific rule/normalizer/threshold (`fuzzy.ts` thresholds,
   `lib/ttb/normalize.ts` parsing, `verify.ts` precedence/overrides). Never special-case a brand name
   or a specific label. **Exception:** the health warning statement is not tunable here — its check
   is a pinned exact-match-after-whitespace-collapse in `lib/ttb` (CLAUDE.md invariant 3); a wrong
   warning verdict is a bug in that comparison, never a threshold to loosen.
4. Verify: `pnpm test` all green AND `pnpm eval` still 100% on mock — the new case must not break old
   ones. If tuning one case breaks another, the rule needs a design change, not a bigger tolerance.
5. Commit test + fix together, with a message naming the case.
