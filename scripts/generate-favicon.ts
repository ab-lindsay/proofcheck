/**
 * Generates `app/favicon.ico` (16/32/48 px, PNG-in-ICO) from the ProofCheck mark's geometry.
 *
 * Run with `pnpm favicon`. The .ico is committed; re-run this only when the mark changes.
 *
 * No image dependencies: the mark is nothing but rounded rectangles, so this rasterizes them
 * directly by 8x supersampling, encodes PNG via node:zlib, and wraps the PNGs in an ICO
 * container. Rasterizing here rather than shelling out to a converter also means the 16 px
 * output is reproducible and reviewable (see `pnpm favicon --print`).
 *
 * Geometry must stay in sync with `app/icon.svg` and `components/proof-mark.tsx` — the glyph
 * spans 70% x 80% of the tile in all three. See
 * docs/superpowers/specs/2026-07-25-logo-mark-design.md.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

type Rgb = readonly [number, number, number];
type Rect = { x: number; y: number; w: number; h: number; r: number; fill: Rgb };

const NAVY: Rgb = [0x14, 0x2c, 0x46];
const PAPER: Rgb = [0xfa, 0xf8, 0xf3];
/** On-navy amber (`--proof-amber-on-navy`); light theme's `--proof-amber` is only 2.80:1 on navy. */
const AMBER: Rgb = [0xe0, 0x8a, 0x3e];

const CONTAINER: Rect = { x: 0, y: 0, w: 40, h: 40, r: 6, fill: NAVY };

/**
 * Two unequal, bottom-aligned columns (the application data and the extracted label) with one
 * field tied across them. The columns are unequal on purpose: equal columns plus a centred bar
 * has both bilateral and vertical symmetry, which is what makes a letterform — that draft read
 * as a capital "H".
 */
const SHAPES: readonly Rect[] = [
  { x: 6, y: 4, w: 9.5, h: 32, r: 2.5, fill: PAPER },
  { x: 24.5, y: 13, w: 9.5, h: 23, r: 2.5, fill: PAPER },
  { x: 6, y: 24, w: 28, h: 6.5, r: 3.25, fill: AMBER },
];

const SIZES = [16, 32, 48] as const;
/** Subsamples per axis. 8 is plenty for axis-aligned rects and keeps 48 px instant. */
const SS = 8;

/** Is (px,py) inside a rounded rect? Corner arcs are tested against the inset centre. */
function inRoundRect(px: number, py: number, { x, y, w, h, r }: Rect): boolean {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Renders the mark at `size` px into a straight-alpha RGBA buffer. */
function render(size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = CONTAINER.w / size; // grid units per output pixel

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const gx = (px + (sx + 0.5) / SS) * scale;
          const gy = (py + (sy + 0.5) / SS) * scale;
          if (!inRoundRect(gx, gy, CONTAINER)) continue;

          // Later shapes paint over earlier ones, matching SVG document order.
          let fill = CONTAINER.fill;
          for (const s of SHAPES) if (inRoundRect(gx, gy, s)) fill = s.fill;

          r += fill[0];
          g += fill[1];
          b += fill[2];
          covered++;
        }
      }

      if (covered === 0) continue; // leave fully transparent
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r / covered);
      rgba[i + 1] = Math.round(g / covered);
      rgba[i + 2] = Math.round(b / covered);
      rgba[i + 3] = Math.round((covered / (SS * SS)) * 255);
    }
  }
  return rgba;
}

// ---- PNG encoding ----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function encodePng(rgba: Buffer, size: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  // bytes 10-12 (compression, filter, interlace) stay 0

  // Raw scanlines, each prefixed with filter type 0 (None).
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    const off = y * (stride + 1);
    raw[off] = 0;
    rgba.copy(raw, off + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- ICO container ---------------------------------------------------------

function encodeIco(entries: readonly { size: number; png: Buffer }[]): Buffer {
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // resource type 1 = icon
  dir.writeUInt16LE(entries.length, 4);

  let offset = dir.length;
  entries.forEach(({ size, png }, i) => {
    const e = 6 + i * 16;
    dir[e] = size >= 256 ? 0 : size; // 0 encodes 256
    dir[e + 1] = size >= 256 ? 0 : size;
    // e+2 palette count and e+3 reserved stay 0
    dir.writeUInt16LE(1, e + 4); // colour planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });

  return Buffer.concat([dir, ...entries.map((e) => e.png)]);
}

/** ASCII preview, so small-size legibility is reviewable without opening an image editor. */
function printAscii(rgba: Buffer, size: number): void {
  const near = (p: Buffer, c: Rgb) => Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]) + Math.abs(p[2] - c[2]) < 90;

  for (let y = 0; y < size; y++) {
    let line = "";
    for (let x = 0; x < size; x++) {
      const p = rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4);
      if (p[3] < 40) line += " ";
      else if (near(p, AMBER)) line += "A";
      else if (near(p, PAPER)) line += "#";
      else line += ".";
    }
    console.log(`  |${line}|`);
  }
  console.log("  legend: '.' navy  '#' paper  'A' amber  ' ' transparent\n");
}

const out = process.argv[2] ?? "app/favicon.ico";
const wantAscii = process.argv.includes("--print");

const entries = SIZES.map((size) => {
  const rgba = render(size);
  if (wantAscii) {
    console.log(`${size}x${size}:`);
    printAscii(rgba, size);
  }
  return { size, png: encodePng(rgba, size) };
});

const ico = encodeIco(entries);
writeFileSync(out, ico);
console.log(`wrote ${out} (${ico.length} bytes) — sizes: ${SIZES.join(", ")}`);
