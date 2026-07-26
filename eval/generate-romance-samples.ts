import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { HEALTH_WARNING_TEXT } from "@/lib/ttb/warning";

const W = 800,
  H = 1100;

interface RomanceLabel {
  file: string;
  brandName: string;
  classType: string;
  alcoholContent: string;
  netContents: string;
  producerLine: string;
  countryLine: string;
}

const LABELS: RomanceLabel[] = [
  {
    file: "wine-french-cotes-du-rhone.png",
    brandName: "DOMAINE LAURENT",
    classType: "Côtes du Rhône Rouge",
    alcoholContent: "13.5% Vol.",
    netContents: "750 mL",
    producerLine: "Mis en bouteille par Domaine Laurent, Vaison-la-Romaine",
    countryLine: "Produit de France",
  },
  {
    file: "wine-spanish-rioja.png",
    brandName: "BODEGA MONTALVO",
    classType: "Rioja Tinto",
    alcoholContent: "13.5% Vol.",
    netContents: "750 mL",
    producerLine: "Embotellado por Bodega Montalvo, Haro",
    countryLine: "Producto de España",
  },
  {
    file: "wine-italian-chianti.png",
    brandName: "TENUTA ROSSINI",
    classType: "Chianti Rosso",
    alcoholContent: "13% Vol.",
    netContents: "750 mL",
    producerLine: "Imbottigliato da Tenuta Rossini, Siena",
    countryLine: "Prodotto in Italia",
  },
  {
    file: "wine-portuguese-vinho-verde.png",
    brandName: "QUINTA DO VALE",
    classType: "Vinho Verde Branco",
    alcoholContent: "11% Vol.",
    netContents: "750 mL",
    producerLine: "Engarrafado por Quinta do Vale, Porto",
    countryLine: "Produzido em Portugal",
  },
];

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

function svgFor(label: RomanceLabel): string {
  const parts: string[] = [];
  let y = 140;
  const text = (value: string, size: number, weight = "normal") => {
    parts.push(
      `<text x="400" y="${y}" font-size="${size}" font-weight="${weight}" font-family="Georgia, serif" text-anchor="middle" fill="#111">${esc(value)}</text>`,
    );
    y += size + 26;
  };
  text(label.brandName, 46, "bold");
  text(label.classType, 28);
  text(label.alcoholContent, 24);
  text(label.netContents, 24);
  text(label.producerLine, 18);
  text(label.countryLine, 18);
  y = Math.max(y + 40, 780);
  const prefix = "GOVERNMENT WARNING:";
  const rest = HEALTH_WARNING_TEXT.slice(prefix.length);
  const lines = wrap(`${prefix} ${rest}`.trim());
  for (const [i, line] of lines.entries()) {
    if (i === 0 && line.startsWith(prefix)) {
      parts.push(
        `<text x="60" y="${y}" font-size="16" font-family="Georgia, serif" fill="#111"><tspan font-weight="bold">${esc(prefix)}</tspan>${esc(line.slice(prefix.length))}</text>`,
      );
    } else {
      parts.push(`<text x="60" y="${y}" font-size="16" font-family="Georgia, serif" fill="#111">${esc(line)}</text>`);
    }
    y += 24;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#f8f5ef"/><rect x="20" y="20" width="${W - 40}" height="${H - 40}" fill="none" stroke="#7a6a4f" stroke-width="4"/>${parts.join("")}</svg>`;
}

async function main() {
  const outDir = path.join(process.cwd(), "eval", "samples");
  await mkdir(outDir, { recursive: true });
  for (const label of LABELS) {
    const out = path.join(outDir, label.file);
    await sharp(Buffer.from(svgFor(label)))
      .png()
      .toFile(out);
    const { channels } = await sharp(out).stats();
    if (channels[0].mean > 254)
      throw new Error(`${label.file} rendered blank — install system fonts (fontconfig) and re-run.`);
    console.log(`wrote eval/samples/${label.file}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
