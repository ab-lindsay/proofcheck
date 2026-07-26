import { describe, expect, it } from "vitest";
import { MOCK_FIXTURES, isMockSample, mockProvider } from "@/lib/vision/mock";
import { ExtractedLabelSchema } from "@/lib/schema";

describe("mock tier", () => {
  it("every fixture is a schema-valid ExtractedLabel", () => {
    for (const [file, fixture] of Object.entries(MOCK_FIXTURES)) {
      expect(ExtractedLabelSchema.safeParse(fixture).success, `fixture ${file}`).toBe(true);
    }
    expect(Object.keys(MOCK_FIXTURES).length).toBeGreaterThanOrEqual(12);
  });
  it("returns the fixture for a known filename", async () => {
    const r = await mockProvider.extract(Buffer.alloc(0), { filename: "old-tom-clean.png", mimeType: "image/png" });
    expect(r.brandName.value).toBe("OLD TOM DISTILLERY");
  });
  it("throws a clear error for an unknown filename", async () => {
    await expect(
      mockProvider.extract(Buffer.alloc(0), { filename: "nope.png", mimeType: "image/png" }),
    ).rejects.toThrow(/mock tier/i);
  });
  it("isMockSample distinguishes bundled samples", () => {
    expect(isMockSample("old-tom-clean.png")).toBe(true);
    expect(isMockSample("random-upload.png")).toBe(false);
  });
  it("isMockSample does not match inherited Object properties", () => {
    // Guard against the `in` operator matching prototype keys ("toString", "constructor", …).
    expect(isMockSample("toString")).toBe(false);
    expect(isMockSample("constructor")).toBe(false);
  });
});
