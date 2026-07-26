import type { ExtractedField, ExtractedLabel } from "@/lib/schema";
import type { VisionProvider } from "@/lib/vision/types";
import { HEALTH_WARNING_TEXT } from "@/lib/ttb/warning";

const f = (value: string | null, confidence = 1): ExtractedField => ({
  value,
  present: value !== null,
  confidence: value === null ? 0 : confidence,
});

const label = (overrides: Partial<ExtractedLabel>): ExtractedLabel => ({
  brandName: f(null),
  classType: f(null),
  alcoholContent: f(null),
  netContents: f(null),
  nameAndAddress: f(null),
  countryOfOrigin: f(null),
  healthWarningStatement: f(HEALTH_WARNING_TEXT),
  ...overrides,
});

export const MOCK_FIXTURES: Record<string, ExtractedLabel> = {
  "old-tom-clean.png": label({
    brandName: f("OLD TOM DISTILLERY"),
    classType: f("Kentucky Straight Bourbon Whiskey"),
    alcoholContent: f("45% Alc./Vol. (90 Proof)"),
    netContents: f("750 mL"),
    nameAndAddress: f("Old Tom Distillery Co., Bardstown, KY"),
  }),
  "copper-kettle-gin.png": label({
    brandName: f("COPPER KETTLE"),
    classType: f("Gin"),
    alcoholContent: f("47% Alc./Vol. (94 Proof)"),
    netContents: f("750 mL"),
  }),
  "ridge-creek-table-wine.png": label({
    brandName: f("RIDGE CREEK"),
    classType: f("Red Table Wine"),
    netContents: f("750 mL"),
  }),
  "harbor-point-lager.png": label({
    brandName: f("HARBOR POINT"),
    classType: f("Lager"),
    netContents: f("12 FL OZ"),
    nameAndAddress: f("Brewed and bottled by Harbor Point Brewing Co., Tacoma, WA"),
  }),
  "kirkbride-import-wine.png": label({
    brandName: f("KIRKBRIDE CELLARS"),
    classType: f("White Wine"),
    alcoholContent: f("13.5% Alc./Vol."),
    netContents: f("750 mL"),
    countryOfOrigin: f("France"),
  }),
  "stones-throw-brand-case.png": label({
    brandName: f("Stone's Throw"),
    classType: f("Straight Rye Whiskey"),
    alcoholContent: f("43% Alc./Vol. (86 Proof)"),
    netContents: f("750 mL"),
  }),
  "title-case-warning.png": label({
    brandName: f("OLD TOM DISTILLERY"),
    classType: f("Kentucky Straight Bourbon Whiskey"),
    alcoholContent: f("45% Alc./Vol. (90 Proof)"),
    netContents: f("750 mL"),
    healthWarningStatement: f(HEALTH_WARNING_TEXT.replace("GOVERNMENT WARNING:", "Government Warning:")),
  }),
  "altered-warning.png": label({
    brandName: f("BLUE HERON"),
    classType: f("Vodka"),
    alcoholContent: f("40% Alc./Vol. (80 Proof)"),
    netContents: f("750 mL"),
    healthWarningStatement: f(HEALTH_WARNING_TEXT.replace("birth defects", "health issues")),
  }),
  "all-caps-warning.png": label({
    brandName: f("NORTH HARBOR"),
    classType: f("Gin"),
    alcoholContent: f("44% Alc./Vol. (88 Proof)"),
    netContents: f("750 mL"),
    healthWarningStatement: f(HEALTH_WARNING_TEXT.toUpperCase()),
  }),
  "wrong-abv.png": label({
    brandName: f("BLACK RIVER"),
    classType: f("Straight Bourbon Whiskey"),
    alcoholContent: f("40% Alc./Vol. (80 Proof)"),
    netContents: f("750 mL"),
  }),
  "wrong-brand.png": label({
    brandName: f("RIVERBEND SPIRITS"),
    classType: f("Straight Bourbon Whiskey"),
    alcoholContent: f("45% Alc./Vol. (90 Proof)"),
    netContents: f("750 mL"),
  }),
  "missing-net-contents.png": label({
    brandName: f("GOLDEN GATE"),
    classType: f("Gin"),
    alcoholContent: f("46% Alc./Vol. (92 Proof)"),
  }),
  "missing-warning.png": label({
    brandName: f("SILVER CREST"),
    classType: f("Vodka"),
    alcoholContent: f("40% Alc./Vol. (80 Proof)"),
    netContents: f("750 mL"),
    healthWarningStatement: f(null),
  }),
  "wrong-class-type.png": label({
    brandName: f("CASCADE VALLEY"),
    classType: f("Blended Scotch Whisky"),
    alcoholContent: f("40% Alc./Vol. (80 Proof)"),
    netContents: f("750 mL"),
    nameAndAddress: f("Cascade Valley Distillery, Portland, OR"),
  }),
  "wrong-net-contents.png": label({
    brandName: f("PACIFIC SHORE"),
    classType: f("Vodka"),
    alcoholContent: f("40% Alc./Vol. (80 Proof)"),
    netContents: f("1 L"),
    nameAndAddress: f("Pacific Shore Spirits Co., Seattle, WA"),
  }),
  "missing-name-and-address.png": label({
    brandName: f("SUMMIT PEAK"),
    classType: f("Single Malt Whiskey"),
    alcoholContent: f("46% Alc./Vol. (92 Proof)"),
    netContents: f("750 mL"),
  }),
};

export const SAMPLE_FILENAMES = Object.keys(MOCK_FIXTURES);

export function isMockSample(filename: string): boolean {
  // Object.hasOwn, not `in`: the latter matches inherited keys ("toString", "constructor", …).
  return Object.hasOwn(MOCK_FIXTURES, filename);
}

export const mockProvider: VisionProvider = {
  name: "mock",
  async extract(_image, meta) {
    const fixture =
      meta.filename && Object.hasOwn(MOCK_FIXTURES, meta.filename) ? MOCK_FIXTURES[meta.filename] : undefined;
    if (!fixture) {
      throw new Error(
        `The mock tier only recognizes bundled sample labels (got "${meta.filename ?? "unnamed"}"). Upload a real label with the local-ocr or cloud tier.`,
      );
    }
    return fixture;
  },
};
