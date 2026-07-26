import Papa from "papaparse";
import type { ApplicationData } from "@/lib/schema";
import { ApplicationDataSchema, FIELD_LABELS } from "@/lib/schema";
import { BATCH_SAMPLES } from "@/lib/samples";
import type { VerifyResponse } from "@/hooks/use-verify";

export const TEMPLATE_HEADERS = [
  "image_filename",
  "beverage_type",
  "brand_name",
  "class_type",
  "alcohol_content",
  "net_contents",
  "name_and_address",
  "country_of_origin",
  "is_import",
] as const;

// is_import is optional on ingest (not in REQUIRED_HEADERS) so CSVs written before this column
// existed still parse — a missing/blank cell defaults to false via parseIsImport.
const REQUIRED_HEADERS = TEMPLATE_HEADERS.filter((h) => h !== "is_import");

export interface BatchRow {
  filename: string;
  application: ApplicationData;
}

export interface BatchItem {
  filename: string;
  status: "queued" | "running" | "done" | "error";
  result?: VerifyResponse;
  error?: string;
}

export function buildTemplateCsv(): string {
  return [
    TEMPLATE_HEADERS.join(","),
    'old-tom-clean.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol. (90 Proof),750 mL,"Old Tom Distillery Co., Bardstown, KY",,no',
  ].join("\n");
}

/**
 * The bundled demo batch, as a CSV identical in shape to what a user would produce from the
 * template. The batch page feeds this straight back through `parseApplicationsCsv`, so the sample
 * batch exercises exactly the same ingestion path as a hand-authored upload — no privileged branch
 * that could pass while the real one is broken.
 */
export function buildSampleCsv(): string {
  const cell = (v: string | undefined) => escapeCsvCell(v ?? "");
  return [
    TEMPLATE_HEADERS.join(","),
    ...BATCH_SAMPLES.map((s) =>
      [
        cell(s.name),
        cell(s.app.beverageType),
        cell(s.app.brandName),
        cell(s.app.classType),
        cell(s.app.alcoholContent),
        cell(s.app.netContents),
        cell(s.app.nameAndAddress),
        cell(s.app.countryOfOrigin),
        cell(s.app.isImport ? "yes" : "no"),
      ].join(","),
    ),
  ].join("\n");
}

const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const parseIsImport = (v: string | undefined) => ["yes", "true", "1"].includes((v ?? "").trim().toLowerCase());

const APPLICATION_FIELD_LABELS: Record<keyof ApplicationData, string> = {
  beverageType: "Beverage type",
  brandName: "Brand name",
  classType: "Class / type designation",
  alcoholContent: "Alcohol content",
  netContents: "Net contents",
  nameAndAddress: "Name and address",
  countryOfOrigin: "Country of origin",
  isImport: "Is import",
};

// Zod's default enum message ("Invalid option: expected one of ...") is the one validation failure
// here without a plain-English custom message (brandName/classType/netContents all set their own via
// .min()) — a non-technical user reading a raw Zod message in the batch error list can't act on it.
function friendlyIssueMessage(path: PropertyKey[], message: string): string {
  const field = path[0];
  const label =
    typeof field === "string" && field in APPLICATION_FIELD_LABELS
      ? APPLICATION_FIELD_LABELS[field as keyof ApplicationData]
      : path.join(".");
  if (field === "beverageType") {
    return `${label} must be one of: distilled-spirits, wine, malt-beverage.`;
  }
  return `${label}: ${message}`;
}

export function parseApplicationsCsv(text: string): { rows: BatchRow[]; errors: string[] } {
  const parsed = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields ?? [];
  const missingHeaders = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missingHeaders.length > 0) {
    return {
      rows: [],
      errors: [
        `CSV is missing required columns: ${missingHeaders.join(", ")}. Download the template to see the expected format.`,
      ],
    };
  }
  const rows: BatchRow[] = [];
  const errors: string[] = parsed.errors.map((e) => `CSV parse error on row ${(e.row ?? 0) + 2}: ${e.message}`);
  const seen = new Set<string>();
  parsed.data.forEach((record, index) => {
    const rowNumber = index + 2; // 1-based + header row
    const filename = record.image_filename?.trim();
    if (!filename) {
      errors.push(`Row ${rowNumber}: image_filename is empty.`);
      return;
    }
    if (seen.has(filename)) {
      errors.push(`Row ${rowNumber}: duplicate image_filename "${filename}" — filenames must be unique.`);
      return;
    }
    seen.add(filename);
    const candidate = {
      beverageType: record.beverage_type?.trim(),
      brandName: record.brand_name?.trim() ?? "",
      classType: record.class_type?.trim() ?? "",
      alcoholContent: opt(record.alcohol_content),
      netContents: record.net_contents?.trim() ?? "",
      nameAndAddress: opt(record.name_and_address),
      countryOfOrigin: opt(record.country_of_origin),
      isImport: parseIsImport(record.is_import),
    };
    const result = ApplicationDataSchema.safeParse(candidate);
    if (!result.success) {
      errors.push(
        `Row ${rowNumber} (${filename}): ${result.error.issues.map((i) => friendlyIssueMessage(i.path, i.message)).join("; ")}`,
      );
      return;
    }
    rows.push({ filename, application: result.data });
  });
  return { rows, errors };
}

export function escapeCsvCell(value: string): string {
  let v = value;
  // Formula-injection guard for spreadsheet apps. Includes a leading TAB: Excel/Sheets strip it and then
  // interpret the following character, so "\t=cmd" is as dangerous as "=cmd".
  if (/^[=+\-@~\t`|]/.test(v)) v = `'${v}`;
  // Include \r (RFC 4180): a lone CR is a record separator in Excel/Sheets, so an unquoted embedded CR
  // splits the row and can start a new (unescaped) formula cell — quote it to keep the value in one cell.
  if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function toResultsCsv(items: BatchItem[]): string {
  const lines = [["image_filename", "overall", "issues", "detail"].join(",")];
  for (const item of items) {
    if (item.status === "done" && item.result) {
      const issues = item.result.fields.filter((f) => f.verdict !== "COMPLIANT");
      const detail = issues.map((f) => `${FIELD_LABELS[f.field]}: ${f.reason}`).join(" | ");
      lines.push(
        [
          escapeCsvCell(item.filename),
          escapeCsvCell(item.result.overall),
          String(issues.length),
          escapeCsvCell(detail),
        ].join(","),
      );
    } else {
      lines.push([escapeCsvCell(item.filename), "ERROR", "", escapeCsvCell(item.error ?? "not processed")].join(","));
    }
  }
  return lines.join("\n");
}
