import path from "node:path";
import sharp from "sharp";
import { createWorker, PSM, type Worker, type Block } from "tesseract.js";
import type { VisionProvider } from "@/lib/vision/types";
import { parseOcrText, type OcrLine } from "@/lib/vision/ocr-parser";

let workerPromise: Promise<Worker> | null = null;

// Cap the longest side before OCR so the single shared tesseract worker can't be pegged by a large
// (but within the route's pixel budget) upload. 2000 px keeps label text legible for recognition.
const MAX_OCR_DIMENSION = 2000;

async function prepareForOcr(image: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
  try {
    const { width = 0, height = 0 } = await sharp(image).metadata();
    let pipeline = sharp(image);
    if (Math.max(width, height) > MAX_OCR_DIMENSION) {
      pipeline = pipeline.resize(MAX_OCR_DIMENSION, MAX_OCR_DIMENSION, { fit: "inside", withoutEnlargement: true });
    }
    // Grayscale + contrast normalize + mild sharpen: the classic OCR preprocessing recipe, applied
    // unconditionally (Approach A, per docs/superpowers/specs/2026-07-24-local-ocr-image-
    // preprocessing-design.md) rather than only on images heuristically judged to need it.
    // .greyscale() alone keeps 3 identical (R=G=B) channels, not a true single-channel image —
    // .extractChannel(0) forces one. Placed after .sharpen() rather than before: since all three
    // channels are identical going in, sharpening applies the same convolution to each and keeps them
    // identical coming out, so extracting one channel afterward is byte-for-byte the same as if the
    // pipeline had been single-channel from the start (confirmed empirically, not assumed).
    pipeline = pipeline.greyscale().normalize().sharpen().extractChannel(0).png();
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  } catch {
    // Best effort: a decode/resize/preprocessing failure must not disable the keyless default tier.
    // Hand the original bytes to tesseract, which will surface any genuine decode error itself. Zero
    // dimensions degrade safely — toBoundingBox in ocr-parser.ts already returns a zero-size box
    // rather than dividing by zero.
    return { buffer: image, width: 0, height: 0 };
  }
}

/**
 * OCR language pack(s). English-only by default — a MEASURED default, not an oversight.
 *
 * Tesseract scores candidate words against EVERY loaded language model, so recognition cost scales
 * with the language count times the amount of text-like material found. That is why the cost landed
 * on dense photographs of cans and bottles rather than on clean synthetic labels, and why it stayed
 * invisible while `check-latency` measured only the 13 small synthetic samples.
 *
 * Measured 2026-07-25 over the 46-label real-world set (deterministic for fixed input + config, so
 * the accuracy deltas are not run-to-run noise):
 *
 *   langs                 brandName  overall  p95      max
 *   eng                   31/46      23/46    1399ms   2164ms   ok
 *   eng+fra+spa           33/46      23/46    2211ms   3846ms   ok
 *   eng+fra+spa+ita+por   33/46      23/46    4099ms   6577ms   OVER the 5s budget
 *
 * Overall verdict accuracy is IDENTICAL in every configuration — no language pack changes a single
 * APPROVED/REJECTED outcome on 46 real labels. The apparent brandName +2 is a scoring artifact: both samples
 * are the front and back of one bottle (OLD TUB, an English brand), neither configuration ever reads
 * it correctly, and the extra packs merely made the extractor LESS certain — NON_COMPLIANT became NEEDS_CORRECTION,
 * which `tolerant: true` entries score as correct. On the front label the multilingual worker
 * returned nothing at all and that counted as a win.
 *
 * Also note lib/ttb/normalize.ts already NFKD-folds diacritics before every comparison, so the
 * matcher is accent-blind by design: "Château" and "Chateau" verdict identically. Paying seconds of
 * Tesseract scoring to preserve a distinction discarded microseconds later inverts the pipeline.
 *
 * See docs/superpowers/specs/2026-07-25-local-ocr-latency-and-language-packs-design.md.
 */
export const DEFAULT_OCR_LANGS = "eng";

