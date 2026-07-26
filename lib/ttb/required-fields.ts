import type { ApplicationData } from "@/lib/schema";
import { normalizeLoose, parseAlcoholContent } from "@/lib/ttb/normalize";

/**
 * Beverage type drives field REQUIREDNESS only (spec §6).
 * Alcohol content: required for distilled spirits (27 CFR 5.65,
 * https://www.ecfr.gov/current/title-27/chapter-I/subchapter-A/part-5/subpart-E) and wine >14% ABV;
 * optional for wine <=14% ONLY when designated "table wine"/"light wine" (27 CFR 4.36,
 * https://www.ecfr.gov/current/title-27/chapter-I/subchapter-A/part-4/subpart-D/section-4.36);
 * optional for malt beverages (27 CFR Part 7,
 * https://www.ecfr.gov/current/title-27/chapter-I/subchapter-A/part-7).
 */
export function isAlcoholContentRequired(app: ApplicationData): boolean {
  switch (app.beverageType) {
    case "distilled-spirits":
      return true;
    case "malt-beverage":
      return false;
    case "wine": {
      const parsed = app.alcoholContent ? parseAlcoholContent(app.alcoholContent) : null;
      if (parsed && parsed.abv > 14) return true;
      const ct = normalizeLoose(app.classType);
      return !(ct.includes("table wine") || ct.includes("light wine"));
    }
  }
}

/**
 * Country of origin: required when the application is for an imported product, not applicable to
 * domestic products (spec §6 table; brief: "Country of origin for imports"). Imported alcohol
 * beverage containers must carry a country-of-origin statement under U.S. Customs marking rules (19
 * CFR Part 134), and TTB's own COLA review checks for a certificate of origin per 27 CFR 4.45 (wine)
 * and 5.52(e) (distilled spirits) —
 * https://www.ttb.gov/import-export/itd/certificate-of-age-and-origin-requirements-for-imported-alcohol-beverages.
 * `isImport` is an explicit application-data flag rather than inferred, since there is no reliable
 * signal to infer it from (countryOfOrigin's own presence would be circular; nameAndAddress text like
 * "Imported by..." is extracted-label data, not ground truth).
 */
export function isCountryOfOriginRequired(app: ApplicationData): boolean {
  return app.isImport === true;
}
