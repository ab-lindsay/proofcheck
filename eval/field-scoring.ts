import type { Verdict } from "@/lib/schema";

/** Which bucket a field's actual verdict counts toward in the headline compliant/needsCorrection/
 *  nonCompliant breakdown (eval/run.ts's per-field scoring). Deliberately independent of whether the
 *  check passed against its accepted list (`ok` in eval/run.ts): a tolerant entry's NEEDS_CORRECTION,
 *  or a planted violation's correctly-caught NON_COMPLIANT/NEEDS_CORRECTION, still isn't a compliant
 *  result and must never inflate the compliant count just because the check itself passed against
 *  what was expected. Only a literal COMPLIANT verdict counts as compliant. */
export type ComplianceBucket = "compliant" | "needsCorrection" | "nonCompliant";

// Pulled out of eval/run.ts's field-scoring loop (and out of that file entirely, same reason
// eval/injection-gate.ts is its own module: eval/run.ts executes main() at import time, so a test
// importing this logic from there would run the whole eval). This one function IS the fix for
// "NEEDS_CORRECTION silently counted as compliant" — keeping it a small, directly-testable pure
// function means a future edit that reintroduces that bug (e.g. collapsing the branches back to
// `if (ok) compliant++`) fails a unit test instead of only showing up as a quieter number in
// console output that nothing asserts on.
export function classifyFieldVerdict(verdict: Verdict): ComplianceBucket {
  if (verdict === "COMPLIANT") return "compliant";
  if (verdict === "NEEDS_CORRECTION") return "needsCorrection";
  return "nonCompliant";
}
