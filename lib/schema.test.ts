import { describe, expect, it } from "vitest";
import { ApplicationDataSchema, ExtractedLabelSchema } from "@/lib/schema";

const field = (value: string | null) => ({ value, present: value !== null, confidence: value === null ? 0 : 0.9 });

const validLabel = {
  brandName: field("OLD TOM DISTILLERY"),
  classType: field("Kentucky Straight Bourbon Whiskey"),
  alcoholContent: field("45% Alc./Vol. (90 Proof)"),
  netContents: field("750 mL"),
  nameAndAddress: field(null),
  countryOfOrigin: field(null),
  healthWarningStatement: field("GOVERNMENT WARNING: ..."),
};

describe("ExtractedLabelSchema", () => {
  it("accepts a valid extraction", () => {
    expect(ExtractedLabelSchema.safeParse(validLabel).success).toBe(true);
  });
  it("rejects a missing field and out-of-range confidence", () => {
    const { nameAndAddress: _omit, ...missing } = validLabel;
    expect(ExtractedLabelSchema.safeParse(missing).success).toBe(false);
    const bad = { ...validLabel, brandName: { ...validLabel.brandName, confidence: 1.5 } };
    expect(ExtractedLabelSchema.safeParse(bad).success).toBe(false);
  });
  it("accepts an optional bounding box", () => {
    const withBox = {
      ...validLabel,
      brandName: { ...validLabel.brandName, boundingBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 } },
    };
    expect(ExtractedLabelSchema.safeParse(withBox).success).toBe(true);
  });
});

describe("ApplicationDataSchema", () => {
  it("requires brandName/classType/netContents and a valid beverageType", () => {
    expect(
      ApplicationDataSchema.safeParse({
        beverageType: "distilled-spirits",
        brandName: "X",
        classType: "Vodka",
        netContents: "750 mL",
      }).success,
    ).toBe(true);
    expect(
      ApplicationDataSchema.safeParse({ beverageType: "cider", brandName: "X", classType: "Y", netContents: "1 L" })
        .success,
    ).toBe(false);
    expect(
      ApplicationDataSchema.safeParse({ beverageType: "wine", brandName: "", classType: "Y", netContents: "1 L" })
        .success,
    ).toBe(false);
  });
});

describe("ExtractedFieldSchema length cap (D5, 2026-07-25 hardening)", () => {
  it("rejects a field value longer than 2000 characters", () => {
    expect(ExtractedLabelSchema.safeParse({ ...validLabel, brandName: field("X".repeat(2001)) }).success).toBe(false);
  });
  it("accepts a field value exactly at the 2000-character cap", () => {
    expect(ExtractedLabelSchema.safeParse({ ...validLabel, brandName: field("X".repeat(2000)) }).success).toBe(true);
  });
});
