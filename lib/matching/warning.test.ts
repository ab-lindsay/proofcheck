import { describe, expect, it } from "vitest";
import { checkHealthWarning } from "@/lib/matching/warning";
import { HEALTH_WARNING_TEXT } from "@/lib/ttb/warning";
import type { ExtractedField } from "@/lib/schema";

const f = (value: string | null): ExtractedField => ({
  value,
  present: value !== null,
  confidence: value === null ? 0 : 0.95,
});

describe("checkHealthWarning", () => {
  it("exact text (even wrapped across lines) is COMPLIANT", () => {
    const wrapped = HEALTH_WARNING_TEXT.replace("(2)", "\n(2)");
    expect(checkHealthWarning(f(wrapped)).verdict).toBe("COMPLIANT");
  });
  it("title case prefix is NON_COMPLIANT with a caps reason (Jenny's case)", () => {
    const r = checkHealthWarning(f(HEALTH_WARNING_TEXT.replace("GOVERNMENT WARNING:", "Government Warning:")));
    expect(r.verdict).toBe("NON_COMPLIANT");
    expect(r.reason).toMatch(/capital letters/i);
  });
  it("all-caps body with exact wording is NEEDS_CORRECTION, not NON_COMPLIANT (9/10 real approved labels print it this way)", () => {
    const r = checkHealthWarning(f(HEALTH_WARNING_TEXT.toUpperCase()));
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toMatch(/letter case/i);
  });
  it("missing space after the colon is NEEDS_CORRECTION — spacing-only deviation (seen on a real approved label)", () => {
    const r = checkHealthWarning(f(HEALTH_WARNING_TEXT.replace("WARNING: (1)", "WARNING:(1)")));
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toMatch(/spacing/i);
  });
  it("altered wording is NON_COMPLIANT pointing near the deviation", () => {
    const r = checkHealthWarning(f(HEALTH_WARNING_TEXT.replace("birth defects", "health issues")));
    expect(r.verdict).toBe("NON_COMPLIANT");
    expect(r.reason).toMatch(/deviates/i);
  });
  it("shortened text is NON_COMPLIANT", () => {
    expect(checkHealthWarning(f(HEALTH_WARNING_TEXT.slice(0, 120))).verdict).toBe("NON_COMPLIANT");
  });
  it("text that is not a warning at all is NON_COMPLIANT on the missing prefix", () => {
    const r = checkHealthWarning(f("Contains sulfites. Please enjoy responsibly."));
    expect(r.verdict).toBe("NON_COMPLIANT");
    expect(r.reason).toMatch(/does not begin with/i);
  });
  it("missing warning is NEEDS_CORRECTION, never a silent pass", () => {
    const r = checkHealthWarning(f(null));
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toMatch(/mandatory/i);
  });
  it("empty-string transcription (region found, nothing read) is NEEDS_CORRECTION, not a false NON_COMPLIANT", () => {
    const r = checkHealthWarning(f(""));
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toMatch(/mandatory/i);
  });
  it("whitespace-only transcription is treated as unread, NEEDS_CORRECTION", () => {
    const r = checkHealthWarning(f(" \n\t "));
    expect(r.verdict).toBe("NEEDS_CORRECTION");
  });
});

describe("checkHealthWarning — homoglyph resistance (D2d, 2026-07-25 hardening)", () => {
  it("a Cyrillic О (U+041E) in the GOVERNMENT WARNING prefix is NON_COMPLIANT, never folded into passing", () => {
    // Visually identical to Latin "O", different code point. checkHealthWarning is a byte compare
    // with no normalizeLoose/fuzzy fold anywhere, so this must land on the missing-prefix path.
    const spoofed = HEALTH_WARNING_TEXT.replace("O", "О");
    const r = checkHealthWarning(f(spoofed));
    expect(r.verdict).toBe("NON_COMPLIANT");
    expect(r.reason).toMatch(/does not begin with/i);
  });
});
