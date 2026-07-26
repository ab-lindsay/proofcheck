import { describe, expect, it } from "vitest";
import { buildSampleCsv, buildTemplateCsv, escapeCsvCell, parseApplicationsCsv, toResultsCsv } from "@/lib/csv";
import { BATCH_SAMPLES } from "@/lib/samples";

describe("parseApplicationsCsv", () => {
  it("parses valid rows into applications", () => {
    const csv = [
      "image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin",
      "a.png,distilled-spirits,OLD TOM,Bourbon,45% Alc./Vol.,750 mL,,",
    ].join("\n");
    const { rows, errors } = parseApplicationsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe("a.png");
    expect(rows[0].application.brandName).toBe("OLD TOM");
    expect(rows[0].application.nameAndAddress).toBeUndefined();
  });
  it("reports bad rows without dropping good ones", () => {
    const csv = [
      "image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin",
      "a.png,cider,X,Y,,750 mL,,",
      "b.png,wine,RIDGE,Red Table Wine,,750 mL,,",
    ].join("\n");
    const { rows, errors } = parseApplicationsCsv(csv);
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/row 2/i);
  });
  it("rejects duplicate image_filename rows (result rows are keyed by filename)", () => {
    const csv = [
      "image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin",
      "a.png,wine,RIDGE,Red Table Wine,,750 mL,,",
      "a.png,wine,RIDGE,Red Table Wine,,750 mL,,",
    ].join("\n");
    const { rows, errors } = parseApplicationsCsv(csv);
    expect(rows).toHaveLength(1);
    expect(errors[0]).toMatch(/duplicate/i);
  });
  it("rejects a CSV missing required headers", () => {
    const { rows, errors } = parseApplicationsCsv("filename,brand\na.png,X");
    expect(rows).toEqual([]);
    expect(errors[0]).toMatch(/image_filename/);
  });
  it("parses is_import as yes/true/1 (case-insensitive) -> true, everything else -> false", () => {
    const csv = [
      "image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin,is_import",
      "a.png,wine,KIRKBRIDE,Red Wine,13% Alc./Vol.,750 mL,,France,YES",
      "b.png,wine,KIRKBRIDE,Red Wine,13% Alc./Vol.,750 mL,,France,true",
      "c.png,wine,KIRKBRIDE,Red Wine,13% Alc./Vol.,750 mL,,France,1",
      "d.png,distilled-spirits,OLD TOM,Bourbon,45% Alc./Vol.,750 mL,,,no",
    ].join("\n");
    const { rows, errors } = parseApplicationsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows.find((r) => r.filename === "a.png")!.application.isImport).toBe(true);
    expect(rows.find((r) => r.filename === "b.png")!.application.isImport).toBe(true);
    expect(rows.find((r) => r.filename === "c.png")!.application.isImport).toBe(true);
    expect(rows.find((r) => r.filename === "d.png")!.application.isImport).toBe(false);
  });
  it("is backward-compatible with CSVs written before is_import existed: missing column parses fine, defaults to not-import", () => {
    const csv = [
      "image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin",
      "a.png,distilled-spirits,OLD TOM,Bourbon,45% Alc./Vol.,750 mL,,",
    ].join("\n");
    const { rows, errors } = parseApplicationsCsv(csv);
    expect(errors).toEqual([]);
    expect(rows[0].application.isImport).toBe(false);
  });
});

