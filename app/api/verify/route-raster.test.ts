// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { MOCK_FIXTURES } from "@/lib/vision/mock";

// Spy on the tier selector: it must NOT be reached for an over-budget or undecodable image — the raster
// guard rejects before any tier decodes. Mocking it also keeps the "no guard" RED run fast (no tesseract).
const mockSelectProvider = vi.fn();
vi.mock("@/lib/vision/select", () => ({
  selectProvider: (filename?: string) => mockSelectProvider(filename),
}));

import { POST } from "@/app/api/verify/route";

const app = {
  beverageType: "distilled-spirits",
  brandName: "OLD TOM DISTILLERY",
  classType: "Kentucky Straight Bourbon Whiskey",
  alcoholContent: "45% Alc./Vol. (90 Proof)",
  netContents: "750 mL",
};

/** A real, tiny-file PNG whose *decoded* raster is width×height pixels (uniform color → compresses small). */
function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } } })
    .png()
    .toBuffer();
}

function request(bytes: Uint8Array) {
  const fd = new FormData();
  fd.set("image", new File([new Uint8Array(bytes)], "upload.png", { type: "image/png" }));
  fd.set("application", JSON.stringify(app));
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

describe("POST /api/verify — decoded-pixel bound (decompression-bomb DoS)", () => {
  it("rejects an image whose decoded raster exceeds the pixel budget with 400, before any tier", async () => {
    const bomb = await png(6000, 5000); // 30 MP decoded, but a tiny compressed file
    const res = await POST(request(bomb));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too large|dimension|megapixel/i);
    expect(mockSelectProvider).not.toHaveBeenCalled();
  });

  it("rejects an undecodable image (valid magic bytes, garbage body) with 400", async () => {
    const fake = new Uint8Array(64);
    fake.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature, no valid IHDR
    const res = await POST(request(fake));
    expect(res.status).toBe(400);
    expect(mockSelectProvider).not.toHaveBeenCalled();
  });

  it("accepts a normal small image within the budget and proceeds to extraction", async () => {
    const ok = await png(400, 300); // 0.12 MP
    const res = await POST(request(ok));
    expect(res.status).toBe(200);
    expect(mockSelectProvider).toHaveBeenCalled();
  });
});
