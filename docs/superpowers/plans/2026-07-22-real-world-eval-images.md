# Real-World Eval Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the 10 already-sourced real TTB label photos (17 images) into a real-world eval
set, add a camera-quality degradation generator (blur/skew/glare/low-res), and extend batch
e2e coverage — all without touching the CI-gating mock eval.

**Architecture:** A second, parallel eval fixture set (`eval/expected-real-world.json`) alongside
the existing `eval/expected.json`, selected via a new `--set` flag on `eval/run.ts`. A new
`tolerant` flag on eval entries loosens per-field scoring to accept REVIEW alongside MATCH
(never MISMATCH) — the correct outcome when a field is genuinely absent from one panel of a
two-sided label, or when OCR confidence is legitimately lower on a harder or degraded image.

**Tech Stack:** TypeScript, `tsx` (eval scripts), `sharp` (image generation, already a
dependency), Playwright (e2e).

## Global Constraints

(Copied from `docs/superpowers/specs/2026-07-22-real-world-eval-images-design.md`.)

- `eval/expected.json` and `pnpm eval`'s default mock-tier run must stay completely unaffected —
  same file, same 100%-required CI gate, same speed. No entry from this plan is ever added to it.
- Multi-image (front + back) merge support is explicitly **not** built in this plan — front and
  back images are wired in as **independent single-image entries**, requiring zero
  application-code changes (the app has only ever supported one image per verification).
- No image preprocessing (deskew/glare correction) is added to the app itself — the degradation
  generator is test-fixture tooling only.
- No separate batch-accuracy harness — batch is a client-side fan-out over `/api/verify`
  (`hooks/use-batch.ts`), so `eval --set real-world --provider local-ocr` already covers batch
  accuracy; only batch _workflow_ robustness is covered here, via Playwright.
- The `mock` tier can never run the `real-world` set (it only recognizes bundled synthetic
  filenames via fixed fixtures in `lib/vision/mock.ts` and throws for anything else) — this must
  fail fast with a clear message, not an opaque per-entry crash.
- Follow existing patterns: `sharp` for image generation (as `eval/generate-samples.ts` already
  does), `tsx` for eval scripts, Playwright conventions already established in `e2e/batch.spec.ts`.

---

### Task 1: `eval/run.ts` — `--set` flag, mock/real-world guard, `tolerant` scoring

**Files:**

- Modify: `eval/run.ts` (full file replacement below)
- Modify: `package.json` (add `eval:real-world` script)
- Create: `eval/expected-real-world.json` (empty array — populated in Task 2)

**Interfaces:**

- Produces: `ExpectedEntry.tolerant?: boolean` — later tasks (2, 3) set this `true` on every
  entry they add. `--set real-world` reads `eval/expected-real-world.json` instead of
  `eval/expected.json`.

- [ ] **Step 1: Create the empty real-world fixture file**

Create `eval/expected-real-world.json`:

```json
[]
```

- [ ] **Step 2: Replace `eval/run.ts` with the updated version**

Replace the full contents of `eval/run.ts` with:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ApplicationDataSchema, type ApplicationData, type Verdict } from "@/lib/schema";
import { providerByName } from "@/lib/vision/select";
import { verifyLabel } from "@/lib/matching/verify";

interface ExpectedEntry {
  file: string;
  application: unknown;
  expected: { overall: "PASS" | "FAIL"; violation: { field: string; verdictOneOf: Verdict[] } | null };
  /** Real photo or degraded capture: a present field may legitimately resolve to REVIEW instead
   *  of MATCH (low OCR confidence, or genuinely absent from this particular image) without that
   *  being a scoring error. Never set on the synthetic default set. */
  tolerant?: boolean;
}

const MATCHED_APP_FIELDS = [
  "brandName",
  "classType",
  "alcoholContent",
  "netContents",
  "nameAndAddress",
  "countryOfOrigin",
] as const;

const SETS: Record<string, string> = {
  default: path.join("eval", "expected.json"),
  "real-world": path.join("eval", "expected-real-world.json"),
};

/** Spec §10 "expected per-field verdicts": every field the matcher compares defaults to MATCH
 *  (or MATCH-or-REVIEW for a tolerant entry); the planted violation overrides its own field. */
