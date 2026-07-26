import { describe, expect, it } from "vitest";
// From the pure module — NEVER from @/eval/run, whose top-level main() would execute the whole
// eval inside vitest, append junk to the committed history.jsonl, and process.exit the worker.
import { classifyFieldVerdict } from "@/eval/field-scoring";

describe("classifyFieldVerdict", () => {
  it("counts a COMPLIANT verdict as compliant", () => {
    expect(classifyFieldVerdict("COMPLIANT")).toBe("compliant");
  });

  it("counts a NEEDS_CORRECTION verdict as needsCorrection, not compliant", () => {
    // This is the regression this task exists to prevent: a tolerant entry's field-level check can
    // still pass overall (NEEDS_CORRECTION is an accepted outcome, so it doesn't fail the run), but
    // that must never be conflated with the field actually being compliant.
    expect(classifyFieldVerdict("NEEDS_CORRECTION")).toBe("needsCorrection");
    expect(classifyFieldVerdict("NEEDS_CORRECTION")).not.toBe("compliant");
  });

  it("counts a NON_COMPLIANT verdict as nonCompliant, not compliant — even when it's a correctly-caught planted violation", () => {
    // A planted violation's own field is expected to land on NON_COMPLIANT (or NEEDS_CORRECTION) —
    // eval/run.ts's `ok` check correctly scores that as a caught violation, but the field itself is
    // still not compliant, so it must not be counted as such just because catching it was the
    // desired, correct outcome.
    expect(classifyFieldVerdict("NON_COMPLIANT")).toBe("nonCompliant");
    expect(classifyFieldVerdict("NON_COMPLIANT")).not.toBe("compliant");
  });
});
