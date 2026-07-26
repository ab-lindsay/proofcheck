import { readFile } from "node:fs/promises";
import { describe, beforeAll, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { BatchRowResultSchema } from "@/lib/batch-schema";

describe("openapi.yaml", () => {
  let spec: ReturnType<typeof parseYaml>;

  beforeAll(async () => {
    const text = await readFile("openapi.yaml", "utf8");
    spec = parseYaml(text);
  });

  it("has no unresolved $ref", () => {
    const definitions = spec.components?.schemas ?? {};
    const findRefs = (obj: unknown): string[] => {
      if (typeof obj !== "object" || obj === null) return [];
      if ("$ref" in obj) return [(obj as { $ref: string }).$ref];
      return Object.values(obj).flatMap(findRefs);
    };
    const refs = findRefs(spec);
    for (const ref of refs) {
      const name = ref.replace("#/components/schemas/", "");
      expect(definitions[name]).toBeDefined();
    }
  });

  it("BatchRowResult properties match schema", () => {
    const specSchema = spec.components?.schemas?.BatchRowResult;
    expect(specSchema).toBeDefined();
    const specProps = Object.keys(specSchema.properties ?? {}).sort();

    // Read the defined keys straight off the Zod schema's shape rather than parsing a sample row:
    // `error` is optional, so a parsed instance that omits it would under-report the key set and
    // produce a false mismatch against the spec (which correctly lists `error` as an optional
    // property).
    const zodKeys = Object.keys(BatchRowResultSchema.shape).sort();

    expect(specProps).toEqual(zodKeys);
  });

  // The two draft assertions above only check that property *keys* line up — they would pass even
  // if the enum values themselves had drifted (which they had: this test was added specifically
  // because FieldResult.verdict and both `overall` fields were still on the pre-rename vocabulary,
  // MATCH/MISMATCH/REVIEW and PASS/FAIL, despite BatchRowResultSchema having moved on). Pull the
  // expected values from the Zod schema itself rather than hardcoding a second copy, so a future
  // rename only has to update one side.
  const overallEnum = BatchRowResultSchema.shape.overall.options;
  const verdictEnum = BatchRowResultSchema.shape.fields.element.shape.verdict.options;

  it("FieldResult.verdict enum matches the current vocabulary", () => {
    const specEnum = spec.components?.schemas?.FieldResult?.properties?.verdict?.enum;
    expect(specEnum).toEqual(verdictEnum);
  });

  it("VerificationResult.overall enum matches the current vocabulary", () => {
    const specEnum = spec.components?.schemas?.VerificationResult?.properties?.overall?.enum;
    expect(specEnum).toEqual(overallEnum);
  });

  it("BatchRowResult.overall enum matches the current vocabulary", () => {
    const specEnum = spec.components?.schemas?.BatchRowResult?.properties?.overall?.enum;
    expect(specEnum).toEqual(overallEnum);
  });
});