function expectedFieldVerdicts(entry: ExpectedEntry, app: ApplicationData): Record<string, Verdict[]> {
  const base: Verdict[] = entry.tolerant ? ["MATCH", "REVIEW"] : ["MATCH"];
  const expected: Record<string, Verdict[]> = { healthWarningStatement: base };
  for (const field of MATCHED_APP_FIELDS) if (app[field]) expected[field] = base;
  const violation = entry.expected.violation;
  if (violation) expected[violation.field] = violation.verdictOneOf;
  return expected;
}

async function main() {
  const flagIndex = process.argv.indexOf("--provider");
  const providerName = flagIndex >= 0 ? process.argv[flagIndex + 1] : "mock";
  const provider = providerByName(providerName);

  const setIndex = process.argv.indexOf("--set");
  const setName = setIndex >= 0 ? process.argv[setIndex + 1] : "default";
  const setPath = SETS[setName];
  if (!setPath) {
    console.error(`Unknown --set "${setName}". Valid sets: ${Object.keys(SETS).join(", ")}`);
    process.exit(1);
    return;
  }
  if (setName === "real-world" && provider.name === "mock") {
    console.error(
      'The "real-world" set contains real photos and degraded captures the mock tier cannot read ' +
        "(it only recognizes bundled synthetic filenames via fixed fixtures). Re-run with " +
        "`--provider local-ocr` or `--provider cloud`.",
    );
    process.exit(1);
    return;
  }

  // Throttle between labels so cloud runs stay under free-tier rate caps
  // (e.g. Gemini free tier ~5 req/min → --delay 13000). Default 0: mock/local-ocr unaffected.
  const delayIndex = process.argv.indexOf("--delay");
  const delayMs = delayIndex >= 0 ? Number(process.argv[delayIndex + 1]) : 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const entries: ExpectedEntry[] = JSON.parse(await readFile(setPath, "utf8"));
  let overallCorrect = 0;
  let violationsCaught = 0;
  let violationsTotal = 0;
  const fieldStats = new Map<string, { correct: number; total: number }>();

  for (const [index, entry] of entries.entries()) {
    if (delayMs > 0 && index > 0) await sleep(delayMs);
    const app = ApplicationDataSchema.parse(entry.application);
    const image = await readFile(path.join("eval", "samples", entry.file));
    const extracted = await provider.extract(image, { filename: entry.file, mimeType: "image/png" });
    const result = verifyLabel(app, extracted);

    const overallOk = result.overall === entry.expected.overall;
    if (overallOk) overallCorrect++;

    for (const [field, accepted] of Object.entries(expectedFieldVerdicts(entry, app))) {
      const stats = fieldStats.get(field) ?? { correct: 0, total: 0 };
      stats.total++;
      const actual = result.fields.find((f) => f.field === field)?.verdict;
      if (actual !== undefined && accepted.includes(actual)) stats.correct++;
      fieldStats.set(field, stats);
    }

    let violationNote = "";
    if (entry.expected.violation) {
      violationsTotal++;
      const actual = result.fields.find((f) => f.field === entry.expected.violation?.field);
      const caught = actual !== undefined && entry.expected.violation.verdictOneOf.includes(actual.verdict);
      if (caught) violationsCaught++;
      violationNote = ` · violation(${entry.expected.violation.field}): ${caught ? "CAUGHT" : `MISSED (got ${actual?.verdict ?? "no row"})`}`;
    }
    console.log(
      `${overallOk ? "✓" : "✗"} ${entry.file} → ${result.overall} (expected ${entry.expected.overall})${violationNote}`,
    );
  }

  const overallPct = entries.length === 0 ? 100 : Math.round((overallCorrect / entries.length) * 100);
  const violationPct = violationsTotal === 0 ? 100 : Math.round((violationsCaught / violationsTotal) * 100);
  console.log(`\nprovider: ${provider.name}`);
  console.log(`set: ${setName} (${entries.length} entries)`);
  const perField = [...fieldStats.entries()].map(([f, st]) => `${f} ${st.correct}/${st.total}`).join(" · ");
  const fieldsPerfect = [...fieldStats.values()].every((st) => st.correct === st.total);
  console.log(`overall verdict accuracy: ${overallCorrect}/${entries.length} (${overallPct}%)`);
  console.log(`per-field verdict accuracy: ${perField}`);
  console.log(`planted violations caught: ${violationsCaught}/${violationsTotal} (${violationPct}%)`);

  if (
    setName === "default" &&
    provider.name === "mock" &&
    (overallCorrect < entries.length || violationsCaught < violationsTotal || !fieldsPerfect)
  ) {
    console.error("\nFAIL: the mock tier must score 100% — a matcher regression.");
    process.exit(1);
  }
  process.exit(0); // terminate lingering tesseract worker threads (local-ocr keeps the event loop alive)
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Add the `eval:real-world` convenience script**

In `package.json`, in the `"scripts"` block, add a line immediately after `"eval": "tsx eval/run.ts",`:

```json
    "eval:real-world": "tsx eval/run.ts --set real-world --provider local-ocr",
```

- [ ] **Step 4: Verify the default set is unaffected**

Run: `pnpm eval`
Expected: unchanged from before this plan — `overall verdict accuracy: 13/13 (100%)`,
`planted violations caught: 8/8 (100%)`, exit code 0.

- [ ] **Step 5: Verify the mock/real-world guard**

Run: `npx tsx eval/run.ts --set real-world`
Expected: prints the "mock tier cannot read" error message and exits with code 1 (check with
`echo $?` after — expect `1`). No stack trace, no attempt to read the real-world file's images.

- [ ] **Step 6: Verify the real-world set runs cleanly when empty**

Run: `pnpm eval:real-world`
Expected: `set: real-world (0 entries)`, `overall verdict accuracy: 0/0 (100%)`,
`planted violations caught: 0/0 (100%)`, exit code 0. (First run may take longer while
`tesseract.js` downloads language data — this is expected, matches existing `local-ocr` behavior.)

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add eval/run.ts eval/expected-real-world.json package.json
git commit -m "Add --set flag and tolerant scoring to eval/run.ts for a real-world eval set"
```

---

### Task 2: Author real-photo ground truth (17 entries)

**Files:**

- Modify: `eval/expected-real-world.json` (replace `[]` with the 17 entries below)

**Interfaces:**

- Consumes: `ExpectedEntry` shape and `tolerant` field from Task 1.
- Produces: 17 populated entries other tasks do not depend on directly (Task 3 appends
  independently; Task 4 references two specific filenames by name, listed in its own brief).

Ground truth for each entry is drawn directly from `eval/samples/SOURCES.md` (already committed,
documents what's printed on each real label and which panel — front or back — carries it). Every
real photo is a genuine TTB-approved label with no planted violation, so every entry's
`expected.violation` is `null`. `expected.overall` is `"PASS"` for all 17 — REVIEW on any field
(the expected outcome for a field only visible on the other panel, or read with lower confidence)
never flips `overall` to FAIL. Every entry sets `tolerant: true`.

- [ ] **Step 1: Write the full 17-entry file**

Replace the contents of `eval/expected-real-world.json` with:

```json
[
  {
    "file": "spirits-old-tub-bourbon-front.jpg",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "OLD TUB",
      "classType": "Kentucky Straight Bourbon Whiskey",
      "alcoholContent": "50% Alc./Vol. 100 Proof",
      "netContents": "750 mL",
      "nameAndAddress": "James B. Beam Distilling Co., Clermont, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "spirits-old-tub-bourbon-back.jpg",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "OLD TUB",
      "classType": "Kentucky Straight Bourbon Whiskey",
      "alcoholContent": "50% Alc./Vol. 100 Proof",
      "netContents": "750 mL",
      "nameAndAddress": "James B. Beam Distilling Co., Clermont, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "spirits-titos-handmade-vodka-front.jpg",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "Tito's Handmade",
      "classType": "Vodka",
      "alcoholContent": "40% Alc./Vol.",
      "netContents": "1L",
      "nameAndAddress": "Fifth Generation, Inc., Austin, TX"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "spirits-titos-handmade-vodka-back.jpg",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "Tito's Handmade",
      "classType": "Vodka",
      "alcoholContent": "40% Alc./Vol.",
      "netContents": "1L",
      "nameAndAddress": "Fifth Generation, Inc., Austin, TX"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "spirits-buffalo-trace-experimental-front.png",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "Buffalo Trace",
      "classType": "Straight Bourbon Whiskey (Made with Peated Malt)",
      "alcoholContent": "45% Alc/Vol (90 Proof)",
      "netContents": "375 mL",
      "nameAndAddress": "Buffalo Trace Distillery Inc, Frankfort, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "spirits-buffalo-trace-experimental-back.png",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "Buffalo Trace",
      "classType": "Straight Bourbon Whiskey (Made with Peated Malt)",
      "alcoholContent": "45% Alc/Vol (90 Proof)",
      "netContents": "375 mL",
      "nameAndAddress": "Buffalo Trace Distillery Inc, Frankfort, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "spirits-makers-mark-founders-series-front.jpg",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "Maker's Mark",
      "classType": "Kentucky Straight Bourbon Whisky",
      "alcoholContent": "45% Alc/Vol",
      "netContents": "1 Liter",
      "nameAndAddress": "The Maker's Mark Distillery, Inc., Star Hill Farm, Loretto, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "spirits-makers-mark-founders-series-back.jpg",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "Maker's Mark",
      "classType": "Kentucky Straight Bourbon Whisky",
      "alcoholContent": "45% Alc/Vol",
      "netContents": "1 Liter",
      "nameAndAddress": "The Maker's Mark Distillery, Inc., Star Hill Farm, Loretto, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "wine-kendall-jackson-vintners-reserve-rose-front.jpg",
    "application": {
      "beverageType": "wine",
      "brandName": "Kendall-Jackson Vintner's Reserve",
      "classType": "Rosé Wine",
      "alcoholContent": "13.5% Alc/Vol",
      "netContents": "750 mL",
      "nameAndAddress": "Kendall-Jackson Vineyards & Winery, Santa Rosa, CA"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "wine-kendall-jackson-vintners-reserve-rose-back.jpg",
    "application": {
      "beverageType": "wine",
      "brandName": "Kendall-Jackson Vintner's Reserve",
      "classType": "Rosé Wine",
      "alcoholContent": "13.5% Alc/Vol",
      "netContents": "750 mL",
      "nameAndAddress": "Kendall-Jackson Vineyards & Winery, Santa Rosa, CA"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "wine-chateau-ste-michelle-grenache-blanc-front.jpg",
    "application": {
      "beverageType": "wine",
      "brandName": "Chateau Ste Michelle",
      "classType": "Grenache Blanc",
      "alcoholContent": "13.5% Alc by Vol",
      "netContents": "750 mL",
      "nameAndAddress": "Chateau Ste. Michelle, Woodinville, WA"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "wine-chateau-ste-michelle-grenache-blanc-back.jpg",
    "application": {
      "beverageType": "wine",
      "brandName": "Chateau Ste Michelle",
      "classType": "Grenache Blanc",
      "alcoholContent": "13.5% Alc by Vol",
      "netContents": "750 mL",
      "nameAndAddress": "Chateau Ste. Michelle, Woodinville, WA"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "wine-la-crema-saralees-chardonnay-front.png",
    "application": {
      "beverageType": "wine",
      "brandName": "La Crema Saralee's Vineyard",
      "classType": "Chardonnay",
      "alcoholContent": "13.5% Alc/Vol",
      "netContents": "750 mL",
      "nameAndAddress": "La Crema, Windsor, California"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "wine-la-crema-saralees-chardonnay-back.png",
    "application": {
      "beverageType": "wine",
      "brandName": "La Crema Saralee's Vineyard",
      "classType": "Chardonnay",
      "alcoholContent": "13.5% Alc/Vol",
      "netContents": "750 mL",
      "nameAndAddress": "La Crema, Windsor, California"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "malt-sierra-nevada-oktoberfest-can.jpg",
    "application": {
      "beverageType": "malt-beverage",
      "brandName": "Sierra Nevada Oktoberfest",
      "classType": "Marzen-Style Amber Lager",
      "alcoholContent": "5.5% ABV",
      "netContents": "12 FL OZ",
      "nameAndAddress": "Sierra Nevada Brewing Co., Chico, CA & Mills River, NC"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "malt-samuel-adams-boston-lager-can.jpg",
    "application": {
      "beverageType": "malt-beverage",
      "brandName": "Samuel Adams Boston Lager",
      "classType": "Lager",
      "alcoholContent": "5.0% Alc./Vol.",
      "netContents": "12 FL OZ",
      "nameAndAddress": "The Boston Beer Co., Boston, MA / Breinigsville, PA / Cincinnati, OH"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "malt-guinness-draught-stout-can.jpg",
    "application": {
      "beverageType": "malt-beverage",
      "brandName": "Guinness",
      "classType": "Draught Stout",
      "alcoholContent": "4.1% Alc./Vol.",
      "netContents": "14.9 FL OZ",
      "nameAndAddress": "Guinness & Co., St. James's Gate, Dublin, Ireland; imported by Diageo Beer Company USA, New York, NY",
      "countryOfOrigin": "Ireland"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  }
]
```

- [ ] **Step 2: Validate and run against local-ocr**

Run: `pnpm eval:real-world`
Expected: `set: real-world (17 entries)`, 17 `✓`/`✗` lines (either is fine — this is an
observability report, not a gate; see design doc §C), no thrown errors, no `SyntaxError` or Zod
validation error, exit code 0.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean (JSON isn't typechecked, but confirms `eval/run.ts` still compiles against the
now-larger real data flowing through `ApplicationDataSchema.parse`).

- [ ] **Step 4: Commit**

```bash
git add eval/expected-real-world.json
git commit -m "Add real-photo ground truth for the 10 sourced TTB labels (17 images)"
```

---

### Task 3: Camera-quality degradation generator

**Files:**

- Create: `eval/generate-degraded.ts`
- Create: `eval/samples/degraded/*.{png,jpg}` (25 files, generated by the script — not hand-authored)
- Modify: `eval/expected-real-world.json` (append 25 entries)
- Modify: `package.json` (add `samples:degraded` script)

**Interfaces:**

- Produces: `eval/samples/degraded/<base-stem>-<technique>.<ext>` for
  `technique ∈ {blur, skew, glare, lowres}` (same extension as the source) and
  `<base-stem>-combo.jpg` (always `.jpg`, regardless of source format).

- [ ] **Step 1: Write `eval/generate-degraded.ts`**

Create `eval/generate-degraded.ts`:

```ts
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
```

- [ ] **Step 2: Add the `samples:degraded` script**

In `package.json`, in the `"scripts"` block, add a line immediately after
`"samples": "tsx eval/generate-samples.ts",`:

```json
    "samples:degraded": "tsx eval/generate-degraded.ts",
```

- [ ] **Step 3: Run the generator**

Run: `pnpm samples:degraded`
Expected: 5 lines of `wrote 5 degraded variants for <file>`, exit code 0.

- [ ] **Step 4: Verify the output files**

Run: `ls eval/samples/degraded | wc -l`
Expected: `25`.

- [ ] **Step 5: Append the 25 degraded entries to `eval/expected-real-world.json`**

Open `eval/expected-real-world.json` (17 entries from Task 2) and append these 25 entries inside
the existing array (add a comma after the last entry from Task 2, then these):

```json
  {
    "file": "degraded/old-tom-clean-blur.png",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "OLD TOM DISTILLERY",
      "classType": "Kentucky Straight Bourbon Whiskey",
      "alcoholContent": "45% Alc./Vol. (90 Proof)",
      "netContents": "750 mL",
      "nameAndAddress": "Old Tom Distillery Co., Bardstown, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/old-tom-clean-skew.png",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "OLD TOM DISTILLERY",
      "classType": "Kentucky Straight Bourbon Whiskey",
      "alcoholContent": "45% Alc./Vol. (90 Proof)",
      "netContents": "750 mL",
      "nameAndAddress": "Old Tom Distillery Co., Bardstown, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/old-tom-clean-glare.png",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "OLD TOM DISTILLERY",
      "classType": "Kentucky Straight Bourbon Whiskey",
      "alcoholContent": "45% Alc./Vol. (90 Proof)",
      "netContents": "750 mL",
      "nameAndAddress": "Old Tom Distillery Co., Bardstown, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/old-tom-clean-lowres.png",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "OLD TOM DISTILLERY",
      "classType": "Kentucky Straight Bourbon Whiskey",
      "alcoholContent": "45% Alc./Vol. (90 Proof)",
      "netContents": "750 mL",
      "nameAndAddress": "Old Tom Distillery Co., Bardstown, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/old-tom-clean-combo.jpg",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "OLD TOM DISTILLERY",
      "classType": "Kentucky Straight Bourbon Whiskey",
      "alcoholContent": "45% Alc./Vol. (90 Proof)",
      "netContents": "750 mL",
      "nameAndAddress": "Old Tom Distillery Co., Bardstown, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/kirkbride-import-wine-blur.png",
    "application": {
      "beverageType": "wine",
      "brandName": "KIRKBRIDE CELLARS",
      "classType": "White Wine",
      "alcoholContent": "13.5% Alc./Vol.",
      "netContents": "750 mL",
      "countryOfOrigin": "France"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/kirkbride-import-wine-skew.png",
    "application": {
      "beverageType": "wine",
      "brandName": "KIRKBRIDE CELLARS",
      "classType": "White Wine",
      "alcoholContent": "13.5% Alc./Vol.",
      "netContents": "750 mL",
      "countryOfOrigin": "France"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/kirkbride-import-wine-glare.png",
    "application": {
      "beverageType": "wine",
      "brandName": "KIRKBRIDE CELLARS",
      "classType": "White Wine",
      "alcoholContent": "13.5% Alc./Vol.",
      "netContents": "750 mL",
      "countryOfOrigin": "France"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/kirkbride-import-wine-lowres.png",
    "application": {
      "beverageType": "wine",
      "brandName": "KIRKBRIDE CELLARS",
      "classType": "White Wine",
      "alcoholContent": "13.5% Alc./Vol.",
      "netContents": "750 mL",
      "countryOfOrigin": "France"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/kirkbride-import-wine-combo.jpg",
    "application": {
      "beverageType": "wine",
      "brandName": "KIRKBRIDE CELLARS",
      "classType": "White Wine",
      "alcoholContent": "13.5% Alc./Vol.",
      "netContents": "750 mL",
      "countryOfOrigin": "France"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/wrong-abv-blur.png",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "BLACK RIVER",
      "classType": "Straight Bourbon Whiskey",
      "alcoholContent": "45% Alc./Vol. (90 Proof)",
      "netContents": "750 mL"
    },
    "expected": { "overall": "FAIL", "violation": { "field": "alcoholContent", "verdictOneOf": ["MISMATCH", "REVIEW"] } },
    "tolerant": true
  },
  {
    "file": "degraded/wrong-abv-skew.png",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "BLACK RIVER",
      "classType": "Straight Bourbon Whiskey",
      "alcoholContent": "45% Alc./Vol. (90 Proof)",
      "netContents": "750 mL"
    },
    "expected": { "overall": "FAIL", "violation": { "field": "alcoholContent", "verdictOneOf": ["MISMATCH", "REVIEW"] } },
    "tolerant": true
  },
  {
    "file": "degraded/wrong-abv-glare.png",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "BLACK RIVER",
      "classType": "Straight Bourbon Whiskey",
      "alcoholContent": "45% Alc./Vol. (90 Proof)",
      "netContents": "750 mL"
    },
    "expected": { "overall": "FAIL", "violation": { "field": "alcoholContent", "verdictOneOf": ["MISMATCH", "REVIEW"] } },
    "tolerant": true
  },
  {
    "file": "degraded/wrong-abv-lowres.png",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "BLACK RIVER",
      "classType": "Straight Bourbon Whiskey",
      "alcoholContent": "45% Alc./Vol. (90 Proof)",
      "netContents": "750 mL"
    },
    "expected": { "overall": "FAIL", "violation": { "field": "alcoholContent", "verdictOneOf": ["MISMATCH", "REVIEW"] } },
    "tolerant": true
  },
  {
    "file": "degraded/wrong-abv-combo.jpg",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "BLACK RIVER",
      "classType": "Straight Bourbon Whiskey",
      "alcoholContent": "45% Alc./Vol. (90 Proof)",
      "netContents": "750 mL"
    },
    "expected": { "overall": "FAIL", "violation": { "field": "alcoholContent", "verdictOneOf": ["MISMATCH", "REVIEW"] } },
    "tolerant": true
  },
  {
    "file": "degraded/spirits-old-tub-bourbon-back-blur.jpg",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "OLD TUB",
      "classType": "Kentucky Straight Bourbon Whiskey",
      "alcoholContent": "50% Alc./Vol. 100 Proof",
      "netContents": "750 mL",
      "nameAndAddress": "James B. Beam Distilling Co., Clermont, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/spirits-old-tub-bourbon-back-skew.jpg",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "OLD TUB",
      "classType": "Kentucky Straight Bourbon Whiskey",
      "alcoholContent": "50% Alc./Vol. 100 Proof",
      "netContents": "750 mL",
      "nameAndAddress": "James B. Beam Distilling Co., Clermont, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/spirits-old-tub-bourbon-back-glare.jpg",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "OLD TUB",
      "classType": "Kentucky Straight Bourbon Whiskey",
      "alcoholContent": "50% Alc./Vol. 100 Proof",
      "netContents": "750 mL",
      "nameAndAddress": "James B. Beam Distilling Co., Clermont, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/spirits-old-tub-bourbon-back-lowres.jpg",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "OLD TUB",
      "classType": "Kentucky Straight Bourbon Whiskey",
      "alcoholContent": "50% Alc./Vol. 100 Proof",
      "netContents": "750 mL",
      "nameAndAddress": "James B. Beam Distilling Co., Clermont, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/spirits-old-tub-bourbon-back-combo.jpg",
    "application": {
      "beverageType": "distilled-spirits",
      "brandName": "OLD TUB",
      "classType": "Kentucky Straight Bourbon Whiskey",
      "alcoholContent": "50% Alc./Vol. 100 Proof",
      "netContents": "750 mL",
      "nameAndAddress": "James B. Beam Distilling Co., Clermont, KY"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/wine-la-crema-saralees-chardonnay-back-blur.png",
    "application": {
      "beverageType": "wine",
      "brandName": "La Crema Saralee's Vineyard",
      "classType": "Chardonnay",
      "alcoholContent": "13.5% Alc/Vol",
      "netContents": "750 mL",
      "nameAndAddress": "La Crema, Windsor, California"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/wine-la-crema-saralees-chardonnay-back-skew.png",
    "application": {
      "beverageType": "wine",
      "brandName": "La Crema Saralee's Vineyard",
      "classType": "Chardonnay",
      "alcoholContent": "13.5% Alc/Vol",
      "netContents": "750 mL",
      "nameAndAddress": "La Crema, Windsor, California"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/wine-la-crema-saralees-chardonnay-back-glare.png",
    "application": {
      "beverageType": "wine",
      "brandName": "La Crema Saralee's Vineyard",
      "classType": "Chardonnay",
      "alcoholContent": "13.5% Alc/Vol",
      "netContents": "750 mL",
      "nameAndAddress": "La Crema, Windsor, California"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/wine-la-crema-saralees-chardonnay-back-lowres.png",
    "application": {
      "beverageType": "wine",
      "brandName": "La Crema Saralee's Vineyard",
      "classType": "Chardonnay",
      "alcoholContent": "13.5% Alc/Vol",
      "netContents": "750 mL",
      "nameAndAddress": "La Crema, Windsor, California"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "degraded/wine-la-crema-saralees-chardonnay-back-combo.jpg",
    "application": {
      "beverageType": "wine",
      "brandName": "La Crema Saralee's Vineyard",
      "classType": "Chardonnay",
      "alcoholContent": "13.5% Alc/Vol",
      "netContents": "750 mL",
      "nameAndAddress": "La Crema, Windsor, California"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  }
```

After appending, the file must be one valid JSON array of 42 objects total (17 from Task 2 + 25
here) — double-check the comma placement between the last Task-2 entry and the first entry above,
and that the file ends with a single closing `]`.

- [ ] **Step 6: Validate JSON and run against local-ocr**

Run: `node -e "JSON.parse(require('fs').readFileSync('eval/expected-real-world.json','utf8')).length"`
Expected: `42`.

Run: `pnpm eval:real-world`
Expected: `set: real-world (42 entries)`, 42 `✓`/`✗` lines, no thrown errors, exit code 0.

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add eval/generate-degraded.ts eval/samples/degraded eval/expected-real-world.json package.json
git commit -m "Add camera-quality degradation generator and wire 25 degraded fixtures into the real-world eval set"
```

---

### Task 4: Batch e2e coverage for real-world images

**Files:**

- Create: `e2e/fixtures/real-world-batch.csv`
- Modify: `e2e/batch.spec.ts` (append one new test)

**Interfaces:**

- Consumes: `eval/samples/old-tom-clean.png` (existing, mock-recognized),
  `eval/samples/spirits-old-tub-bourbon-front.jpg` (existing real photo, not mock-recognized),
  `eval/samples/degraded/old-tom-clean-blur.png` (from Task 3, not mock-recognized).

- [ ] **Step 1: Create the batch CSV fixture**

Create `e2e/fixtures/real-world-batch.csv`:

```csv
image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin
old-tom-clean.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol. (90 Proof),750 mL,"Old Tom Distillery Co., Bardstown, KY",
spirits-old-tub-bourbon-front.jpg,distilled-spirits,OLD TUB,Kentucky Straight Bourbon Whiskey,50% Alc./Vol. 100 Proof,750 mL,,
old-tom-clean-blur.png,distilled-spirits,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol. (90 Proof),750 mL,,
```

(File inputs are matched by browser `File.name`, which is always the basename regardless of the
full filesystem path passed to Playwright's `setInputFiles` — see `app/batch/page.tsx:85` and
`:27` — so the CSV rows use basenames only, matching how `old-tom-clean.png` is referenced in the
existing `e2e/fixtures/batch.csv`.)

- [ ] **Step 2: Append the new test to `e2e/batch.spec.ts`**

Add this test at the end of `e2e/batch.spec.ts` (after the existing `test(...)` block, same file,
same `import { expect, test } from "@playwright/test";` at the top — no new imports needed):

```ts
test("batch handles real-world photos and a degraded capture without aborting", async ({ page }) => {
  await page.goto("/batch");
  await page.getByLabel("Applications CSV").setInputFiles("e2e/fixtures/real-world-batch.csv");
  await page
    .getByLabel("Label images")
    .setInputFiles([
      "eval/samples/old-tom-clean.png",
      "eval/samples/spirits-old-tub-bourbon-front.jpg",
      "eval/samples/degraded/old-tom-clean-blur.png",
    ]);
  await page.getByRole("button", { name: /Verify batch/ }).click();
  // old-tom-clean.png is a recognized mock fixture → PASS.
  await expect(page.getByRole("cell", { name: "PASS" })).toBeVisible();
  // The real photo and the degraded capture aren't in the mock tier's fixed fixture set, so each
  // becomes a per-row ERROR — the correct "ask for a better image" recovery path (workflow 3 in
  // the design spec) exercised at batch scale, not a bug in this test.
  await expect(page.getByRole("cell", { name: "ERROR" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Download results CSV" })).toBeEnabled();
});
```

- [ ] **Step 3: Run the new e2e test**

Run: `pnpm e2e e2e/batch.spec.ts`
Expected: both tests in `e2e/batch.spec.ts` pass (the pre-existing one and the new one).

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add e2e/fixtures/real-world-batch.csv e2e/batch.spec.ts
git commit -m "Add batch e2e coverage for real-world photos and a degraded capture"
```

---

## Final verification (after all 4 tasks)

- [ ] Run: `pnpm typecheck && pnpm lint && pnpm test` — expect all green (unchanged from before
      this plan; nothing here touches `lib/` or component/hook test files).
- [ ] Run: `pnpm eval` — expect `13/13 (100%)` overall, `8/8 (100%)` planted violations caught,
      unchanged from before this plan.
- [ ] Run: `pnpm eval:real-world` — expect `set: real-world (42 entries)`, no thrown errors, exit
      code 0. Note the printed accuracy percentages for the record (this is the actual deliverable —
      a real signal on how `local-ocr` handles real photography and degraded captures — not a
      pass/fail gate).
- [ ] Run: `pnpm e2e` — expect all e2e specs green, including both `batch.spec.ts` tests.
