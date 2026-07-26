import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const mockRecognize = vi.fn();
vi.mock("tesseract.js", () => ({
  createWorker: async () => ({ recognize: mockRecognize, setParameters: vi.fn().mockResolvedValue(undefined) }),
  PSM: { SINGLE_COLUMN: "4" },
}));

import { localOcrProvider } from "@/lib/vision/local-ocr";

const meta = { filename: "x.png", mimeType: "image/png" };

// A deliberately narrow pixel-value range (108-148, far short of 0-255) as a controlled stand-in
// for a real photo's uneven lighting/faded print — not a guess, a fixed, checkable input.
function lowContrastImage(width: number, height: number): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    const v = i % 2 === 0 ? 108 : 148;
    raw[i * channels] = v;
    raw[i * channels + 1] = v;
    raw[i * channels + 2] = v;
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
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

describe("localOcrProvider — image preprocessing before OCR", () => {
  it("widens a low-contrast image's luminance range and converts to greyscale", async () => {
    const input = lowContrastImage(100, 100);
    const before = await sharp(await input).stats();
    const beforeRange = before.channels[0].max - before.channels[0].min;
    expect(beforeRange).toBeLessThan(60); // confirm the fixture is genuinely low-contrast

    const cap = captureRecognizedImage();
    await localOcrProvider.extract(await input, meta);
    const captured = cap.get()!;

    const after = await sharp(captured).stats();
    const afterRange = after.channels[0].max - after.channels[0].min;
    expect(afterRange).toBeGreaterThan(beforeRange);

    const afterMeta = await sharp(captured).metadata();
    expect(afterMeta.channels).toBe(1);
  });

  it("still preprocesses an already-small image (the old fast path skipped this entirely)", async () => {
    const input = await sharp({
      create: { width: 300, height: 200, channels: 3, background: { r: 220, g: 220, b: 220 } },
    })
      .png()
      .toBuffer();
    const cap = captureRecognizedImage();
    await localOcrProvider.extract(input, meta);
    const captured = cap.get()!;
    const capturedMeta = await sharp(captured).metadata();
    expect(capturedMeta.channels).toBe(1); // greyscale now applies even without a resize
    expect(capturedMeta.width).toBe(300); // dimensions unaffected by greyscale/normalize/sharpen
    expect(capturedMeta.height).toBe(200);
  });
});
