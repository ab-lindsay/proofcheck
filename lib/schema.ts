import { z } from "zod";

export const BeverageTypeSchema = z.enum(["distilled-spirits", "wine", "malt-beverage"]);
export type BeverageType = z.infer<typeof BeverageTypeSchema>;

export const ApplicationDataSchema = z.object({
  beverageType: BeverageTypeSchema,
  brandName: z.string().min(1, "Brand name is required"),
  classType: z.string().min(1, "Class/type designation is required"),
  alcoholContent: z.string().optional(),
  netContents: z.string().min(1, "Net contents is required"),
  nameAndAddress: z.string().optional(),
  countryOfOrigin: z.string().optional(),
  isImport: z.boolean().optional(), // drives countryOfOrigin requiredness only — see isCountryOfOriginRequired
});
export type ApplicationData = z.infer<typeof ApplicationDataSchema>;

export const BoundingBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

export const ExtractedFieldSchema = z.object({
  // .max(2000) (D5, 2026-07-25 hardening): model output is untrusted (threat model LLM01/LLM05) and
  // was unbounded — a hostile or looping model could return megabytes per field, flowing into
  // levenshtein's O(m*n), the JSON response, the CSV export, and the DOM. The longest legitimate
  // field is the health warning statement at ~300 chars, so 2000 leaves ~7x headroom while failing
  // closed at the same schema boundary a malformed extraction already does.
  value: z.string().max(2000).nullable(),
  present: z.boolean(),
  confidence: z.number().min(0).max(1),
  boundingBox: BoundingBoxSchema.nullish(),
});
export type ExtractedField = z.infer<typeof ExtractedFieldSchema>;

export const ExtractedLabelSchema = z.object({
  brandName: ExtractedFieldSchema,
  classType: ExtractedFieldSchema,
  alcoholContent: ExtractedFieldSchema,
  netContents: ExtractedFieldSchema,
  nameAndAddress: ExtractedFieldSchema,
  countryOfOrigin: ExtractedFieldSchema,
  healthWarningStatement: ExtractedFieldSchema, // verbatim, case preserved; text begins "GOVERNMENT WARNING:"
});
export type ExtractedLabel = z.infer<typeof ExtractedLabelSchema>;

export type Verdict = "COMPLIANT" | "NON_COMPLIANT" | "NEEDS_CORRECTION";

export interface FieldResult {
  field: keyof ExtractedLabel;
  applicationValue: string | null;
  labelValue: string | null;
  verdict: Verdict;
  reason: string; // plain-English, agent-facing
  confidence: number; // 0..1, the extracted field's own confidence
}

/**
 * Mirrors the dispositions TTB itself uses in COLAs Online, which are not binary: an application
 * TTB "cannot approve as submitted" comes back as Needs Correction — an intermediate step, not a
 * denial. https://www.ttb.gov/system/files/images/pdfs/labeling_colas-docs/eapplication-statuses-in-colas.pdf
 *
 * The middle state exists so an unverified field never surfaces as an approval. Reporting APPROVED
 * for a label with a field we could not read is a silent pass, which the fail-closed rule forbids —
 * and it inverts the human workflow, where an agent who cannot read a label rejects it and asks for
 * a better image rather than waving it through.
 */
export type Overall = "APPROVED" | "NEEDS_CORRECTION" | "REJECTED";

/** Display form. The wire/CSV value keeps the underscore; only humans see the space. */
export const OVERALL_LABELS: Record<Overall, string> = {
  APPROVED: "APPROVED",
  NEEDS_CORRECTION: "NEEDS CORRECTION",
  REJECTED: "REJECTED",
};

export interface VerificationResult {
  // REJECTED iff any field is NON_COMPLIANT; NEEDS_CORRECTION iff no rejection but some field needs
  // one. NEEDS_CORRECTION still never causes a REJECTION — it is its own disposition.
  overall: Overall;
  fields: FieldResult[];
  warnings: string[];
  processingMs: number;
}

export const FIELD_LABELS: Record<keyof ExtractedLabel, string> = {
  brandName: "Brand name",
  classType: "Class / type designation",
  alcoholContent: "Alcohol content",
  netContents: "Net contents",
  nameAndAddress: "Name and address",
  countryOfOrigin: "Country of origin",
  healthWarningStatement: "Health warning statement",
};
