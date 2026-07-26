import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SOURCE_DIR = path.join(process.cwd(), "eval", "samples");
const OUT_DIR = path.join(SOURCE_DIR, "degraded");

const BASE_IMAGES = [
  "old-tom-clean.png",
  "kirkbride-import-wine.png",
  "wrong-abv.png",
  "spirits-old-tub-bourbon-back.jpg",
  "wine-la-crema-saralees-chardonnay-back.png",
];

function glareSvg(width: number, height: number): Buffer {
  const cx = Math.round(width * 0.7);
  const cy = Math.round(height * 0.3);
  const r = Math.round(Math.min(width, height) * 0.35);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<defs><radialGradient id="g" cx="50%" cy="50%" r="50%">` +
      `<stop offset="0%" stop-color="white" stop-opacity="0.85"/>` +
      `<stop offset="100%" stop-color="white" stop-opacity="0"/>` +
      `</radialGradient></defs>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#g)"/></svg>`,
  );
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  for (const file of BASE_IMAGES) {
    const srcPath = path.join(SOURCE_DIR, file);
    const ext = path.extname(file);
    const stem = path.basename(file, ext);
    const meta = await sharp(srcPath).metadata();
    const width = meta.width ?? 800;
    const height = meta.height ?? 1100;

    await sharp(srcPath)
      .blur(3)
      .toFile(path.join(OUT_DIR, `${stem}-blur${ext}`));

    await sharp(srcPath)
      .rotate(12, { background: "#ffffff" })
      .toFile(path.join(OUT_DIR, `${stem}-skew${ext}`));

    await sharp(srcPath)
      .composite([{ input: glareSvg(width, height), blend: "over" }])
      .toFile(path.join(OUT_DIR, `${stem}-glare${ext}`));

    await sharp(srcPath)
      .resize(Math.round(width * 0.25), Math.round(height * 0.25))
      .resize(width, height)
      .toFile(path.join(OUT_DIR, `${stem}-lowres${ext}`));

    // Glare is composited before rotate (while dimensions still match `width`/`height` exactly);
    // rotate expands the canvas, so compositing after would misalign the overlay.
    await sharp(srcPath)
      .composite([{ input: glareSvg(width, height), blend: "over" }])
      .rotate(6, { background: "#ffffff" })
      .blur(1.5)
      .jpeg({ quality: 40 })
      .toFile(path.join(OUT_DIR, `${stem}-combo.jpg`));

    const check = await sharp(path.join(OUT_DIR, `${stem}-blur${ext}`)).metadata();
    if (!check.width || !check.height) throw new Error(`${stem}-blur${ext} failed to decode after generation`);

    console.log(`wrote 5 degraded variants for ${file}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
