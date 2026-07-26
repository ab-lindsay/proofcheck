import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { MOCK_FIXTURES } from "@/lib/vision/mock";

const W = 800,
  H = 1100;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function wrap(text: string, max = 62): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > max) {
      lines.push(line.trim());
      line = w;
    } else line = `${line} ${w}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function svgFor(fixture: (typeof MOCK_FIXTURES)[string]): string {
  const parts: string[] = [];
  let y = 140;
  const text = (value: string, size: number, weight = "normal") => {
    parts.push(
      `<text x="400" y="${y}" font-size="${size}" font-weight="${weight}" font-family="Georgia, serif" text-anchor="middle" fill="#111">${esc(value)}</text>`,
    );
    y += size + 26;
  };
  if (fixture.brandName.value) text(fixture.brandName.value, 46, "bold");
  if (fixture.classType.value) text(fixture.classType.value, 28);
  if (fixture.alcoholContent.value) text(fixture.alcoholContent.value, 24);
  if (fixture.netContents.value) text(fixture.netContents.value, 24);
  if (fixture.nameAndAddress.value) text(fixture.nameAndAddress.value, 18);
  if (fixture.countryOfOrigin.value) text(`PRODUCT OF ${fixture.countryOfOrigin.value.toUpperCase()}`, 18);
  if (fixture.healthWarningStatement.value) {
    y = Math.max(y + 40, 780);
    const prefixMatch = fixture.healthWarningStatement.value.match(/^(GOVERNMENT WARNING:|Government Warning:)\s*/);
    const prefix = prefixMatch?.[1] ?? "";
    const rest = fixture.healthWarningStatement.value.slice(prefixMatch?.[0].length ?? 0);
    const lines = wrap(`${prefix} ${rest}`.trim());
    for (const [i, line] of lines.entries()) {
      if (i === 0 && prefix && line.startsWith(prefix)) {
        parts.push(
          `<text x="60" y="${y}" font-size="16" font-family="Georgia, serif" fill="#111"><tspan font-weight="bold">${esc(prefix)}</tspan>${esc(line.slice(prefix.length))}</text>`,
        );
      } else {
        parts.push(`<text x="60" y="${y}" font-size="16" font-family="Georgia, serif" fill="#111">${esc(line)}</text>`);
      }
      y += 24;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#f8f5ef"/><rect x="20" y="20" width="${W - 40}" height="${H - 40}" fill="none" stroke="#7a6a4f" stroke-width="4"/>${parts.join("")}</svg>`;
}

async function main() {
  const outDir = path.join(process.cwd(), "eval", "samples");
  await mkdir(outDir, { recursive: true });
  await mkdir(path.join(process.cwd(), "public", "samples"), { recursive: true });
  for (const [file, fixture] of Object.entries(MOCK_FIXTURES)) {
    const out = path.join(outDir, file);
    await sharp(Buffer.from(svgFor(fixture)))
      .png()
      .toFile(out);
    const { channels } = await sharp(out).stats();
    if (channels[0].mean > 254)
      throw new Error(`${file} rendered blank — install system fonts (fontconfig) and re-run.`);
    console.log(`wrote eval/samples/${file}`);
  }
  for (const demo of ["old-tom-clean.png", "title-case-warning.png"]) {
    await copyFile(path.join(outDir, demo), path.join(process.cwd(), "public", "samples", demo));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
