/**
 * Reproduces the language-pack A/B behind the English-only default: does the 5-language pack drive
 * the > 5 s `local-ocr` outliers?
 *
 * Committed as the reproduction for
 * docs/superpowers/specs/2026-07-25-local-ocr-latency-and-language-packs-design.md, so the default
 * can be re-litigated on evidence rather than re-argued. Run: `pnpm diagnose:ocr-langs`.
 *
 * Single variable — same images, same PSM, same preprocessing, only the language list changes.
 * Timing is the recognize() call alone, so preprocessing (measured at ~2% of total) can't confound it.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createWorker, PSM } from "tesseract.js";
import { DEFAULT_OCR_LANGS } from "@/lib/vision/local-ocr";

const MAX_OCR_DIMENSION = 2000;

// The language lists below are deliberate LITERALS, not `DEFAULT_OCR_LANGS`. An earlier run of this
// comparison imported the constant for the "eng" arm and silently measured eng against eng, because
// the import resolved to `undefined` and createWorker fell back to its own default. Passing explicit
// strings straight into createWorker is what makes the A/B trustworthy — keep it that way, and use
// the header line below to confirm what the app's own default currently is.
const ARM_ONE = "eng";
const ARM_FIVE = "eng+fra+spa+ita+por";

/** Mirrors lib/vision/local-ocr.ts's prepareForOcr exactly. */
async function prepare(image: Buffer): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  let p = sharp(image);
  if (Math.max(width, height) > MAX_OCR_DIMENSION) {
    p = p.resize(MAX_OCR_DIMENSION, MAX_OCR_DIMENSION, { fit: "inside", withoutEnlargement: true });
  }
  return p.greyscale().normalize().sharpen().extractChannel(0).png().toBuffer();
}

// The five slowest labels from diagnose-ocr-latency.ts, plus two fast controls and the four
// Romance-language samples the multi-language pack exists to serve.
const SLOW = [
  "malt-guinness-draught-stout-can.jpg",
  "spirits-makers-mark-founders-series-front.jpg",
  "degraded/spirits-old-tub-bourbon-back-blur.jpg",
  "malt-samuel-adams-boston-lager-can.jpg",
  "wine-kendall-jackson-vintners-reserve-rose-back.jpg",
];
const FAST_CONTROL = ["wine-la-crema-saralees-chardonnay-front.png", "degraded/old-tom-clean-blur.png"];
const ROMANCE = [
  "wine-french-cotes-du-rhone.png",
  "wine-italian-chianti.png",
  "wine-portuguese-vinho-verde.png",
  "wine-spanish-rioja.png",
];

async function timeWith(langs: string, files: string[]): Promise<Map<string, number>> {
  // os.tmpdir(), not a literal "/tmp": on win32 (this repo's dev platform) "/tmp" resolves to a
  // C:\tmp that doesn't exist, and tesseract.js's cache adapter fails silently — every run
  // re-downloaded the traineddata it thought it was caching.
  const worker = await createWorker(langs, 1, {
    cachePath: process.platform === "win32" ? path.join(os.homedir(), ".tesseract-cache") : "/tmp",
  });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_COLUMN });
  const out = new Map<string, number>();
  for (const f of files) {
    const buf = await prepare(await readFile(path.join("eval", "samples", f)));
    const t0 = Date.now();
    await worker.recognize(buf);
    out.set(f, Date.now() - t0);
  }
  await worker.terminate();
  return out;
}

async function main() {
  // What the app itself would use right now, printed before any measurement — the guard against
  // reading these timings as if they described a configuration the app doesn't actually ship.
  console.log(`app default (DEFAULT_OCR_LANGS) = ${JSON.stringify(DEFAULT_OCR_LANGS)}`);
  console.log(`env OCR_LANGS                   = ${JSON.stringify(process.env.OCR_LANGS)}`);
  console.log(`comparing arms                  = ${JSON.stringify(ARM_ONE)} vs ${JSON.stringify(ARM_FIVE)}`);

  const files = [...SLOW, ...FAST_CONTROL, ...ROMANCE];
  console.log("\nwarming caches (first load downloads/initialises language data)…");
  await timeWith(ARM_ONE, [FAST_CONTROL[1]]);
  await timeWith(ARM_FIVE, [FAST_CONTROL[1]]);

  console.log("\nmeasuring recognize() only…");
  const five = await timeWith(ARM_FIVE, files);
  const one = await timeWith(ARM_ONE, files);

  console.log("\nfile                                                    5-lang   eng-only  speedup  group");
  let s5 = 0,
    s1 = 0;
  for (const f of files) {
    const a = five.get(f) ?? 0;
    const b = one.get(f) ?? 0;
    const group = SLOW.includes(f) ? "SLOW" : FAST_CONTROL.includes(f) ? "control" : "romance";
    if (group === "SLOW") {
      s5 += a;
      s1 += b;
    }
    console.log(
      `${f.padEnd(52)} ${String(a).padStart(7)}  ${String(b).padStart(8)}  ${(a / Math.max(1, b)).toFixed(1)}x`.padEnd(
        84,
      ) + group,
    );
  }
  console.log(`\nSLOW group total: 5-lang ${s5} ms → eng-only ${s1} ms (${(s5 / Math.max(1, s1)).toFixed(1)}x faster)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