/**
 * Escape hatch, not a feature flag. 27 CFR 5.55(a)/7.55(a) require mandatory information in English
 * EXCEPT the brand name, and wine (27 CFR part 4) carries no English-language requirement at all —
 * so a deployment serving Puerto-Rico-bottled labels (all-Spanish permitted per §5.55(c)) or a
 * heavily imported wine corpus can restore packs (e.g. OCR_LANGS="eng+spa") and pay the latency
 * knowingly. Optional: invariant 4 (keyless by default) is unaffected.
 *
 * Falls back to the default when unset OR blank — createWorker("") would fail init and, via the
 * self-heal path below, re-fail on every request, disabling the keyless default tier entirely.
 */
const OCR_LANGS = process.env.OCR_LANGS?.trim() || DEFAULT_OCR_LANGS;

/**
 * Vendored copy of the LSTM-only `eng.traineddata`, committed at `assets/tessdata/`. Without this,
 * tesseract.js's default `langPath` is jsdelivr's CDN — fine on a long-lived local process (fetched
 * once, then served from the /tmp cache below), but on Vercel every COLD serverless instance pays a
 * fresh network round trip to that CDN before OCR can run at all. That round trip is what blew past
 * EXTRACT_TIMEOUT_MS in production (2026-07-26): the request never got a real error, just the 8 s
 * timeout, because the extraction hadn't even started recognizing yet. Pointing `langPath` at a local
 * path makes tesseract.js read the file straight off disk instead — confirmed in
 * node_modules/tesseract.js/src/worker-script/index.js: a `langPath` that isn't a URL/file:// is
 * treated as a local directory and read via fs, no network involved.
 *
 * Only applied for the default `eng` pack — an OCR_LANGS override (the documented escape hatch for
 * Puerto Rico Spanish-only labels / wine's no-English requirement) still resolves through the CDN,
 * since only English is vendored here and that override already knowingly accepts extra latency.
 */
const LOCAL_ENG_LANG_PATH = path.join(process.cwd(), "assets", "tessdata");

async function getWorker(): Promise<Worker> {
  // Never cache a REJECTED promise: `??=` would keep a failed init forever, permanently disabling the
  // keyless default tier after one transient blip (traineddata fetch, /tmp not writable). Reset on
  // failure so the next request re-creates the worker and the tier self-heals.
  if (!workerPromise) {
    const options =
      OCR_LANGS === DEFAULT_OCR_LANGS ? { cachePath: "/tmp", langPath: LOCAL_ENG_LANG_PATH } : { cachePath: "/tmp" };
    workerPromise = createWorker(OCR_LANGS, 1, options)
      .then(async (worker) => {
        // Labels are a single column of wildly varying font sizes (a large bold brand title, then
        // progressively smaller class/type, content, and fine-print lines). Left at its default,
        // tesseract.js's automatic page segmentation can drop an isolated large heading entirely —
        // confirmed: the same brand line OCRs correctly in isolation (95% confidence) but disappears
        // from the full-page result with no PSM set. SINGLE_COLUMN names this layout exactly and,
        // unlike the OSD-based modes, needs no extra osd.traineddata fetch.
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_COLUMN });
        return worker;
      })
      .catch((e) => {
        workerPromise = null;
        throw e;
      });
  }
  return workerPromise;
}

// Tesseract's block-level output (`blocks: true`, not requested by default) is the only way to get
// per-line bbox/confidence — flatten its blocks -> paragraphs -> lines into a simple array so
// ocr-parser.ts's field selection can work over one uniform shape.
function flattenLines(blocks: Block[] | null): OcrLine[] {
  return (blocks ?? [])
    .flatMap((b) => b.paragraphs)
    .flatMap((p) => p.lines)
    .map((l) => ({
      text: l.text.trim(),
      confidence: Number.isFinite(l.confidence) ? Math.max(0, Math.min(1, l.confidence / 100)) : 0,
      bbox: l.bbox,
    }));
}

export const localOcrProvider: VisionProvider = {
  name: "local-ocr",
  async extract(image) {
    const worker = await getWorker();
    const { buffer: prepared, width, height } = await prepareForOcr(image);
    const { data } = await worker.recognize(prepared, {}, { blocks: true });
    return parseOcrText(flattenLines(data.blocks), data.text, width, height);
  },
};
