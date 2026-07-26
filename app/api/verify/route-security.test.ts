// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MOCK_FIXTURES } from "@/lib/vision/mock";

// Spy on the tier selector so we can assert exactly what the route hands it. `mock`-prefixed so it
// may be referenced inside the hoisted vi.mock factory.
const mockSelectProvider = vi.fn();
vi.mock("@/lib/vision/select", () => ({
  selectProvider: (filename?: string) => mockSelectProvider(filename),
}));

import { POST } from "@/app/api/verify/route";

// A real, decodable 2×2 PNG — the route now hard-rejects undecodable uploads, so a bare magic-byte
// stub no longer reaches the tier selector. These bytes are non-genuine (hash ≠ any bundled sample),
// which is exactly what the spoof tests need.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgEpHjEpFjgFAABk4A8YCCZIUAAAAASUVORK5CYII=",
  "base64",
);
const GENUINE_OLD_TOM = readFileSync("public/samples/old-tom-clean.png");
const app = {
  beverageType: "distilled-spirits",
  brandName: "OLD TOM DISTILLERY",
  classType: "Kentucky Straight Bourbon Whiskey",
  alcoholContent: "45% Alc./Vol. (90 Proof)",
  netContents: "750 mL",
};

function request(overrides: { filename?: string; source?: string; bytes?: Uint8Array } = {}) {
  const fd = new FormData();
  const bytes = overrides.bytes ?? TINY_PNG;
  fd.set("image", new File([new Uint8Array(bytes)], overrides.filename ?? "old-tom-clean.png", { type: "image/png" }));
  fd.set("application", JSON.stringify(app));
  if (overrides.source !== undefined) fd.set("source", overrides.source);
  const contentLength = String(bytes.length + 1024);
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? contentLength : null) },
    formData: async () => fd,
  } as unknown as Request;
}

beforeEach(() => {
  mockSelectProvider.mockReset();
  mockSelectProvider.mockReturnValue({
    name: "local-ocr",
    extract: vi.fn().mockResolvedValue(MOCK_FIXTURES["old-tom-clean.png"]),
  });
});

describe("POST /api/verify — trusted sample gate", () => {
  it("does NOT pass an uploaded filename to the tier selector without source=sample", async () => {
    await POST(request({ filename: "old-tom-clean.png" }));
    expect(mockSelectProvider).toHaveBeenCalledWith(undefined);
  });
  it("BLOCKS a spoof: source=sample with a bundled filename but non-genuine bytes stays off the mock path", async () => {
    // The attack — arbitrary artwork named after a sample + source=sample — must reach real extraction.
    await POST(request({ filename: "old-tom-clean.png", source: "sample" }));
    expect(mockSelectProvider).toHaveBeenCalledWith(undefined);
  });
  it("passes the filename to the tier selector only for source=sample with genuine sample bytes", async () => {
    await POST(request({ filename: "old-tom-clean.png", source: "sample", bytes: GENUINE_OLD_TOM }));
    expect(mockSelectProvider).toHaveBeenCalledWith("old-tom-clean.png");
  });
});
