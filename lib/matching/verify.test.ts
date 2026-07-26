import { describe, expect, it } from "vitest";
import { verifyLabel } from "@/lib/matching/verify";
import { HEALTH_WARNING_TEXT } from "@/lib/ttb/warning";
import type { ApplicationData, ExtractedField, ExtractedLabel } from "@/lib/schema";

const f = (value: string | null, confidence = 0.95): ExtractedField => ({
  value,
  present: value !== null,
  confidence: value === null ? 0 : confidence,
});

const app: ApplicationData = {
  beverageType: "distilled-spirits",
  brandName: "OLD TOM DISTILLERY",
  classType: "Kentucky Straight Bourbon Whiskey",
  alcoholContent: "45% Alc./Vol. (90 Proof)",
  netContents: "750 mL",
};

const clean: ExtractedLabel = {
  brandName: f("OLD TOM DISTILLERY"),
  classType: f("Kentucky Straight Bourbon Whiskey"),
  alcoholContent: f("45% Alc./Vol. (90 Proof)"),
  netContents: f("750 mL"),
  nameAndAddress: f(null),
  countryOfOrigin: f(null),
  healthWarningStatement: f(HEALTH_WARNING_TEXT),
};

describe("verifyLabel", () => {
  it("clean label passes with all COMPLIANT and the bold-check warning", () => {
    const r = verifyLabel(app, clean);
    expect(r.overall).toBe("APPROVED");
    expect(r.fields.every((x) => x.verdict === "COMPLIANT")).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/bold/i);
  });
  it("any NON_COMPLIANT field rejects; a NEEDS_CORRECTION field alone does not", () => {
    const wrongAbv = { ...clean, alcoholContent: f("40% Alc./Vol.") };
    expect(verifyLabel(app, wrongAbv).overall).toBe("REJECTED");
    const brandCase = { ...clean, brandName: f("Old Tom Distillery") };
    const r = verifyLabel(app, brandCase);
    expect(r.overall).toBe("NEEDS_CORRECTION");
    expect(r.fields.find((x) => x.field === "brandName")?.verdict).toBe("NEEDS_CORRECTION");
  });
  it("a rejection outranks a correction when a label has both", () => {
    const both = {
      ...clean,
      alcoholContent: f("40% Alc./Vol."), // NON_COMPLIANT
      brandName: f("Old Tom Distillery"), // NEEDS_CORRECTION (case only)
    };
    const r = verifyLabel(app, both);
    expect(r.fields.find((x) => x.field === "alcoholContent")?.verdict).toBe("NON_COMPLIANT");
    expect(r.fields.find((x) => x.field === "brandName")?.verdict).toBe("NEEDS_CORRECTION");
    expect(r.overall).toBe("REJECTED");
  });
  it("never reports APPROVED while any field is unverified — the fail-closed rule", () => {
    for (const label of [
      { ...clean, brandName: f("Old Tom Distillery") },
      { ...clean, netContents: f(null) },
      { ...clean, classType: f("Kentucky Straight Bourbon Whiskey", 0.3) },
    ]) {
      const r = verifyLabel(app, label);
      expect(r.fields.some((x) => x.verdict === "NEEDS_CORRECTION")).toBe(true);
      expect(r.overall).not.toBe("APPROVED");
    }
  });
  it("app-provided field missing on label is NEEDS_CORRECTION", () => {
    const noNet = { ...clean, netContents: f(null) };
    const r = verifyLabel(app, noNet);
    expect(r.fields.find((x) => x.field === "netContents")?.verdict).toBe("NEEDS_CORRECTION");
    expect(r.overall).toBe("NEEDS_CORRECTION");
  });
  it("low confidence downgrades COMPLIANT to NEEDS_CORRECTION", () => {
    const lowConf = { ...clean, classType: f("Kentucky Straight Bourbon Whiskey", 0.3) };
    expect(verifyLabel(app, lowConf).fields.find((x) => x.field === "classType")?.verdict).toBe("NEEDS_CORRECTION");
  });
  it("table wine without ABV anywhere: no alcoholContent row, informational note", () => {
    const wineApp: ApplicationData = {
      beverageType: "wine",
      brandName: "RIDGE CREEK",
      classType: "Red Table Wine",
      netContents: "750 mL",
    };
    const wineLabel: ExtractedLabel = {
      ...clean,
      brandName: f("RIDGE CREEK"),
      classType: f("Red Table Wine"),
      alcoholContent: f(null),
    };
    const r = verifyLabel(wineApp, wineLabel);
    expect(r.fields.find((x) => x.field === "alcoholContent")).toBeUndefined();
    expect(r.overall).toBe("APPROVED");
    expect(r.warnings.join(" ")).toMatch(/alcohol content/i);
  });
  it("spirits application missing required alcohol content gets a visible NEEDS_CORRECTION row", () => {
    const { alcoholContent: _omit, ...withoutAbv } = app;
    const r = verifyLabel(withoutAbv as ApplicationData, clean);
    expect(r.fields.find((x) => x.field === "alcoholContent")?.verdict).toBe("NEEDS_CORRECTION");
    expect(r.overall).toBe("NEEDS_CORRECTION");
  });
  it("extracted-but-not-applied optional field surfaces as an informational warning", () => {
    const withProducer = { ...clean, nameAndAddress: f("Old Tom Distillery Co., Bardstown, KY") };
    const r = verifyLabel(app, withProducer);
    expect(r.fields.find((x) => x.field === "nameAndAddress")).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/Bardstown/);
  });
  it("wine outside the table/light-wine designation with no application ABV gets a visible NEEDS_CORRECTION row", () => {
    // Brief describes this as ">14% ABV -> required"; but isAlcoholContentRequired's >14% branch is only
    // reachable via verifyLabel when app.alcoholContent is falsy (verify.ts's else-if guard), and in that
    // case parseAlcoholContent has nothing to parse, so that numeric branch can never actually fire through
    // verifyLabel — it's already covered directly in lib/ttb/required-fields.test.ts. What verifyLabel DOES
    // exercise for wine is the other half of the same function: classType lacking a "table wine"/"light wine"
    // designation makes ABV required when the application omits it.
    const wineApp: ApplicationData = {
      beverageType: "wine",
      brandName: "RIDGE CREEK",
      classType: "Cabernet Sauvignon",
      netContents: "750 mL",
    };
    const wineLabel: ExtractedLabel = {
      ...clean,
      brandName: f("RIDGE CREEK"),
      classType: f("Cabernet Sauvignon"),
      alcoholContent: f("14.5% Alc./Vol."),
    };
    const r = verifyLabel(wineApp, wineLabel);
    expect(r.fields.find((x) => x.field === "alcoholContent")?.verdict).toBe("NEEDS_CORRECTION");
    expect(r.overall).toBe("NEEDS_CORRECTION");
  });
  it("malt beverage ABV is optional, but when the label states one it still surfaces as an informational note (no field row)", () => {
    const maltApp: ApplicationData = {
      beverageType: "malt-beverage",
      brandName: "HOPYARD",
      classType: "India Pale Ale",
      netContents: "12 FL OZ",
    };
    const maltLabel: ExtractedLabel = {
      ...clean,
      brandName: f("HOPYARD"),
      classType: f("India Pale Ale"),
      alcoholContent: f("6.5% Alc./Vol."),
      netContents: f("12 FL OZ"),
    };
    const r = verifyLabel(maltApp, maltLabel);
    expect(r.fields.find((x) => x.field === "alcoholContent")).toBeUndefined();
    expect(r.overall).toBe("APPROVED");
    expect(r.warnings.join(" ")).toMatch(/6\.5% Alc\.\/Vol\./);
  });
  it("app-provided nameAndAddress missing on label is NEEDS_CORRECTION", () => {
    const importApp: ApplicationData = {
      beverageType: "wine",
      brandName: "KIRKBRIDE",
      classType: "Red Wine",
      alcoholContent: "13% Alc./Vol.",
      netContents: "750 mL",
      nameAndAddress: "Imported by Kirkbride Cellars, New York, NY",
    };
    const importLabel: ExtractedLabel = {
      ...clean,
      brandName: f("KIRKBRIDE"),
      classType: f("Red Wine"),
      alcoholContent: f("13% Alc./Vol."),
    };
    const r = verifyLabel(importApp, importLabel);
    expect(r.fields.find((x) => x.field === "nameAndAddress")?.verdict).toBe("NEEDS_CORRECTION");
    expect(r.overall).toBe("NEEDS_CORRECTION");
  });
  it("matches importer name/address and country of origin when the application provides them", () => {
    const importApp: ApplicationData = {
      beverageType: "wine",
      brandName: "KIRKBRIDE",
      classType: "Red Wine",
      alcoholContent: "13% Alc./Vol.",
      netContents: "750 mL",
      nameAndAddress: "Imported by Kirkbride Cellars, New York, NY",
      countryOfOrigin: "France",
    };
    const importLabel: ExtractedLabel = {
      ...clean,
      brandName: f("KIRKBRIDE"),
      classType: f("Red Wine"),
      alcoholContent: f("13% Alc./Vol."),
      nameAndAddress: f("Imported by Kirkbride Cellars, New York, NY"),
      countryOfOrigin: f("France"),
    };
    const r = verifyLabel(importApp, importLabel);
    expect(r.fields.find((x) => x.field === "nameAndAddress")?.verdict).toBe("COMPLIANT");
    expect(r.fields.find((x) => x.field === "countryOfOrigin")?.verdict).toBe("COMPLIANT");
    expect(r.overall).toBe("APPROVED");
  });
  it("downgrades a byte-perfect warning at low extraction confidence to NEEDS_CORRECTION", () => {
    const lowConfWarning = { ...clean, healthWarningStatement: f(HEALTH_WARNING_TEXT, 0.3) };
    const r = verifyLabel(app, lowConfWarning);
    expect(r.fields.find((x) => x.field === "healthWarningStatement")?.verdict).toBe("NEEDS_CORRECTION");
    expect(r.overall).toBe("NEEDS_CORRECTION");
  });
  it("model-reported confidence is one-directional: it can never rescue a NON_COMPLIANT or upgrade a NEEDS_CORRECTION", () => {
    // Prompt-injection posture (audit §2): a cloud model can self-report confidence: 1.0 on a wrong or
    // uncertain field. Confidence must only ever move a verdict toward NEEDS_CORRECTION — never suppress a NON_COMPLIANT
    // (which would manufacture an APPROVED) nor turn a NEEDS_CORRECTION into a COMPLIANT.
    const wrongAbvHighConf = { ...clean, alcoholContent: f("40% Alc./Vol.", 1) };
    const mismatch = verifyLabel(app, wrongAbvHighConf);
    expect(mismatch.fields.find((x) => x.field === "alcoholContent")?.verdict).toBe("NON_COMPLIANT");
    expect(mismatch.overall).toBe("REJECTED");

    const brandCaseHighConf = { ...clean, brandName: f("Old Tom Distillery", 1) };
    const review = verifyLabel(app, brandCaseHighConf);
    expect(review.fields.find((x) => x.field === "brandName")?.verdict).toBe("NEEDS_CORRECTION");
  });
  it("treats an empty-string extracted value as missing (NEEDS_CORRECTION), not a nonsense NON_COMPLIANT", () => {
    const emptyBrand = { ...clean, brandName: { value: "", present: true, confidence: 0.9 } };
    const r = verifyLabel(app, emptyBrand);
    expect(r.fields.find((x) => x.field === "brandName")?.verdict).toBe("NEEDS_CORRECTION");
    expect(r.overall).toBe("NEEDS_CORRECTION");
  });
  it("FieldResult.confidence matches the underlying extracted field's confidence", () => {
    const r = verifyLabel(app, { ...clean, classType: f("Kentucky Straight Bourbon Whiskey", 0.73) });
    expect(r.fields.find((x) => x.field === "classType")?.confidence).toBe(0.73);
  });
  it("a missing field's FieldResult has confidence 0", () => {
    const noNet = { ...clean, netContents: f(null) };
    const r = verifyLabel(app, noNet);
    expect(r.fields.find((x) => x.field === "netContents")?.confidence).toBe(0);
  });

  it("import application missing country of origin gets a visible NEEDS_CORRECTION row", () => {
    const importApp: ApplicationData = {
      beverageType: "wine",
      brandName: "KIRKBRIDE",
      classType: "Red Wine",
      alcoholContent: "13% Alc./Vol.",
      netContents: "750 mL",
      isImport: true,
    };
    const r = verifyLabel(importApp, {
      ...clean,
      brandName: f("KIRKBRIDE"),
      classType: f("Red Wine"),
      alcoholContent: f("13% Alc./Vol."),
    });
    const row = r.fields.find((x) => x.field === "countryOfOrigin");
    expect(row?.verdict).toBe("NEEDS_CORRECTION");
    expect(row?.reason).toMatch(/required for imported products/i);
    expect(r.overall).toBe("NEEDS_CORRECTION");
  });
  it("import application WITH country of origin still matches normally (isImport doesn't change the comparison itself)", () => {
    const importApp: ApplicationData = {
      beverageType: "wine",
      brandName: "KIRKBRIDE",
      classType: "Red Wine",
      alcoholContent: "13% Alc./Vol.",
      netContents: "750 mL",
      countryOfOrigin: "France",
      isImport: true,
    };
    const r = verifyLabel(importApp, {
      ...clean,
      brandName: f("KIRKBRIDE"),
      classType: f("Red Wine"),
      alcoholContent: f("13% Alc./Vol."),
      countryOfOrigin: f("France"),
    });
    expect(r.fields.find((x) => x.field === "countryOfOrigin")?.verdict).toBe("COMPLIANT");
    expect(r.overall).toBe("APPROVED");
  });
  it("domestic application (isImport false/unset) omitting country of origin is unaffected — no row, no requirement", () => {
    const r = verifyLabel(app, clean); // `app` has no isImport; `clean` has countryOfOrigin: f(null)
    expect(r.fields.find((x) => x.field === "countryOfOrigin")).toBeUndefined();
    expect(r.overall).toBe("APPROVED");
  });
  it("countryOfOrigin in two different non-Latin scripts is NEEDS_CORRECTION through the full verify pipeline, never a false APPROVED (D2a, 2026-07-25)", () => {
    const importApp: ApplicationData = {
      beverageType: "wine",
      brandName: "KIRKBRIDE",
      classType: "Red Wine",
      alcoholContent: "13% Alc./Vol.",
      netContents: "750 mL",
      countryOfOrigin: "日本",
    };
    const importLabel: ExtractedLabel = {
      ...clean,
      brandName: f("KIRKBRIDE"),
      classType: f("Red Wine"),
      alcoholContent: f("13% Alc./Vol."),
      countryOfOrigin: f("中国"),
    };
    const r = verifyLabel(importApp, importLabel);
    expect(r.fields.find((x) => x.field === "countryOfOrigin")?.verdict).toBe("NEEDS_CORRECTION");
    expect(r.overall).toBe("NEEDS_CORRECTION"); // NEEDS_CORRECTION is its own disposition — still never a REJECTION
  });
});
