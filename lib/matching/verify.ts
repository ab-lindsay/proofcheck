import type {
  ApplicationData,
  ExtractedField,
  ExtractedLabel,
  FieldResult,
  Overall,
  VerificationResult,
} from "@/lib/schema";
import { FIELD_LABELS } from "@/lib/schema";
import { isAlcoholContentRequired, isCountryOfOriginRequired } from "@/lib/ttb/required-fields";
import { fuzzyVerdict } from "@/lib/matching/fuzzy";
import { checkHealthWarning } from "@/lib/matching/warning";
import { checkAlcoholContent, checkNetContents } from "@/lib/matching/numeric";

// Exported so lib/matching/verify.test.ts and components/field-row.tsx's confidence-tier display
// share the exact same boundaries — the displayed tier can never disagree with the actual
// NEEDS_CORRECTION-downgrade decision a field already went through.
export const CONFIDENCE_NEEDS_CORRECTION_THRESHOLD = 0.5;
export const CONFIDENCE_HIGH_THRESHOLD = 0.8;

function missing(field: keyof ExtractedLabel, applicationValue: string): FieldResult {
  return {
    field,
    applicationValue,
    labelValue: null,
    verdict: "NEEDS_CORRECTION",
    confidence: 0,
    reason: `${FIELD_LABELS[field]} was not found on the label — verify by eye.`,
  };
}

// Extraction confidence is treated as UNTRUSTED and strictly ONE-DIRECTIONAL: it may only downgrade a
// COMPLIANT to NEEDS_CORRECTION, never upgrade a verdict or rescue a NON_COMPLIANT. So a prompt-injected cloud model that
// self-reports confidence: 1.0 can never manufacture an APPROVED (NEEDS_CORRECTION never causes REJECTED either) — the worst
// it achieves is forgoing this extra "verify by eye" nudge, while deterministic matching and the always-on
// health-warning bold-check note still stand. Deriving confidence from an independent signal (cross-checking
// the cloud transcription against local-ocr) is a documented, deferred hardening (audit §2); it is kept out
// of matching so this layer never branches on which tier ran (architecture rule 2).
function withConfidence(result: FieldResult, extracted: ExtractedField): FieldResult {
  const withScore = { ...result, confidence: extracted.confidence };
  if (withScore.verdict === "COMPLIANT" && extracted.confidence < CONFIDENCE_NEEDS_CORRECTION_THRESHOLD) {
    return {
      ...withScore,
      verdict: "NEEDS_CORRECTION",
      reason: `${withScore.reason} (Low extraction confidence — verify by eye.)`,
    };
  }
  return withScore;
}

export function verifyLabel(app: ApplicationData, extracted: ExtractedLabel): Omit<VerificationResult, "processingMs"> {
  const fields: FieldResult[] = [];
  const warnings: string[] = [];

  const compare = (
    field: keyof ExtractedLabel,
    appValue: string,
    check: (appValue: string, ef: ExtractedField) => FieldResult,
  ) => {
    const ef = extracted[field];
    if (!ef.present || ef.value === null || ef.value.trim() === "") fields.push(missing(field, appValue));
    else fields.push(withConfidence(check(appValue, ef), ef));
  };

  compare("brandName", app.brandName, (a, ef) =>
    fuzzyVerdict({
      field: "brandName",
      applicationValue: a,
      labelValue: ef.value as string,
      normalizedEqualIsMatch: false,
    }),
  );
  compare("classType", app.classType, (a, ef) =>
    fuzzyVerdict({
      field: "classType",
      applicationValue: a,
      labelValue: ef.value as string,
      normalizedEqualIsMatch: true,
    }),
  );

  if (app.alcoholContent) {
    compare("alcoholContent", app.alcoholContent, checkAlcoholContent);
  } else if (isAlcoholContentRequired(app)) {
    // Fail-closed: a type-required field missing from the application is a visible NEEDS_CORRECTION row
    // (not a buried note), so batch rows can never quietly sail past it.
    fields.push({
      field: "alcoholContent",
      applicationValue: null,
      labelValue: extracted.alcoholContent.value,
      verdict: "NEEDS_CORRECTION",
      confidence: extracted.alcoholContent.confidence,
      reason:
        "Alcohol content is required for this beverage type but was not provided in the application — request it.",
    });
  } else if (extracted.alcoholContent.present && extracted.alcoholContent.value) {
    warnings.push(
      `Alcohol content not in the application (optional for this type); the label shows "${extracted.alcoholContent.value}".`,
    );
  } else {
    warnings.push("Alcohol content not stated in the application or on the label — optional for this beverage type.");
  }

  compare("netContents", app.netContents, checkNetContents);

  if (app.nameAndAddress) {
    compare("nameAndAddress", app.nameAndAddress, (a, e) =>
      fuzzyVerdict({
        field: "nameAndAddress",
        applicationValue: a,
        labelValue: e.value as string,
        normalizedEqualIsMatch: true,
      }),
    );
  } else if (extracted.nameAndAddress.present && extracted.nameAndAddress.value) {
    warnings.push(
      `${FIELD_LABELS.nameAndAddress} not in the application; the label shows "${extracted.nameAndAddress.value}".`,
    );
  }

  if (app.countryOfOrigin) {
    compare("countryOfOrigin", app.countryOfOrigin, (a, e) =>
      fuzzyVerdict({
        field: "countryOfOrigin",
        applicationValue: a,
        labelValue: e.value as string,
        normalizedEqualIsMatch: true,
      }),
    );
  } else if (isCountryOfOriginRequired(app)) {
    // Fail-closed, mirroring the alcoholContent required-field row above: an import application that
    // omits country of origin is a visible NEEDS_CORRECTION row, not a buried note.
    fields.push({
      field: "countryOfOrigin",
      applicationValue: null,
      labelValue: extracted.countryOfOrigin.value,
      verdict: "NEEDS_CORRECTION",
      confidence: extracted.countryOfOrigin.confidence,
      reason:
        "Country of origin is required for imported products but was not provided in the application — request it.",
    });
  } else if (extracted.countryOfOrigin.present && extracted.countryOfOrigin.value) {
    warnings.push(
      `${FIELD_LABELS.countryOfOrigin} not in the application; the label shows "${extracted.countryOfOrigin.value}".`,
    );
  }

  fields.push(withConfidence(checkHealthWarning(extracted.healthWarningStatement), extracted.healthWarningStatement));
  if (extracted.healthWarningStatement.present) {
    warnings.push('Bold formatting of "GOVERNMENT WARNING" cannot be verified from extracted text — check visually.');
  }

  // Order matters: a rejection outranks a correction, so a label with both is REJECTED. Anything
  // not rejected is NOT automatically approved — a field we could not verify yields
  // NEEDS_CORRECTION, so an unread field can never surface as a clean pass.
  const overall: Overall = fields.some((x) => x.verdict === "NON_COMPLIANT")
    ? "REJECTED"
    : fields.some((x) => x.verdict === "NEEDS_CORRECTION")
      ? "NEEDS_CORRECTION"
      : "APPROVED";
  return { overall, fields, warnings };
}