describe("escapeCsvCell", () => {
  it("prefixes formula-leading cells with a quote", () => {
    expect(escapeCsvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(escapeCsvCell("+1")).toBe("'+1");
    expect(escapeCsvCell("-1")).toBe("'-1");
    expect(escapeCsvCell("@cmd")).toBe("'@cmd");
    expect(escapeCsvCell("`formula")).toBe("'`formula");
    expect(escapeCsvCell("|pipe")).toBe("'|pipe");
  });
  it("quotes cells containing commas, quotes, or newlines", () => {
    expect(escapeCsvCell('a,"b"')).toBe('"a,""b"""');
  });
  it("quotes a value containing a carriage return (prevents row-splitting / injection escape)", () => {
    expect(escapeCsvCell("a\rb")).toBe('"a\rb"');
    expect(escapeCsvCell("500 mL\r=cmd|'/c calc'!A1")).toBe(`"500 mL\r=cmd|'/c calc'!A1"`);
  });
  it("neutralizes a formula hidden behind a leading tab", () => {
    // Excel/Sheets strip a leading TAB, exposing the formula in the next character — treat it like the
    // other formula-trigger prefixes.
    expect(escapeCsvCell("\t=1+1")).toBe("'\t=1+1");
  });
  it("prefixes tilde-leading cells with a quote (Google Sheets formula trigger)", () => {
    expect(escapeCsvCell("~SUM(A1)")).toBe("'~SUM(A1)");
  });
  it("leaves plain cells alone", () => {
    expect(escapeCsvCell("750 mL")).toBe("750 mL");
  });
});

describe("toResultsCsv / buildTemplateCsv", () => {
  it("round-trips headers", () => {
    expect(buildTemplateCsv().split("\n")[0]).toContain("image_filename");
    const csv = toResultsCsv([
      {
        filename: "a.png",
        status: "done",
        result: {
          overall: "APPROVED",
          fields: [],
          warnings: [],
          processingMs: 900,
          tier: "mock",
          provider: "mock",
          beverageType: "distilled-spirits",
        },
      },
    ]);
    expect(csv.split("\n")[0]).toBe("image_filename,overall,issues,detail");
    expect(csv).toContain("a.png,APPROVED,0,");
  });
  it("uses the plain-English field label in the detail column, not the raw camelCase field key", () => {
    const csv = toResultsCsv([
      {
        filename: "a.png",
        status: "done",
        result: {
          overall: "REJECTED",
          fields: [
            {
              field: "healthWarningStatement",
              applicationValue: "GOVERNMENT WARNING: ...",
              labelValue: null,
              verdict: "NON_COMPLIANT",
              reason: "Missing from the label.",
              confidence: 0.9,
            },
          ],
          warnings: [],
          processingMs: 500,
          tier: "mock",
          provider: "mock",
          beverageType: "distilled-spirits",
        },
      },
    ]);
    expect(csv).toContain("Health warning statement: Missing from the label.");
    expect(csv).not.toContain("healthWarningStatement:");
  });

  it("renders an ERROR row with the error message for failed items", () => {
    const csv = toResultsCsv([{ filename: "b.png", status: "error", error: "Extraction timed out" }]);
    expect(csv.split("\n")[1]).toBe("b.png,ERROR,,Extraction timed out");
  });
  it("falls back to a generic message for a non-done item with no error set", () => {
    const csv = toResultsCsv([{ filename: "c.png", status: "queued" }]);
    expect(csv.split("\n")[1]).toBe("c.png,ERROR,,not processed");
  });
});

describe("buildSampleCsv", () => {
  it("round-trips through parseApplicationsCsv with no errors", () => {
    const { rows, errors } = parseApplicationsCsv(buildSampleCsv());
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(BATCH_SAMPLES.length);
  });

  it("preserves each sample's application data exactly", () => {
    const { rows } = parseApplicationsCsv(buildSampleCsv());
    for (const sample of BATCH_SAMPLES) {
      const row = rows.find((r) => r.filename === sample.name);
      expect(row, `no row for ${sample.name}`).toBeDefined();
      // Empty optional strings are normalized to undefined by the parser, so compare field by field
      // against the same normalization rather than deep-equalling the source object.
      expect(row!.application.brandName).toBe(sample.app.brandName);
      expect(row!.application.beverageType).toBe(sample.app.beverageType);
      expect(row!.application.netContents).toBe(sample.app.netContents);
      expect(row!.application.nameAndAddress ?? "").toBe(sample.app.nameAndAddress ?? "");
    }
  });

  it("quotes values containing commas so they survive the round trip", () => {
    const csv = buildSampleCsv();
    // "Old Tom Distillery Co., Bardstown, KY" has embedded commas.
    expect(csv).toContain('"Old Tom Distillery Co., Bardstown, KY"');
    const { rows } = parseApplicationsCsv(csv);
    expect(rows.find((r) => r.filename === "old-tom-clean.png")!.application.nameAndAddress).toBe(
      "Old Tom Distillery Co., Bardstown, KY",
    );
  });

  it("uses the same header row as the template", () => {
    expect(buildSampleCsv().split("\n")[0]).toBe(buildTemplateCsv().split("\n")[0]);
  });
});
