import sharp from "sharp";
import type { BoundingBox } from "@/lib/schema";
import type { RepairPlan } from "@/lib/vision/escalation/types";

/** Fraction of each dimension added around a bounding box. Extraction boxes are often slightly
 *  tight, and a crop that clips a glyph is worse than one carrying a little extra background. */
export const CROP_PADDING = 0.04;

/** Upscale target for a crop. A 40px-tall warning line re-read at ~640px wide is the classic
 *  resolution win for both OCR and vision models. */
export const CROP_MIN_WIDTH = 640;

/** Hard ceiling on either output dimension after upscaling (spec §4.6). The bounding box is
 *  MODEL-REPORTED — i.e. attacker-influenceable via artwork — and without this cap a thin tall box
 *  (50×5000 on a large upload) upscaled to width 640 would manufacture a ~41 MP raster, above the
 *  route's 25 MP entry cap, inside the ladder where nothing else bounds it. */
export const MAX_EDGE = 4096;

/** Long-edge bound for enhance — the same 2000 px bound prepareForOcr uses. Full-resolution
 *  greyscale+normalize+sharpen on a 25 MP upload is pure DoS surface with no accuracy benefit:
 *  every consumer downscales anyway. */
export const ENHANCE_MAX_EDGE = 2000;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export async function cropToBox(image: Buffer, box: BoundingBox): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  // Unreachable via the route (its raster pre-check rejects pixels <= 0 on this same buffer), but
  // returning the ORIGINAL buffer here would hand escalate.ts non-PNG bytes it labels image/png.
  // Throwing routes the degenerate case to the ladder's transform-failed path, which fails closed
  // to the baseline — the same behavior enhance already has on undecodable input.
  if (width <= 0 || height <= 0) throw new Error("cropToBox: source image reports no dimensions");

  const padX = CROP_PADDING * width;
  const padY = CROP_PADDING * height;
  const left = Math.round(clamp(box.x * width - padX, 0, width - 1));
  const top = Math.round(clamp(box.y * height - padY, 0, height - 1));
  // At least 1px so a degenerate (zero-area) box can never make sharp throw.
  const cropWidth = Math.round(clamp(box.width * width + padX * 2, 1, width - left));
  const cropHeight = Math.round(clamp(box.height * height + padY * 2, 1, height - top));

  let pipeline = sharp(image).extract({ left, top, width: cropWidth, height: cropHeight });
  // Upscale toward CROP_MIN_WIDTH, but never let EITHER output dimension exceed MAX_EDGE. When the
  // aspect ratio makes that impossible (thin tall box), scale ≤ 1 and we simply don't enlarge —
  // refusing the work is the guard, since sharp keeps computing after a timeout fires.
  const scale = Math.min(CROP_MIN_WIDTH / cropWidth, MAX_EDGE / cropWidth, MAX_EDGE / cropHeight);
  if (scale > 1) {
    pipeline = pipeline.resize({ width: Math.round(cropWidth * scale), withoutEnlargement: false });
  }
  return pipeline.png().toBuffer();
}

/** Downscale to the OCR bound, then grayscale + contrast normalize + mild sharpen — the same recipe
 *  local-ocr.ts uses in prepareForOcr, to recover glare / dim / low-contrast captures. */
export async function enhance(image: Buffer): Promise<Buffer> {
  return sharp(image)
    .resize({ width: ENHANCE_MAX_EDGE, height: ENHANCE_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .greyscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
}

export async function applyTransform(image: Buffer, plan: RepairPlan): Promise<Buffer> {
  if (plan.transform === "crop" && plan.box !== null) return cropToBox(image, plan.box);
  return enhance(image);
}
