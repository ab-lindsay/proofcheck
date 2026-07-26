import type { ExtractedField, FieldResult } from "@/lib/schema";
import { abvToProof, parseAlcoholContent, parseNetContents } from "@/lib/ttb/normalize";

const ABV_TOLERANCE = 0.15;
// D2b (false-NON_COMPLIANT, MED-HIGH, 2026-07-25 hardening): a flat 1 mL absolute tolerance fails
// legitimate mL<->fl-oz round-trips at real bottle sizes — "25.4 FL OZ" (a common 750 mL label
// reading) converts to 751.167 mL, 0.167 mL over a flat 1 mL bound. 0.5% of the APPLICATION's
// stated volume scales with bottle size instead: 750 mL -> 3.75 mL tolerance (25.4 FL OZ passes
// with real headroom), 1.75 L -> 8.75 mL (59.2 FL OZ passes). The 1 mL floor keeps tiny/zero
// volumes from getting a zero tolerance.
const MIN_ML_TOLERANCE = 1;
const RELATIVE_ML_TOLERANCE = 0.005;

function mlTolerance(applicationMl: number): number {
  return Math.max(MIN_ML_TOLERANCE, RELATIVE_ML_TOLERANCE * applicationMl);
}

export function checkAlcoholContent(applicationValue: string, field: ExtractedField): FieldResult {
  // confidence: 0 is a placeholder — verify.ts's withConfidence() always overwrites it.
  const base = { field: "alcoholContent" as const, applicationValue, labelValue: field.value, confidence: 0 };
  const app = parseAlcoholContent(applicationValue);
  const label = field.value ? parseAlcoholContent(field.value) : null;
  if (!app)
    return {
      ...base,
      verdict: "NEEDS_CORRECTION",
      reason: `Could not read a numeric ABV from the application value "${applicationValue}" — check manually.`,
    };
  if (!label)
    return {
      ...base,
      verdict: "NEEDS_CORRECTION",
      reason: `Could not read a numeric ABV from the label ("${field.value ?? ""}") — check manually.`,
    };

  // Internal consistency: if the label states both % and proof, they must agree (proof = 2 x ABV).
  const pct = field.value!.match(/(\d+(?:\.\d+)?)\s*%/);
  const proof = field.value!.match(/(\d+(?:\.\d+)?)\s*proof/i);
  if (pct && proof && Math.abs(parseFloat(proof[1]) - abvToProof(parseFloat(pct[1]))) > ABV_TOLERANCE * 2) {
    return {
      ...base,
      verdict: "NON_COMPLIANT",
      reason: `Label is internally inconsistent: ${pct[1]}% ABV implies ${abvToProof(parseFloat(pct[1]))} proof, but it says ${proof[1]} proof.`,
    };
  }

  if (Math.abs(app.abv - label.abv) <= ABV_TOLERANCE) {
    return { ...base, verdict: "COMPLIANT", reason: `Alcohol content agrees (${app.abv}% ABV).` };
  }
  return {
    ...base,
    verdict: "NON_COMPLIANT",
    reason: `Label shows ${label.abv}% ABV but the application says ${app.abv}% ABV.`,
  };
}

export function checkNetContents(applicationValue: string, field: ExtractedField): FieldResult {
  // confidence: 0 is a placeholder — verify.ts's withConfidence() always overwrites it.
  const base = { field: "netContents" as const, applicationValue, labelValue: field.value, confidence: 0 };
  const app = parseNetContents(applicationValue);
  const label = field.value ? parseNetContents(field.value) : null;
  if (!app)
    return {
      ...base,
      verdict: "NEEDS_CORRECTION",
      reason: `Could not read a volume from the application value "${applicationValue}" — check manually.`,
    };
  if (!label)
    return {
      ...base,
      verdict: "NEEDS_CORRECTION",
      reason: `Could not read a volume from the label ("${field.value ?? ""}") — check manually.`,
    };
  if (Math.abs(app.ml - label.ml) <= mlTolerance(app.ml)) {
    return { ...base, verdict: "COMPLIANT", reason: "Net contents agree." };
  }
  return {
    ...base,
    verdict: "NON_COMPLIANT",
    reason: `Label shows ${field.value} but the application says ${applicationValue}.`,
  };
}
