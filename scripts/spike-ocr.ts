import { readFile } from "node:fs/promises";
import { localOcrProvider } from "@/lib/vision/local-ocr";

async function main() {
  const image = await readFile("eval/samples/old-tom-clean.png");
  const meta = { filename: "old-tom-clean.png", mimeType: "image/png" };
  const t0 = Date.now();
  await localOcrProvider.extract(image, meta);
  const cold = Date.now() - t0;
  const t1 = Date.now();
  await localOcrProvider.extract(image, meta);
  const warm = Date.now() - t1;
  console.log(`local-ocr cold: ${cold} ms, warm: ${warm} ms`);
  console.log(
    warm > 2500
      ? "DECISION INPUT: warm > 2.5 s — consider moving the local-ocr tier in-browser (tesseract.js is isomorphic)."
      : "DECISION INPUT: within budget for server-side OCR.",
  );
  // Romance-language decision gate (docs/superpowers/specs/2026-07-23-romance-language-ocr-design.md
  // §B): the worker singleton now loads 5 traineddata packs on cold init instead of 1. Concrete
  // thresholds so the outcome isn't a judgment call after the fact — 6 s leaves 2 s margin under the
  // route's 8 s hard timeout; 5 s matches the product's end-to-end budget.
  console.log(
    cold <= 6000 && warm <= 5000
      ? "ROMANCE-OCR GATE: APPROVED — cold <= 6 s and warm <= 5 s. Ship the combined eng+fra+spa+ita+por worker."
      : "ROMANCE-OCR GATE: REJECTED — see docs/superpowers/specs/2026-07-23-romance-language-ocr-design.md §B.",
  );
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
