/**
 * Per-label `local-ocr` timing with image characteristics — finds WHY some real photos take > 5 s
 * instead of guessing from an aggregate p95/max.
 *
 * Committed alongside diagnose-ocr-langs.ts as the reproduction for
 * docs/superpowers/specs/2026-07-25-local-ocr-latency-and-language-packs-design.md.
 * Run: `pnpm diagnose:ocr-latency`. This is the diagnostic; `pnpm check-latency` is the gate.
 *
 * Instruments each boundary separately — decode/preprocess vs. the Tesseract recognize call — because
 * "OCR is slow" could mean sharp is slow, the worker is slow, or the raster handed to Tesseract is
 * simply too big. The aggregate cannot distinguish those. It was this split that ruled preprocessing
 * out (~2% of total on the slow labels) and pointed at the language count.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { localOcrProvider } from "@/lib/vision/local-ocr";

interface Entry {
  file: string;
}

async function main() {
  const entries: Entry[] = JSON.parse(await readFile(path.join("eval", "expected-real-world.json"), "utf8"));

  // Warm the shared tesseract worker BEFORE the timed loop: localOcrProvider builds it lazily on
  // first extract, so without this the first label's totalMs silently absorbs the one-time
  // wasm/traineddata init and setParameters — mis-attributing seconds of setup to that image.
  const first = entries[0];
  if (first) {
    const image = await readFile(path.join("eval", "samples", first.file));
    await localOcrProvider
      .extract(image, { filename: first.file, mimeType: first.file.endsWith(".png") ? "image/png" : "image/jpeg" })
      .catch(() => {});
    console.log("(worker warmed on a throwaway pass — per-label timings below exclude init)");
  } else {
    console.log("(no warmup: expected-real-world.json is empty)");
  }

  const rows: {
    file: string;
    mp: number;
    w: number;
    h: number;
    bytesKb: number;
    prepMs: number;
    prepW: number;
    prepH: number;
    totalMs: number;
  }[] = [];

  for (const entry of entries) {
    const image = await readFile(path.join("eval", "samples", entry.file));
    const meta = await sharp(image).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;

    // Mirror local-ocr.ts's prepareForOcr to time preprocessing in isolation.
    const prepStart = Date.now();
    const MAX_OCR_DIMENSION = 2000;
    let pipeline = sharp(image);
    if (Math.max(w, h) > MAX_OCR_DIMENSION) {
      pipeline = pipeline.resize(MAX_OCR_DIMENSION, MAX_OCR_DIMENSION, { fit: "inside", withoutEnlargement: true });
    }
    const { info } = await pipeline
      .greyscale()
      .normalize()
      .sharpen()
      .extractChannel(0)
      .png()
      .toBuffer({ resolveWithObject: true });
    const prepMs = Date.now() - prepStart;

    const totalStart = Date.now();
    try {
      await localOcrProvider.extract(image, {
        filename: entry.file,
        mimeType: entry.file.endsWith(".jpg") || entry.file.endsWith(".jpeg") ? "image/jpeg" : "image/png",
      });
    } catch (e) {
      console.error(`  ✗ ${entry.file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const totalMs = Date.now() - totalStart;

    rows.push({
      file: entry.file,
      mp: Math.round(((w * h) / 1_000_000) * 100) / 100,
      w,
      h,
      bytesKb: Math.round(image.byteLength / 1024),
      prepMs,
      prepW: info.width,
      prepH: info.height,
      totalMs,
    });
  }

  rows.sort((a, b) => b.totalMs - a.totalMs);
  console.log("\nfile                                                    MP   dims        KB  prep  prepDims   TOTAL");
  for (const r of rows) {
    console.log(
      `${r.file.padEnd(52)} ${String(r.mp).padStart(6)}  ${`${r.w}x${r.h}`.padEnd(11)} ${String(r.bytesKb).padStart(5)} ` +
        `${String(r.prepMs).padStart(5)}  ${`${r.prepW}x${r.prepH}`.padEnd(10)} ${String(r.totalMs).padStart(6)}`,
    );
  }

  const slow = rows.filter((r) => r.totalMs > 5000);
  const fast = rows.filter((r) => r.totalMs <= 1000);
  const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));
  console.log(`\nover 5 s: ${slow.length}/${rows.length}`);
  console.log(
    `  slow (>5s):  avg ${avg(slow.map((r) => r.mp))} MP, avg prep ${avg(slow.map((r) => r.prepMs))} ms, ` +
      `avg total ${avg(slow.map((r) => r.totalMs))} ms`,
  );
  console.log(
    `  fast (<=1s): avg ${avg(fast.map((r) => r.mp))} MP, avg prep ${avg(fast.map((r) => r.prepMs))} ms, ` +
      `avg total ${avg(fast.map((r) => r.totalMs))} ms`,
  );
  console.log(
    `  prep share of total on slow labels: ` +
      `${Math.round((avg(slow.map((r) => r.prepMs)) / Math.max(1, avg(slow.map((r) => r.totalMs)))) * 100)}%`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
