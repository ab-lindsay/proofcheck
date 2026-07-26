import { describe, expect, it } from "vitest";
import type { BoundingBox, ExtractedField, ExtractedLabel } from "@/lib/schema";
import { isWeak, planRepairs, unionBox, weakFields } from "@/lib/vision/escalation/policy";

const box = (x: number, y: number, width: number, height: number): BoundingBox => ({ x, y, width, height });

const strong = (value = "x", boundingBox: BoundingBox | null = null): ExtractedField => ({
  value,
  present: true,
  confidence: 0.95,
  boundingBox,
});
const lowConf = (value = "x", boundingBox: BoundingBox | null = null): ExtractedField => ({
  value,
  present: true,
  confidence: 0.3,
  boundingBox,
});
const absent = (): ExtractedField => ({ value: null, present: false, confidence: 0, boundingBox: null });

function label(overrides: Partial<ExtractedLabel> = {}): ExtractedLabel {
  return {
    brandName: strong(),
    classType: strong(),
    alcoholContent: strong(),
    netContents: strong(),
    nameAndAddress: strong(),
    countryOfOrigin: strong(),
    healthWarningStatement: strong(),
    ...overrides,
  };
}

describe("isWeak", () => {
  it("treats an absent field as weak", () => {
    expect(isWeak(absent())).toBe(true);
  });

  it("treats a present field below the review threshold as weak", () => {
    expect(isWeak(lowConf())).toBe(true);
  });

  it("treats a confident present field as strong", () => {
    expect(isWeak(strong())).toBe(false);
  });

  it("treats a present-but-empty value as weak", () => {
    expect(isWeak({ value: "   ", present: true, confidence: 0.99, boundingBox: null })).toBe(true);
  });
});

describe("weakFields", () => {
  it("returns nothing for a clean extraction", () => {
    expect(weakFields(label())).toEqual([]);
  });

  it("does NOT treat an absent countryOfOrigin as weak (domestic labels lack it)", () => {
    expect(weakFields(label({ countryOfOrigin: absent() }))).toEqual([]);
  });

  it("DOES treat a low-confidence countryOfOrigin as weak", () => {
    expect(weakFields(label({ countryOfOrigin: lowConf() }))).toEqual(["countryOfOrigin"]);
  });

  it("does NOT plan a repair for a PRESENT low-confidence health warning (fill-only: unimprovable)", () => {
    // The warning is fill-only in the merge, so a present-but-low-confidence read can never be
    // improved by a repair — planning one just burns cloud calls. Only an ABSENT warning is weak.
    expect(weakFields(label({ healthWarningStatement: lowConf() }))).toEqual([]);
  });

  it("STILL treats an ABSENT health warning as weak (a repair can fill it)", () => {
    expect(weakFields(label({ healthWarningStatement: absent() }))).toEqual(["healthWarningStatement"]);
  });

  it("orders results by repair priority, warning first", () => {
    const weak = weakFields(label({ brandName: absent(), healthWarningStatement: absent(), netContents: absent() }));
    expect(weak).toEqual(["healthWarningStatement", "brandName", "netContents"]);
  });
});

// unionBox returns sums/differences of doubles (0.9 + 0.5 - 0.9 = 0.09999999999999998), so assert
// per-property with toBeCloseTo — toEqual on the whole object fails on float representation.
function expectBoxCloseTo(actual: BoundingBox, expected: BoundingBox): void {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
  expect(actual.width).toBeCloseTo(expected.width, 10);
  expect(actual.height).toBeCloseTo(expected.height, 10);
}

describe("unionBox", () => {
  it("spans all input boxes", () => {
    expectBoxCloseTo(unionBox([box(0.1, 0.1, 0.2, 0.2), box(0.5, 0.6, 0.1, 0.1)]), box(0.1, 0.1, 0.5, 0.6));
  });

  it("clamps the union inside the unit square", () => {
    expectBoxCloseTo(unionBox([box(0.9, 0.9, 0.5, 0.5)]), box(0.9, 0.9, 0.1, 0.1));
  });
});

describe("planRepairs", () => {
  it("plans nothing for a clean extraction", () => {
    expect(planRepairs(label(), 2)).toEqual([]);
  });

  it("crops the union of boxed weak fields first when few fields are weak", () => {
    // Two non-fill-only fields (brandName, netContents) so both are genuinely weak-and-repairable.
    const plans = planRepairs(
      label({
        brandName: lowConf("b", box(0.2, 0.1, 0.3, 0.1)),
        netContents: lowConf("n", box(0.1, 0.7, 0.8, 0.2)),
      }),
      2,
    );
    expect(plans[0].transform).toBe("crop");
    expect(plans[0].targetFields).toEqual(["brandName", "netContents"]);
    // 0.7 + 0.2 = 0.8999999999999999 in doubles — assert close-to, not equal (see expectBoxCloseTo).
    expectBoxCloseTo(plans[0].box as BoundingBox, box(0.1, 0.1, 0.8, 0.8));
  });

  it("enhances first when three or more fields are weak (a whole-image problem)", () => {
    const plans = planRepairs(
      label({
        brandName: lowConf("b", box(0.1, 0.1, 0.2, 0.1)),
        classType: lowConf("c", box(0.1, 0.3, 0.2, 0.1)),
        netContents: lowConf("n", box(0.1, 0.5, 0.2, 0.1)),
      }),
      2,
    );
    expect(plans[0].transform).toBe("enhance");
    expect(plans[0].box).toBeNull();
    expect(plans[1].transform).toBe("crop");
  });

  it("enhances only when no weak field has a bounding box", () => {
    const plans = planRepairs(label({ brandName: absent() }), 2);
    expect(plans).toEqual([{ transform: "enhance", targetFields: ["brandName"], box: null }]);
  });

  it("never returns more plans than maxPlans", () => {
    const plans = planRepairs(
      label({
        brandName: lowConf("b", box(0.1, 0.1, 0.2, 0.1)),
        classType: lowConf("c", box(0.1, 0.3, 0.2, 0.1)),
        netContents: lowConf("n", box(0.1, 0.5, 0.2, 0.1)),
      }),
      1,
    );
    expect(plans).toHaveLength(1);
  });
});
