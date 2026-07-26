import { describe, expect, it } from "vitest";
import { checkAlcoholContent, checkNetContents } from "@/lib/matching/numeric";
import type { ExtractedField } from "@/lib/schema";

const f = (value: string): ExtractedField => ({ value, present: true, confidence: 0.95 });

describe("checkAlcoholContent", () => {
  it("matches equal ABV in different notations", () => {
    expect(checkAlcoholContent("45% Alc./Vol. (90 Proof)", f("45% ALC/VOL")).verdict).toBe("COMPLIANT");
    expect(checkAlcoholContent("45% Alc./Vol.", f("90 Proof")).verdict).toBe("COMPLIANT");
  });
  it("mismatches different ABV with both values in the reason", () => {
    const r = checkAlcoholContent("45% Alc./Vol. (90 Proof)", f("40% Alc./Vol. (80 Proof)"));
    expect(r.verdict).toBe("NON_COMPLIANT");
    expect(r.reason).toMatch(/45/);
    expect(r.reason).toMatch(/40/);
  });
  it("flags internally inconsistent label (% vs proof) as NON_COMPLIANT", () => {
    expect(checkAlcoholContent("45% Alc./Vol.", f("45% Alc./Vol. (80 Proof)")).verdict).toBe("NON_COMPLIANT");
  });
  it("unparseable values are NEEDS_CORRECTION", () => {
    expect(checkAlcoholContent("forty-five percent", f("45%")).verdict).toBe("NEEDS_CORRECTION");
    expect(checkAlcoholContent("45%", f("about half")).verdict).toBe("NEEDS_CORRECTION");
  });
  it("empty label value is NEEDS_CORRECTION (unreadable, never a silent match)", () => {
    expect(checkAlcoholContent("45%", f("")).verdict).toBe("NEEDS_CORRECTION");
  });
  it("null field value shows empty string in reason", () => {
    const r = checkAlcoholContent("45%", { value: null as unknown as string, present: true, confidence: 0.95 });
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toContain('("")');
  });
});

describe("checkNetContents", () => {
  it("matches across unit spellings", () => {
    expect(checkNetContents("750 mL", f("750ML")).verdict).toBe("COMPLIANT");
    expect(checkNetContents("1 L", f("1000 ml")).verdict).toBe("COMPLIANT");
  });
  it("mismatches different volumes", () => {
    expect(checkNetContents("750 mL", f("700 mL")).verdict).toBe("NON_COMPLIANT");
  });
  it("unparseable is NEEDS_CORRECTION", () => {
    expect(checkNetContents("750 mL", f("a fifth")).verdict).toBe("NEEDS_CORRECTION");
    expect(checkNetContents("a fifth", f("750 mL")).verdict).toBe("NEEDS_CORRECTION");
    expect(checkNetContents("750 mL", f("")).verdict).toBe("NEEDS_CORRECTION");
  });
  it("null field value shows empty string in reason", () => {
    const r = checkNetContents("750 mL", { value: null as unknown as string, present: true, confidence: 0.95 });
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toContain('("")');
  });
});

describe("checkNetContents — relative tolerance (D2b, 2026-07-25 hardening)", () => {
  it("matches 750 mL against its real fl-oz label reading (25.4 FL OZ = 751.167 mL)", () => {
    expect(checkNetContents("750 mL", f("25.4 FL OZ")).verdict).toBe("COMPLIANT");
  });
  it("matches 1.75 L against its real fl-oz label reading (59.2 FL OZ = 1750.95 mL)", () => {
    expect(checkNetContents("1.75 L", f("59.2 FL OZ")).verdict).toBe("COMPLIANT");
  });
  it("still flags a volume that is genuinely off, scaled to the larger tolerance", () => {
    // 1.75 L -> tolerance max(1, 0.005*1750) = 8.75 mL; 1700 mL is 50 mL short.
    expect(checkNetContents("1.75 L", f("1700 mL")).verdict).toBe("NON_COMPLIANT");
  });
  it("applies the 1 mL floor on small bottles, where 0.5% alone would be too tight", () => {
    // 50 mL -> relative term is 0.25 mL, but 1.7 FL OZ = 50.275 mL is 0.275 mL away: only the
    // 1 mL floor makes this agree. Removing Math.max would turn this into NON_COMPLIANT.
    expect(checkNetContents("50 mL", f("1.7 FL OZ")).verdict).toBe("COMPLIANT");
  });
  it("treats a difference exactly at the tolerance as agreement (<=, not <)", () => {
    // 1000 mL -> tolerance exactly 5 mL (0.005*1000 is bit-exact in IEEE 754); |1000-1005| = 5.
    expect(checkNetContents("1000 mL", f("1005 mL")).verdict).toBe("COMPLIANT");
  });
  it("flags a difference just past the tolerance", () => {
    expect(checkNetContents("1000 mL", f("1005.01 mL")).verdict).toBe("NON_COMPLIANT");
  });
});
