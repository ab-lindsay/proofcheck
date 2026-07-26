import { afterEach, describe, expect, it, vi } from "vitest";
import { selectProvider, providerByName, selectCloudProvider } from "@/lib/vision/select";

afterEach(() => vi.unstubAllEnvs());

describe("selectProvider", () => {
  it("VISION_PROVIDER forces a tier", () => {
    vi.stubEnv("VISION_PROVIDER", "mock");
    expect(selectProvider("anything.png").name).toBe("mock");
  });
  it("VISION_PROVIDER=local-llm forces the local-llm tier", () => {
    vi.stubEnv("VISION_PROVIDER", "local-llm");
    expect(selectProvider("upload.png").name).toBe("local-llm");
  });
  it("refuses VISION_PROVIDER=mock in production (mock returns fabricated data)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VISION_PROVIDER", "mock");
    expect(() => selectProvider("anything.png")).toThrow(/mock/i);
  });
  it("bundled sample filenames use the mock tier", () => {
    vi.stubEnv("VISION_PROVIDER", "");
    expect(selectProvider("old-tom-clean.png").name).toBe("mock");
  });
  it("a configured Bedrock token selects bedrock for uploads", () => {
    vi.stubEnv("VISION_PROVIDER", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    expect(selectProvider("upload.png").name).toBe("bedrock");
  });
  it("no key and unknown file falls back to local-ocr", () => {
    vi.stubEnv("VISION_PROVIDER", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    expect(selectProvider("upload.png").name).toBe("local-ocr");
  });
  it("providerByName rejects unknown names", () => {
    expect(() => providerByName("watson")).toThrow(/unknown/i);
  });
});

describe("selectCloudProvider", () => {
  it("returns null when no cloud key is configured", () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    expect(selectCloudProvider()).toBeNull();
  });
  it("returns bedrock when the Bedrock token is set", () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    expect(selectCloudProvider()?.name).toBe("bedrock");
  });
});
