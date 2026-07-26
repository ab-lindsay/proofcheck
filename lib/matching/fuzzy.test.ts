import { describe, expect, it } from "vitest";
import { levenshtein, fuzzyVerdict } from "@/lib/matching/fuzzy";

describe("levenshtein", () => {
  it("computes edit distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "ab")).toBe(2);
    expect(levenshtein("ab", "")).toBe(2);
  });
});

describe("fuzzyVerdict (brand mode: normalizedEqualIsMatch=false)", () => {
  const brand = (a: string, b: string) =>
    fuzzyVerdict({ field: "brandName", applicationValue: a, labelValue: b, normalizedEqualIsMatch: false });

  it("raw-exact is COMPLIANT", () => expect(brand("OLD TOM", "OLD TOM").verdict).toBe("COMPLIANT"));
  it("case/punctuation-only difference is NEEDS_CORRECTION (Dave's case)", () => {
    const r = brand("STONE'S THROW", "Stone's Throw");
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toMatch(/same name/i);
  });
  it("small distance is NEEDS_CORRECTION", () =>
    expect(brand("OLD TOM DISTILLERY", "OLD TOM DISTILLARY").verdict).toBe("NEEDS_CORRECTION"));
  it("large distance is NON_COMPLIANT", () =>
    expect(brand("OLD TOM DISTILLERY", "RIVERBEND SPIRITS").verdict).toBe("NON_COMPLIANT"));

  it("label brand is a word-boundary prefix of the application brand is NEEDS_CORRECTION", () => {
    const r = brand("Tito's Handmade", "Tito's");
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toMatch(/shorter form/i);
  });
  it("label brand is a word-boundary prefix of a longer application brand is NEEDS_CORRECTION (Samuel Adams)", () => {
    const r = brand("Samuel Adams Boston Lager", "Samuel Adams");
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toMatch(/shorter form/i);
  });
  it("application brand is a word-boundary prefix of the label brand is NEEDS_CORRECTION (symmetric)", () => {
    const r = brand("Kendall-Jackson", "Kendall-Jackson Vintner's Reserve");
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toMatch(/shorter form/i);
  });
  it("mid-word substring is NOT a word-boundary prefix, stays NON_COMPLIANT (Bud vs Buddy's Brews)", () => {
    const r = brand("Bud", "Buddy's Brews");
    expect(r.verdict).toBe("NON_COMPLIANT");
  });
  it("prefix match works across case/punctuation boundaries after normalization", () => {
    const r = brand("old tom", "Old Tom Distillery");
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toMatch(/shorter form/i);
  });
  it("prefix match works when punctuation differs (e.g. hyphens vs spaces)", () => {
    const r = brand("Kendall-Jackson", "Kendall Jackson Vintner's Reserve");
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toMatch(/shorter form/i);
  });
});

describe("fuzzyVerdict (class/type mode: normalizedEqualIsMatch=true)", () => {
  it("normalized-equal is COMPLIANT", () => {
    const r = fuzzyVerdict({
      field: "classType",
      applicationValue: "Kentucky Straight Bourbon Whiskey",
      labelValue: "KENTUCKY STRAIGHT BOURBON WHISKEY",
      normalizedEqualIsMatch: true,
    });
    expect(r.verdict).toBe("COMPLIANT");
  });
});

describe("fuzzyVerdict (D2a — non-Latin/symbolic text never silently MATCHes, 2026-07-25)", () => {
  it("two different non-Latin strings that both fold to empty are NEEDS_CORRECTION, never COMPLIANT", () => {
    // normalizeLoose strips [^a-z0-9\s], so CJK text collapses to "" on both sides — without a
    // guard, "" === "" would COMPLIANT under normalizedEqualIsMatch: true (classType/nameAndAddress/
    // countryOfOrigin), a false APPROVED on two genuinely different values.
    const r = fuzzyVerdict({
      field: "countryOfOrigin",
      applicationValue: "日本",
      labelValue: "中国",
      normalizedEqualIsMatch: true,
    });
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toMatch(/non-Latin|symbolic/i);
  });

  it("is NEEDS_CORRECTION (not NON_COMPLIANT) even when only the label side folds to empty", () => {
    const r = fuzzyVerdict({
      field: "brandName",
      applicationValue: "OLD TOM",
      labelValue: "老汤姆",
      normalizedEqualIsMatch: false,
    });
    expect(r.verdict).toBe("NEEDS_CORRECTION");
  });
});

describe("fuzzyVerdict — adversarial/unicode block (D2d + D5, 2026-07-25 hardening)", () => {
  it("two different non-Latin strings that both fold to empty are NEEDS_CORRECTION, never COMPLIANT", () => {
    const r = fuzzyVerdict({
      field: "countryOfOrigin",
      applicationValue: "日本",
      labelValue: "中国",
      normalizedEqualIsMatch: true,
    });
    expect(r.verdict).toBe("NEEDS_CORRECTION");
    expect(r.reason).toMatch(/non-Latin|symbolic/i);
  });
  it("edit distance exactly at the threshold is NEEDS_CORRECTION, not NON_COMPLIANT", () => {
    // threshold = max(2, round(10*0.2)) = 2; g->x, h->y is distance 2.
    const r = fuzzyVerdict({
      field: "brandName",
      applicationValue: "abcdefghij",
      labelValue: "abcdefxyij",
      normalizedEqualIsMatch: false,
    });
    expect(r.verdict).toBe("NEEDS_CORRECTION");
  });
  it("edit distance one past the threshold is NON_COMPLIANT", () => {
    const r = fuzzyVerdict({
      field: "brandName",
      applicationValue: "abcdefghij",
      labelValue: "abcdefxyzj",
      normalizedEqualIsMatch: false,
    });
    expect(r.verdict).toBe("NON_COMPLIANT");
  });
  it("a length difference exactly at the threshold falls through to levenshtein (short-circuit is >, not >=)", () => {
    // |10 - 8| = 2 = threshold, and levenshtein is also 2 -> NEEDS_CORRECTION. A mutant >= would
    // short-circuit to NON_COMPLIANT. ("abcdefgh" is a prefix but position 8 is "i", not a space,
    // so the word-boundary-prefix branch does not fire.)
    const r = fuzzyVerdict({
      field: "brandName",
      applicationValue: "abcdefghij",
      labelValue: "abcdefgh",
      normalizedEqualIsMatch: false,
    });
    expect(r.verdict).toBe("NEEDS_CORRECTION");
  });
  it("a value at the schema length cap resolves without running the full distance matrix", () => {
    const r = fuzzyVerdict({
      field: "brandName",
      applicationValue: "OLD TOM DISTILLERY",
      labelValue: "X".repeat(2000),
      normalizedEqualIsMatch: false,
    });
    expect(r.verdict).toBe("NON_COMPLIANT");
  });
});
