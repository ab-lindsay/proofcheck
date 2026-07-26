import { describe, expect, it } from "vitest";
import { citationFor } from "@/lib/ttb/citations";
import { BeverageTypeSchema, ExtractedLabelSchema, type ExtractedLabel, type BeverageType } from "@/lib/schema";

// Derived structurally from the schema (not hand-copied) so that adding a field to
// ExtractedLabelSchema automatically extends this list — see the "structural completeness"
// describe block below for the test this guards.
const FIELDS = Object.keys(ExtractedLabelSchema.shape) as (keyof ExtractedLabel)[];
const TYPES = BeverageTypeSchema.options;

// Fields that are deliberately NOT looked up via citationFor() for a given beverage type,
// because they are handled elsewhere by design (e.g. matched against a canonical constant
// rather than cited to a CFR section) rather than by oversight. Anything for a
// (field, beverageType) pair not listed here MUST resolve to a non-null citation — see the
// "structural completeness" test below. Keep this allowlist short and explicit; every entry
// should be defensible in code review.
const UNCITED_BY_DESIGN: ReadonlyArray<readonly [keyof ExtractedLabel, BeverageType]> = [];

const isUncitedByDesign = (field: keyof ExtractedLabel, type: BeverageType) =>
  UNCITED_BY_DESIGN.some(([f, t]) => f === field && t === type);

describe("citationFor", () => {
  it("every non-null citation is a well-formed CFR reference with an ecfr.gov link", () => {
    for (const t of TYPES) {
      for (const f of FIELDS) {
        const c = citationFor(f, t);
        if (c === null) continue;
        expect(c.cfr, `${t}/${f}`).toMatch(/^(27|19) CFR §\d+\.\d+$/);
        expect(c.url, `${t}/${f}`).toMatch(/^https:\/\/www\.ecfr\.gov\/current\/title-(27|19)\//);
        expect(c.basis.length, `${t}/${f}`).toBeGreaterThan(10);
      }
    }
  });
  it("resolves a citation for every (field, beverageType) pair not marked uncited-by-design — wine country-of-origin cites CBP, not TTB", () => {
    for (const t of TYPES) {
      for (const f of FIELDS) {
        if (isUncitedByDesign(f, t)) continue;
        const c = citationFor(f, t);
        expect(c, `${t}/${f}`).not.toBeNull();
      }
    }
    // Wine's country-of-origin marking is governed by CBP (19 CFR §134.11), not TTB (27 CFR).
    expect(citationFor("countryOfOrigin", "wine")?.cfr).toBe("19 CFR §134.11");
    expect(citationFor("countryOfOrigin", "distilled-spirits")?.cfr).toBe("27 CFR §5.69");
    expect(citationFor("countryOfOrigin", "malt-beverage")?.cfr).toBe("27 CFR §7.69");
  });
  it("the health warning cites 27 CFR §16.21 for every beverage type", () => {
    for (const t of TYPES) expect(citationFor("healthWarningStatement", t)?.cfr).toBe("27 CFR §16.21");
  });
  it("spot-checks key sections", () => {
    expect(citationFor("alcoholContent", "distilled-spirits")?.cfr).toBe("27 CFR §5.65");
    expect(citationFor("classType", "wine")?.cfr).toBe("27 CFR §4.34");
    expect(citationFor("brandName", "malt-beverage")?.cfr).toBe("27 CFR §7.64");
    expect(citationFor("countryOfOrigin", "wine")?.cfr).toBe("19 CFR §134.11");
  });
  it("returns null for an unknown field", () => {
    expect(citationFor("bogus" as keyof ExtractedLabel, "wine")).toBeNull();
  });
});

// Guards against schema drift: FIELDS above is derived from ExtractedLabelSchema itself (not a
// hand-copied list), so adding a field to lib/schema.ts automatically brings it into these
// assertions. Without this, a new field could silently resolve to citationFor(...) === null
// everywhere (no citation shown in components/field-row.tsx) with no type error — CITATIONS is
// typed as Partial<Record<Field, Citation>>, so TypeScript does not require a new entry — and no
// test failure to catch it.
describe("citation coverage tracks schema drift", () => {
  it("FIELDS is derived from ExtractedLabelSchema, not hand-copied", () => {
    expect(FIELDS.length).toBeGreaterThan(0);
    expect(FIELDS).toEqual(Object.keys(ExtractedLabelSchema.shape));
  });

  it("every schema field is either cited or explicitly allowlisted as uncited-by-design, for every beverage type", () => {
    const missing: string[] = [];
    for (const t of TYPES) {
      for (const f of FIELDS) {
        if (isUncitedByDesign(f, t)) continue;
        if (citationFor(f, t) === null) missing.push(`${f}/${t}`);
      }
    }
    expect(
      missing,
      `Missing citations for: ${missing.join(", ")}. If this is a new ExtractedLabel field (or a ` +
        `new beverage type), either add a Citation for it in lib/ttb/citations.ts, or add ` +
        `[field, beverageType] to UNCITED_BY_DESIGN in this file with a comment explaining why no ` +
        `citation applies.`,
    ).toEqual([]);
  });

  it("UNCITED_BY_DESIGN only references real fields and beverage types (no stale entries)", () => {
    for (const [f, t] of UNCITED_BY_DESIGN) {
      expect(FIELDS as readonly string[], `stale allowlist field "${f}"`).toContain(f);
      expect(TYPES as readonly string[], `stale allowlist beverageType "${t}"`).toContain(t);
    }
  });
});
