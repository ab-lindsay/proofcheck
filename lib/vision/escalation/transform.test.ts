import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { applyTransform, cropToBox, enhance } from "@/lib/vision/escalation/transform";

/** A 4000x2000 image with a red block in the top-left quadrant, so a crop is verifiable.
 *  Deliberately larger than CROP_MIN_WIDTH in every fraction used below — a tiny source would make
 *  every crop hit the upscale path and the "smaller than source" assertion would contradict it. */
async function testImage(width = 4000, height = 2000): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .composite([
      {
        input: await sharp({
          create: { width: Math.round(width / 4), height: Math.round(height / 4), channels: 3, background: "#ff0000" },
        })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
}

describe("cropToBox", () => {
  it("returns a decodable image smaller in area than the source", async () => {
    // 0.3 of 4000 = 1200px wide (plus padding) — already ≥ CROP_MIN_WIDTH, so no upscale fires.
    const out = await cropToBox(await testImage(), { x: 0.1, y: 0.1, width: 0.3, height: 0.3 });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect((meta.width ?? 0) * (meta.height ?? 0)).toBeLessThan(4000 * 2000);
  });

  it("upscales a small crop to at least CROP_MIN_WIDTH so fine text is legible", async () => {
    // 0.05 of 4000 = 200px + 2×160 padding = 520px < 640 → upscale fires.
    const out = await cropToBox(await testImage(), { x: 0, y: 0, width: 0.05, height: 0.05 });
    const meta = await sharp(out).metadata();
    expect(meta.width ?? 0).toBeGreaterThanOrEqual(640);
  });

  it("NEVER enlarges past MAX_EDGE — a thin tall box cannot manufacture a huge raster (spec §4.6)", async () => {
    // 1000x8000 source; box 0.2 wide × full height → crop ≈ 280×8000. A naive "resize width to 640"
    // would manufacture 640×18286 ≈ 11.7 MP from a 2.2 MP crop — the attacker-steered blowup the
    // review found (boundingBox is model-reported). The scale rule must refuse to enlarge here.
    const out = await cropToBox(await testImage(1000, 8000), { x: 0, y: 0, width: 0.2, height: 1 });
    const meta = await sharp(out).metadata();
    expect(meta.width ?? 0).toBeLessThanOrEqual(320); // crop width + padding, NOT 640
    expect(meta.height ?? 0).toBeLessThanOrEqual(8000);
  });

  it("clamps a box that overflows the image edge instead of throwing", async () => {
    const out = await cropToBox(await testImage(), { x: 0.9, y: 0.9, width: 0.5, height: 0.5 });
    await expect(sharp(out).metadata()).resolves.toBeTruthy();
  });

  it("clamps a zero-area box to at least one pixel instead of throwing", async () => {
    const out = await cropToBox(await testImage(), { x: 0.5, y: 0.5, width: 0, height: 0 });
    await expect(sharp(out).metadata()).resolves.toBeTruthy();
  });

  it("clamps a zero-area box on a tiny image where CROP_PADDING itself rounds to 0px (review 2026-07-25: the 4000px fixture always has enough padding to mask a removed floor — this is the case that actually exercises it)", async () => {
    const out = await cropToBox(await testImage(6, 6), { x: 0, y: 0, width: 0, height: 0 });
    await expect(sharp(out).metadata()).resolves.toBeTruthy();
  });

  it("keeps the requested region — a top-left crop stays red", async () => {
    const out = await cropToBox(await testImage(), { x: 0, y: 0, width: 0.2, height: 0.2 });
    const { dominant } = await sharp(out).stats();
    expect(dominant.r).toBeGreaterThan(dominant.b);
  });
});

describe("enhance", () => {
  it("downscales to the OCR bound and returns greyscale (spec §4.6: no full-res 25 MP sharpening)", async () => {
    const out = await enhance(await testImage());
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(2000); // 4000×2000 → fit inside 2000×2000
    expect(meta.height).toBe(1000);
    const { dominant } = await sharp(out).stats();
    expect(dominant.r).toBe(dominant.g);
    expect(dominant.g).toBe(dominant.b);
  });

  it("never upscales a small image", async () => {
    const out = await enhance(await testImage(400, 200));
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(200);
  });
});

describe("applyTransform", () => {
  it("routes an enhance plan to enhance (bounded size)", async () => {
    const out = await applyTransform(await testImage(), {
      transform: "enhance",
      targetFields: ["brandName"],
      box: null,
    });
    expect((await sharp(out).metadata()).width).toBe(2000);
  });

  it("falls back to enhance when a crop plan has no box", async () => {
    const out = await applyTransform(await testImage(), {
      transform: "crop",
      targetFields: ["brandName"],
      box: null,
    });
    expect((await sharp(out).metadata()).width).toBe(2000);
  });
});
