import { describe, expect, it } from "vitest";
import { isAlcoholContentRequired, isCountryOfOriginRequired } from "@/lib/ttb/required-fields";
import type { ApplicationData } from "@/lib/schema";

const base: ApplicationData = {
  beverageType: "wine",
  brandName: "B",
  classType: "Red Table Wine",
  netContents: "750 mL",
};

describe("isAlcoholContentRequired", () => {
  it("is required for distilled spirits", () => {
    expect(isAlcoholContentRequired({ ...base, beverageType: "distilled-spirits", classType: "Vodka" })).toBe(true);
  });
  it("is optional for malt beverages", () => {
    expect(isAlcoholContentRequired({ ...base, beverageType: "malt-beverage", classType: "Lager" })).toBe(false);
  });
  it("wine: optional at <=14% only with table/light designation", () => {
    expect(isAlcoholContentRequired(base)).toBe(false); // "Table Wine", no ABV stated
    expect(isAlcoholContentRequired({ ...base, classType: "Cabernet Sauvignon" })).toBe(true);
    expect(isAlcoholContentRequired({ ...base, alcoholContent: "15.5% Alc./Vol." })).toBe(true); // >14 → required
  });
});

describe("isCountryOfOriginRequired", () => {
  it("is required when isImport is true, regardless of beverage type", () => {
    expect(isCountryOfOriginRequired({ ...base, isImport: true })).toBe(true);
    expect(isCountryOfOriginRequired({ ...base, beverageType: "distilled-spirits", isImport: true })).toBe(true);
    expect(isCountryOfOriginRequired({ ...base, beverageType: "malt-beverage", isImport: true })).toBe(true);
  });
  it("is not required when isImport is false or unset (domestic)", () => {
    expect(isCountryOfOriginRequired({ ...base, isImport: false })).toBe(false);
    expect(isCountryOfOriginRequired(base)).toBe(false); // isImport unset
  });
});
