import { describe, expect, it } from "vitest";
import type { ExtractedField, ExtractedLabel } from "@/lib/schema";
import { mergeExtraction, mergeField } from "@/lib/vision/escalation/merge";

const field = (over: Partial<ExtractedField> = {}): ExtractedField => ({
  value: "x",
  present: true,
  confidence: 0.9,
  boundingBox: null,
  ...over,
});
const absent = (): ExtractedField => ({ value: null, present: false, confidence: 0, boundingBox: null });

function label(over: Partial<ExtractedLabel> = {}): ExtractedLabel {
  return {
    brandName: field(),
    classType: field(),
    alcoholContent: field(),
    netContents: field(),
    nameAndAddress: field(),
    countryOfOrigin: field(),
    healthWarningStatement: field(),
    ...over,
  };
}

describe("mergeField — monotonic: a repair may only improve", () => {
  it("fills an absent field from the repair", () => {
    expect(mergeField(absent(), field({ value: "found", confidence: 0.4 }))).toEqual(
      field({ value: "found", confidence: 0.4 }),
    );
  });

  it("takes a strictly higher-confidence repair", () => {
    expect(mergeField(field({ value: "old", confidence: 0.4 }), field({ value: "new", confidence: 0.8 }))).toEqual(
      field({ value: "new", confidence: 0.8 }),
    );
  });

  it("NEVER overwrites a present field with an absent one", () => {
    const base = field({ value: "kept", confidence: 0.2 });
    expect(mergeField(base, absent())).toEqual(base);
  });

  it("NEVER lowers confidence", () => {
    const base = field({ value: "kept", confidence: 0.8 });
    expect(mergeField(base, field({ value: "worse", confidence: 0.5 }))).toEqual(base);
  });

  it("keeps the baseline on a confidence tie (deterministic, no churn)", () => {
    const base = field({ value: "baseline", confidence: 0.7 });
    expect(mergeField(base, field({ value: "twin", confidence: 0.7 }))).toEqual(base);
  });

  it("ignores a present-but-blank repair value", () => {
    const base = field({ value: "kept", confidence: 0.1 });
    expect(mergeField(base, field({ value: "  ", confidence: 0.99 }))).toEqual(base);
  });
});

describe("mergeExtraction — the health warning statement is FILL-ONLY (spec §3.3, security)", () => {
  // The warning is the one field whose correct answer an attacker already knows (a published
  // constant). Confidence-ranked replacement would let injected artwork demand the canonical text
  // at confidence 1.0 and overwrite an honest low-confidence transcription of a DEFECTIVE printed
  // warning — flipping REJECTED to APPROVED. So: fill absent, never replace present.
  it("NEVER replaces a present warning transcription, even at much higher confidence", () => {
    const base = label({
      healthWarningStatement: field({ value: "GOVERNMENT WARNING: defective text", confidence: 0.3 }),
    });
    const repair = label({
      healthWarningStatement: field({ value: "GOVERNMENT WARNING: forged canonical", confidence: 1.0 }),
    });
    const { merged, improvedFields } = mergeExtraction(base, repair);
    expect(merged.healthWarningStatement.value).toBe("GOVERNMENT WARNING: defective text");
    expect(improvedFields).not.toContain("healthWarningStatement");
  });

  it("still FILLS an absent warning from a repair", () => {
    const base = label({ healthWarningStatement: absent() });
    const repair = label({
      healthWarningStatement: field({ value: "GOVERNMENT WARNING: recovered", confidence: 0.6 }),
    });
    const { merged, improvedFields } = mergeExtraction(base, repair);
    expect(merged.healthWarningStatement.value).toBe("GOVERNMENT WARNING: recovered");
    expect(improvedFields).toContain("healthWarningStatement");
  });

  it("other fields still merge by confidence (the fill-only rule is warning-specific)", () => {
    const base = label({ brandName: field({ value: "old", confidence: 0.3 }) });
    const repair = label({ brandName: field({ value: "new", confidence: 0.9 }) });
    expect(mergeExtraction(base, repair).merged.brandName.value).toBe("new");
  });
});

describe("mergeExtraction", () => {
  it("reports exactly the fields that improved", () => {
    const base = label({ brandName: absent(), classType: field({ confidence: 0.3 }) });
    const repair = label({
      brandName: field({ value: "Recovered", confidence: 0.6 }),
      classType: field({ confidence: 0.2 }), // worse — must be ignored
    });
    const { merged, improvedFields } = mergeExtraction(base, repair);
    expect(improvedFields).toEqual(["brandName"]);
    expect(merged.brandName.value).toBe("Recovered");
    expect(merged.classType.confidence).toBe(0.3);
  });

  it("reports nothing and changes nothing when the repair is all-absent (a tight crop)", () => {
    const base = label({ healthWarningStatement: field({ value: "GOVERNMENT WARNING: ...", confidence: 0.4 }) });
    const cropRepair: ExtractedLabel = {
      brandName: absent(),
      classType: absent(),
      alcoholContent: absent(),
      netContents: absent(),
      nameAndAddress: absent(),
      countryOfOrigin: absent(),
      healthWarningStatement: absent(),
    };
    const { merged, improvedFields } = mergeExtraction(base, cropRepair);
    expect(improvedFields).toEqual([]);
    expect(merged).toEqual(base);
  });
});
