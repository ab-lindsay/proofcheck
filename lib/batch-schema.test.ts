import { describe, expect, it } from "vitest";
import { BatchResponseSchema } from "@/lib/batch-schema";

const validField = {
  field: "brandName",
  applicationValue: "Test Brand",
  labelValue: "Test Brand",
  verdict: "COMPLIANT" as const,
  reason: "Values match",
  confidence: 0.9,
};

const validRow = {
  filename: "label1.png",
  overall: "APPROVED" as const,
  fields: [validField],
  warnings: [],
  processingMs: 1500,
  tier: "cloud",
  provider: "bedrock",
  beverageType: "distilled-spirits" as const,
};

describe("BatchResponseSchema", () => {
  it("accepts a valid response", () => {
    const response = { results: [validRow], totalMs: 2000 };
    expect(BatchResponseSchema.safeParse(response).success).toBe(true);
  });

  it("accepts a response with an error field", () => {
    const response = {
      results: [
        {
          filename: "bad-label.png",
          overall: "REJECTED" as const,
          fields: [],
          warnings: ["Extraction failed"],
          processingMs: 500,
          tier: "local-ocr",
          provider: "local-ocr",
          beverageType: "wine" as const,
          error: "Could not process image",
        },
      ],
      totalMs: 600,
    };
    expect(BatchResponseSchema.safeParse(response).success).toBe(true);
  });

  // An item rejected before extraction (bad image, unparseable application data) has no beverage
  // type to report. The route emits "unknown" there, so the contract has to allow it — otherwise
  // validating the response would turn every per-item rejection into a whole-batch 500.
  it('accepts "unknown" as the beverage type of an item that never reached extraction', () => {
    const response = {
      results: [
        {
          filename: "not-an-image.png",
          overall: "REJECTED" as const,
          fields: [],
          warnings: [],
          processingMs: 2,
          tier: "unknown",
          provider: "unknown",
          beverageType: "unknown" as const,
          error: "Unsupported image type — please upload a PNG, JPEG, or WebP.",
        },
      ],
      totalMs: 5,
    };
    expect(BatchResponseSchema.safeParse(response).success).toBe(true);
  });

  it('rejects a beverage type that is neither a real type nor "unknown"', () => {
    const response = { results: [{ ...validRow, beverageType: "cider" }], totalMs: 10 };
    expect(BatchResponseSchema.safeParse(response).success).toBe(false);
  });

  it("rejects a confidence outside 0..1", () => {
    const response = {
      results: [{ ...validRow, fields: [{ ...validField, confidence: 90 }] }],
      totalMs: 10,
    };
    expect(BatchResponseSchema.safeParse(response).success).toBe(false);
  });

  // The route writes results by index into a pre-sized array so row order matches image order.
  // A hole would mean a worker dropped an item; the schema must not quietly accept that.
  it("rejects a results array with a hole in it", () => {
    const results = new Array(2);
    results[0] = validRow;
    expect(BatchResponseSchema.safeParse({ results, totalMs: 10 }).success).toBe(false);
  });

  // Strict, not stripping. Zod's default would silently delete an added key, so a field a developer
  // deliberately added to the response would vanish with no error to explain it. These two tests are
  // what keep that decision from being undone by accident.
  it("rejects a row carrying a key the contract does not declare", () => {
    const response = {
      results: [{ ...validRow, extraction: { trace: "added without updating the schema" } }],
      totalMs: 10,
    };
    expect(BatchResponseSchema.safeParse(response).success).toBe(false);
  });

  it("rejects a field carrying a key the contract does not declare", () => {
    const response = {
      results: [{ ...validRow, fields: [{ ...validField, citation: "27 CFR 5.63" }] }],
      totalMs: 10,
    };
    expect(BatchResponseSchema.safeParse(response).success).toBe(false);
  });
});
