import { describe, expect, it } from "vitest";
import {
  collapseWhitespace,
  normalizeLoose,
  parseAlcoholContent,
  parseNetContents,
  abvToProof,
} from "@/lib/ttb/normalize";

describe("collapseWhitespace", () => {
  it("collapses runs and newlines to single spaces", () => {
    expect(collapseWhitespace("GOVERNMENT\n WARNING:   (1) text")).toBe("GOVERNMENT WARNING: (1) text");
  });
});

describe("normalizeLoose", () => {
  it("case-folds and strips punctuation", () => {
    expect(normalizeLoose("STONE'S THROW")).toBe(normalizeLoose("Stone's Throw"));
    expect(normalizeLoose("Stone’s  Throw!")).toBe("stone s throw");
  });

  it("folds accented letters instead of splitting them", () => {
    expect(normalizeLoose("Rémy")).toBe("remy");
    expect(normalizeLoose("MOËT")).toBe(normalizeLoose("Moet"));
  });

  it("folds non-decomposable Latin letters (æ, ø, ß) instead of dropping them", () => {
    expect(normalizeLoose("Nøgne Ø")).toBe(normalizeLoose("Nogne O"));
    expect(normalizeLoose("Weißbier")).toBe("weissbier");
    expect(normalizeLoose("Ærø")).toBe("aero");
  });
});

describe("parseAlcoholContent", () => {
  it("parses percent, proof, and both", () => {
    expect(parseAlcoholContent("45% Alc./Vol. (90 Proof)")).toEqual({ abv: 45 });
    expect(parseAlcoholContent("90 PROOF")).toEqual({ abv: 45 });
    expect(parseAlcoholContent("13.5% ALC. BY VOL.")).toEqual({ abv: 13.5 });
    expect(parseAlcoholContent("no numbers here")).toBeNull();
  });
});

describe("abvToProof", () => {
  it("is 2x abv", () => expect(abvToProof(45)).toBe(90));
});

describe("parseNetContents", () => {
  it("normalizes units to ml", () => {
    expect(parseNetContents("750 mL")).toEqual({ ml: 750 });
    expect(parseNetContents("750ML")).toEqual({ ml: 750 });
    expect(parseNetContents("1 L")).toEqual({ ml: 1000 });
    expect(parseNetContents("1.75 L")).toEqual({ ml: 1750 });
    expect(parseNetContents("12 FL OZ")?.ml).toBeCloseTo(354.88, 1);
    expect(parseNetContents("seven fifty")).toBeNull();
  });

  it("handles thousands separators and leading-decimal volumes", () => {
    expect(parseNetContents("1,750 mL")).toEqual({ ml: 1750 });
    expect(parseNetContents("1,000 mL")).toEqual({ ml: 1000 });
    expect(parseNetContents(".75 L")).toEqual({ ml: 750 });
  });
});

describe("parseNetContents — European decimal comma (D2c, 2026-07-25 hardening)", () => {
  it("treats a comma followed by one or two digits as a decimal point", () => {
    expect(parseNetContents("0,75 L")).toEqual({ ml: 750 });
    expect(parseNetContents("1,5 L")).toEqual({ ml: 1500 });
  });
  it("treats a bare-zero integer part as a decimal even with three digits — 27 CFR 4.72 fills", () => {
    expect(parseNetContents("0,750 L")).toEqual({ ml: 750 });
    expect(parseNetContents("0,375 L")).toEqual({ ml: 375 });
    expect(parseNetContents("0,05 L")).toEqual({ ml: 50 });
  });
  it("still collapses US thousands separators, including multi-group", () => {
    expect(parseNetContents("1,750 mL")).toEqual({ ml: 1750 });
    expect(parseNetContents("1,234,567 mL")).toEqual({ ml: 1234567 });
  });
});
