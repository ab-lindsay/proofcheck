import type { BeverageType, ExtractedLabel } from "@/lib/schema";

export interface Citation {
  basis: string; // plain-English: why this field must be on the label
  cfr: string; // e.g. "27 CFR §5.65"
  url: string; // deep link to the section on eCFR
}

type Field = keyof ExtractedLabel;

// eCFR section URL builder (verified 2026-07-22 against ecfr.gov / TTB / Cornell LII).
const sec = (part: number, subpart: string, section: string) =>
  `https://www.ecfr.gov/current/title-27/chapter-I/subchapter-A/part-${part}/subpart-${subpart}/section-${section}`;

// CBP (title-19) section URL for country-of-origin marking.
const cbp = (section: string) =>
  `https://www.ecfr.gov/current/title-19/chapter-I/part-134/subpart-B/section-${section}`;

// Health warning is identical across all beverage types (Alcoholic Beverage Health Warning Statement Act).
const WARNING: Citation = {
  basis: "Every alcohol beverage at 0.5% ABV or more must bear the Government Warning statement.",
  cfr: "27 CFR §16.21",
  url: sec(16, "C", "16.21"),
};

const CITATIONS: Record<BeverageType, Partial<Record<Field, Citation>>> = {
  "distilled-spirits": {
    brandName: {
      basis: "A distilled spirits label must bear a brand name.",
      cfr: "27 CFR §5.64",
      url: sec(5, "E", "5.64"),
    },
    classType: {
      basis: "Spirits must bear a class, type, or other designation defined by the standards of identity (subpart I).",
      cfr: "27 CFR §5.63",
      url: sec(5, "E", "5.63"),
    },
    alcoholContent: {
      basis: "Spirits must state alcohol content as a percentage of alcohol by volume.",
      cfr: "27 CFR §5.65",
      url: sec(5, "E", "5.65"),
    },
    netContents: {
      basis: "Spirits must state the net contents of the container.",
      cfr: "27 CFR §5.70",
      url: sec(5, "E", "5.70"),
    },
    nameAndAddress: {
      basis: "Spirits must show the name and address of the bottler, distiller, or importer.",
      cfr: "27 CFR §5.66",
      url: sec(5, "E", "5.66"),
    },
    countryOfOrigin: {
      basis: "Imported distilled spirits must state the country of origin.",
      cfr: "27 CFR §5.69",
      url: sec(5, "E", "5.69"),
    },
    healthWarningStatement: WARNING,
  },
  wine: {
    brandName: { basis: "A wine label must bear a brand name.", cfr: "27 CFR §4.33", url: sec(4, "D", "4.33") },
    classType: {
      basis: "Wine must bear a class and type (or other permitted) designation.",
      cfr: "27 CFR §4.34",
      url: sec(4, "D", "4.34"),
    },
    alcoholContent: {
      basis: "Wine must state its alcoholic content where required for its class/type.",
      cfr: "27 CFR §4.36",
      url: sec(4, "D", "4.36"),
    },
    netContents: {
      basis: "Wine must state the net contents of the container.",
      cfr: "27 CFR §4.37",
      url: sec(4, "D", "4.37"),
    },
    nameAndAddress: {
      basis: "Wine must show the name and address of the bottler, packer, or importer.",
      cfr: "27 CFR §4.35",
      url: sec(4, "D", "4.35"),
    },
    countryOfOrigin: {
      basis: "Imported articles must be marked with the country of origin.",
      cfr: "19 CFR §134.11",
      url: cbp("134.11"),
    },
    healthWarningStatement: WARNING,
  },
  "malt-beverage": {
    brandName: {
      basis: "A malt beverage label must bear a brand name.",
      cfr: "27 CFR §7.64",
      url: sec(7, "E", "7.64"),
    },
    classType: {
      basis: "Malt beverages must bear a class, type, or other designation.",
      cfr: "27 CFR §7.63",
      url: sec(7, "E", "7.63"),
    },
    alcoholContent: {
      basis: "Malt beverage alcohol content must be stated where required.",
      cfr: "27 CFR §7.65",
      url: sec(7, "E", "7.65"),
    },
    netContents: {
      basis: "Malt beverages must state the net contents of the container.",
      cfr: "27 CFR §7.70",
      url: sec(7, "E", "7.70"),
    },
    nameAndAddress: {
      basis: "Malt beverages must show the name and address of the bottler or importer.",
      cfr: "27 CFR §7.66",
      url: sec(7, "E", "7.66"),
    },
    countryOfOrigin: {
      basis: "Imported malt beverages must state the country of origin.",
      cfr: "27 CFR §7.69",
      url: sec(7, "E", "7.69"),
    },
    healthWarningStatement: WARNING,
  },
};

export function citationFor(field: Field, beverageType: BeverageType): Citation | null {
  return CITATIONS[beverageType]?.[field] ?? null;
}
