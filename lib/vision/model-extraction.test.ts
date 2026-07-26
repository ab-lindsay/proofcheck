import { describe, expect, it, vi } from "vitest";
import { extractWithModel, ExtractionError } from "@/lib/vision/model-extraction";
import { MOCK_FIXTURES } from "@/lib/vision/mock";

const valid = JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]);

describe("extractWithModel", () => {
  it("parses valid JSON on the first try", async () => {
    const call = vi.fn().mockResolvedValue(valid);
    const r = await extractWithModel(call);
    expect(r.brandName.value).toBe("OLD TOM DISTILLERY");
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("strips markdown fences", async () => {
    const r = await extractWithModel(async () => "```json\n" + valid + "\n```");
    expect(r.netContents.value).toBe("750 mL");
  });
  it("retries once on invalid JSON, then succeeds", async () => {
    const call = vi.fn().mockResolvedValueOnce("not json").mockResolvedValueOnce(valid);
    const r = await extractWithModel(call);
    expect(r.brandName.present).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("throws ExtractionError after two invalid responses", async () => {
    const call = vi.fn().mockResolvedValue('{"nope": true}');
    await expect(extractWithModel(call)).rejects.toBeInstanceOf(ExtractionError);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
