import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const mockRecognize = vi.fn();
vi.mock("tesseract.js", () => ({
  createWorker: async () => ({ recognize: mockRecognize, setParameters: vi.fn().mockResolvedValue(undefined) }),
  PSM: { SINGLE_COLUMN: "4" },
}));

import { localOcrProvider } from "@/lib/vision/local-ocr";

const meta = { filename: "x.png", mimeType: "image/png" };

function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 220, g: 220, b: 220 } } })
    .png()
    .toBuffer();
}

function captureRecognizedImage(): { get: () => Buffer | undefined } {
  let received: Buffer | undefined;
  mockRecognize.mockImplementation((img: Buffer) => {
    received = img;
    return { data: { text: "HELLO 750 mL", confidence: 88 } };
  });
  return { get: () => received };
}

afterEach(() => vi.clearAllMocks());

describe("localOcrProvider — downscale before OCR", () => {
  it("caps the longest side before handing the image to tesseract (bounds worker CPU)", async () => {
    const cap = captureRecognizedImage();
    await localOcrProvider.extract(await png(3000, 600), meta);
    const decoded = await sharp(cap.get()!).metadata();
    expect(Math.max(decoded.width!, decoded.height!)).toBeLessThanOrEqual(2000);
  });

  it("passes an already-small image through without enlarging it", async () => {
    const cap = captureRecognizedImage();
    await localOcrProvider.extract(await png(300, 200), meta);
    const decoded = await sharp(cap.get()!).metadata();
    expect(decoded.width).toBe(300);
    expect(decoded.height).toBe(200);
  });
});
