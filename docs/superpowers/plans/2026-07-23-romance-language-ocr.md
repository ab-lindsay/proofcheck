# Romance-Language OCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add French/Spanish/Italian/Portuguese support to the keyless `local-ocr` tier — both the
Tesseract language pack and the field-detection vocabulary that buckets OCR'd text into
`ExtractedLabel` fields — gated on an empirical latency check, with an explicit rollback path if
that check fails.

**Architecture:** `lib/vision/local-ocr.ts`'s single `createWorker` call becomes a combined
`"eng+fra+spa+ita+por"` pack (still the same module-level singleton, still self-healing).
`lib/vision/ocr-parser.ts`'s keyword-based field detection gets per-language producer-line,
country-line, and class-type vocabulary added alongside the existing English patterns — purely
additive, no change to which regex maps to which field. `scripts/spike-ocr.ts` is extended to
measure the combined worker's cold/warm latency against concrete thresholds (≤ 6 s cold, ≤ 5 s
warm) — the empirical decision gate this whole plan is sequenced around. Four new synthetic eval
fixtures (one per language) validate the pipeline via the existing `real-world` eval set.

**Tech Stack:** TypeScript, `tesseract.js` v7, `sharp` (SVG-rendered synthetic fixtures, already a
pattern in `eval/generate-samples.ts` / `eval/generate-degraded.ts`), Vitest.

## Global Constraints

(Copied from `docs/superpowers/specs/2026-07-23-romance-language-ocr-design.md`.)

- No client-facing language selector or settings panel — this is a fixed change to `local-ocr`'s
  own behavior, zero new configuration surface.
- No language support beyond French, Spanish, Italian, Portuguese in this pass.
- No vendoring of `.traineddata` — still a runtime CDN fetch cached to `/tmp`, same as today.
- No per-request language override — the worker stays a single shared singleton.
- No changes to the health warning check, `normalizeLoose`, `lib/matching`, or cloud tier
  providers — none of them are part of this gap.
- **The decision gate (Task 2) has concrete thresholds:** cold start ≤ 6 s (2 s margin under the
  route's 8 s hard timeout) AND warm requests ≤ 5 s. If either is exceeded, stop and follow Task 2b
  (rollback) instead of Tasks 3–5.
- `eval/expected.json` and `pnpm eval`'s default mock-tier CI gate must stay completely
  unaffected — nothing in this plan touches that file.

---

### Task 1: Language pack change (`lib/vision/local-ocr.ts`)

**Files:**

- Modify: `lib/vision/local-ocr.ts:31`
- Test: `lib/vision/local-ocr.test.ts`

**Interfaces:**

- Produces: the `local-ocr` tier's Tesseract worker now recognizes `eng+fra+spa+ita+por` instead of
  `eng` only. No signature changes — `VisionProvider.extract(image, meta)` is unchanged, and
  everything downstream still receives a Zod-validated `ExtractedLabel` (invariant #2).

- [x] **Step 1: Write the failing test**

Add this test inside the existing `describe("localOcrProvider worker singleton", ...)` block in
`lib/vision/local-ocr.test.ts` (after the existing `it(...)`):

```ts
it("creates the worker with the combined Romance-language pack", async () => {
  // The worker is a module-level singleton (see local-ocr.ts) — the existing test above already
  // resolves it, so a fresh module instance is needed to observe a real createWorker() call here.
  vi.resetModules();
  mockCreateWorker.mockResolvedValueOnce({ recognize: mockRecognize });
  mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY", confidence: 90 } });
  const { localOcrProvider: freshProvider } = await import("@/lib/vision/local-ocr");
  await freshProvider.extract(Buffer.alloc(0), meta);
  expect(mockCreateWorker).toHaveBeenCalledWith("eng+fra+spa+ita+por", 1, { cachePath: "/tmp" });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run lib/vision/local-ocr.test.ts`
Expected: FAIL — `mockCreateWorker` was called with `"eng"`, not `"eng+fra+spa+ita+por"`.

- [x] **Step 3: Change the language string**

In `lib/vision/local-ocr.ts`, change line 31 from:

```ts
    workerPromise = createWorker("eng", 1, { cachePath: "/tmp" }).catch((e) => {
```

to:

```ts
    workerPromise = createWorker("eng+fra+spa+ita+por", 1, { cachePath: "/tmp" }).catch((e) => {
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run lib/vision/local-ocr.test.ts`
Expected: PASS — both tests in the file (the existing self-heal test and the new language-string
test).

- [x] **Step 5: Run the downscale test file too (no code change, confirm no regression)**

Run: `pnpm vitest run lib/vision/local-ocr-downscale.test.ts`
Expected: PASS — downscaling is language-agnostic, unaffected by this change.

- [x] **Step 6: Commit**

```bash
git add lib/vision/local-ocr.ts lib/vision/local-ocr.test.ts
git commit -m "Add French/Spanish/Italian/Portuguese packs to the local-ocr worker"
```

---

### Task 2: Extend the latency spike and run the decision gate

**Files:**

- Modify: `scripts/spike-ocr.ts` (full file replacement below)

**Interfaces:**

- Consumes: `localOcrProvider.extract` from Task 1 (now loading 5 language packs on cold init).
- Produces: a printed `ROMANCE-OCR GATE: PASS` or `ROMANCE-OCR GATE: FAIL` line — the literal
  decision point for whether Tasks 3–5 proceed, or Task 2b (rollback) runs instead.

- [x] **Step 1: Replace `scripts/spike-ocr.ts`**

Replace the full contents of `scripts/spike-ocr.ts` with:

```ts
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
      ? "ROMANCE-OCR GATE: PASS — cold <= 6 s and warm <= 5 s. Ship the combined eng+fra+spa+ita+por worker."
      : "ROMANCE-OCR GATE: FAIL — see docs/superpowers/specs/2026-07-23-romance-language-ocr-design.md §B.",
  );
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [x] **Step 2: Run the spike**

Run: `pnpm spike:ocr`
Expected: prints `local-ocr cold: <N> ms, warm: <N> ms`, the existing 2.5s DECISION INPUT line, and
a `ROMANCE-OCR GATE: PASS` or `ROMANCE-OCR GATE: FAIL` line. Record the four numbers (cold ms, warm
ms, and both DECISION INPUT / GATE outcomes) — they're needed for Step 3's branch and, if the gate
fails, for Task 2b.

Note: this is a **cold** JS-process run (first `pnpm spike:ocr` invocation after Task 1's change),
so the very first `extract()` call inside the script pays the full 5-pack traineddata download —
exactly the scenario the gate is checking. If you need to re-run it, that's a second process, so
it'll be cold again too (traineddata is cached to `/tmp` by tesseract.js's default cache logic
within a process's `cachePath`, but a fresh `node`/`tsx` process still re-inits the module-level
`workerPromise` from scratch — only the network download itself may be skipped if `/tmp` retained
the files from a prior run on the same machine).

> ### ⚠️ SUPERSEDED 2026-07-25 — this gate passed but measured the wrong thing
>
> The gate below timed **cold-vs-warm init on one small synthetic label**. That is not where the cost
> lives. Tesseract scores candidate words against _every_ loaded language model, so recognition cost
> scales with language count × the amount of text-like material found — which is invisible on a clean
> synthetic label and severe on a dense photograph of a can. Re-measured over the 46-label real-world
> set, the 5-pack worker ran **p95 4224 ms / max 7136 ms**, breaching the < 5 s budget on the keyless
> default tier, while delivering **zero** overall-verdict gain (23/46 in every language configuration).
>
> The worker is now English-only, per this spec's own §B rollback path. The parser's multilingual
> vocabulary (§C) is **retained** — it is free and does real work. See
> [`2026-07-25-local-ocr-latency-and-language-packs-design.md`](../specs/2026-07-25-local-ocr-latency-and-language-packs-design.md).
>
> Lesson recorded rather than quietly patched: a gate that measures a proxy (init cost) instead of the
> thing you care about (per-request cost on realistic input) passes with a wide margin and tells you
> nothing. The margin below (4–13×) read as reassurance and was measuring the wrong axis.
>
> **Recorded result (2026-07-23, post-hoc — this step was skipped when Task 1 first shipped; the
> feature had been live for two commits with the gate never actually run).** Ran with `/tmp/*.traineddata`
> deleted first, so this is a genuine cold start including the network fetch of all 5 packs
> (~15 MB total): **cold 1409 ms, warm 372 ms.** DECISION INPUT: within budget for server-side OCR.
> **ROMANCE-OCR GATE: PASS** (cold 1409 ms ≤ 6000 ms, warm 372 ms ≤ 5000 ms) — wide margin (4–13×
> headroom), not a borderline pass.
>
> Caveat: this was measured on this dev machine's network path, not Vercel's serverless
> environment. It's the same measurement method (and same caveat) the project already accepted for
> the original English-only spike in `ARCHITECTURE.md`'s risk table, so it's consistent with
> existing practice — but a real cold start on Vercel could still differ (container init, egress
> from Vercel's network to the traineddata CDN, concurrent cold starts under load). If `check-latency`
> (once run against the deployed URL) shows meaningfully worse numbers, revisit this decision.
>
> One benign, non-blocking log line appeared on every run: `Error: failed to load ./ita.special-words`
> — Tesseract's optional per-language auxiliary dictionary file, not the `ita.traineddata` pack
> itself. It doesn't affect recognition: all four Romance-language eval fixtures (`pnpm eval:real-world`)
> pass end-to-end, including the Italian one.

- [x] **Step 3: Branch on the gate result**

**If the output includes `ROMANCE-OCR GATE: PASS`:** commit this task's change (below), then
continue to Task 3.

**If the output includes `ROMANCE-OCR GATE: FAIL`:** commit this task's change (below), then stop
— do not proceed to Tasks 3, 4, or 5. Go to **Task 2b** instead.

Result: **PASS** — continued to Task 3 (already committed; confirmed retroactively).

- [x] **Step 4: Commit**

```bash
git add scripts/spike-ocr.ts
git commit -m "Extend spike-ocr.ts with the Romance-language latency decision gate"
```

---

### Task 2b: Rollback (only if Task 2's gate reported FAIL)

**Files:**

- Revert: `lib/vision/local-ocr.ts`, `lib/vision/local-ocr.test.ts` (Task 1's commit)
- Modify: `README.md` (Assumptions & limitations section)

**Interfaces:**

- Produces: `local-ocr` back to `createWorker("eng", ...)`; a new documented limitation in the
  README instead of a half-working feature. Nothing downstream changes — this plan touched no
  schema, API contract, or matching-layer code, so the revert is clean.

- [ ] **Step 1: Find and revert Task 1's commit**

```bash
git log --oneline -- lib/vision/local-ocr.ts | head -1
```

Take the commit hash from that output (the "Add French/Spanish/Italian/Portuguese packs..."
commit) and revert it:

```bash
git revert --no-edit <that-commit-hash>
```

- [ ] **Step 2: Add a limitations note to the README**

In `README.md`, in the `## Assumptions & limitations` section, add this bullet after the existing
"batch results table isn't virtualized" bullet (replace `<COLD>` and `<WARM>` with the actual
millisecond values Task 2's spike printed):

```markdown
- **Local-OCR is English-only.** The keyless tier's Tesseract worker loads only the `eng` language
  pack, so labels carrying French/Spanish/Italian/Portuguese producer or origin text (common on
  imported wine back labels) may OCR poorly on that tier; cloud tiers are unaffected (already
  multilingual). A combined `eng+fra+spa+ita+por` pack was prototyped and reverted after
  `pnpm spike:ocr` measured `<COLD>` ms cold / `<WARM>` ms warm — over the 6 s / 5 s decision-gate
  thresholds in `docs/superpowers/specs/2026-07-23-romance-language-ocr-design.md` §B.
```

- [ ] **Step 3: Verify the revert is clean**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean — identical to the state before Task 1.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document local-ocr's English-only limitation after the Romance-language latency gate failed"
```

- [ ] **Step 5: Stop**

This plan ends here for the FAIL branch. Do not execute Tasks 3, 4, or 5.

---

### Task 3: Field-detection vocabulary extension (`lib/vision/ocr-parser.ts`)

_(Only reached if Task 2's gate reported PASS.)_

**Files:**

- Modify: `lib/vision/ocr-parser.ts`
- Test: `lib/vision/ocr-parser.test.ts`

**Interfaces:**

- Consumes: nothing new — same `parseOcrText(text, overallConfidence): ExtractedLabel` signature.
- Produces: `classType`, `nameAndAddress`, and `countryOfOrigin` now populate correctly for French,
  Spanish, Italian, and Portuguese label vocabulary — purely additive; every existing English-path
  test keeps passing unmodified.

- [ ] **Step 1: Write the four failing tests**

Add these tests at the end of the `describe("parseOcrText", ...)` block in
`lib/vision/ocr-parser.test.ts` (before the closing `});`):

```ts
it("recognizes French producer and country phrasing", () => {
  const r = parseOcrText(
    "DOMAINE LAURENT\nCôtes du Rhône Rouge\n13.5% Vol.\n750 mL\nMis en bouteille par Domaine Laurent, Vaison-la-Romaine\nProduit de France",
    0.8,
  );
  expect(r.classType.value).toBe("Côtes du Rhône Rouge");
  expect(r.nameAndAddress.value).toContain("Mis en bouteille par");
  expect(r.countryOfOrigin.value).toBe("France");
});
it("recognizes Spanish producer and country phrasing", () => {
  const r = parseOcrText(
    "BODEGA MONTALVO\nRioja Tinto\n13.5% Vol.\n750 mL\nEmbotellado por Bodega Montalvo, Haro\nProducto de España",
    0.8,
  );
  expect(r.classType.value).toBe("Rioja Tinto");
  expect(r.nameAndAddress.value).toContain("Embotellado por");
  expect(r.countryOfOrigin.value).toBe("España");
});
it("recognizes Italian producer and country phrasing", () => {
  const r = parseOcrText(
    "TENUTA ROSSINI\nChianti Rosso\n13% Vol.\n750 mL\nImbottigliato da Tenuta Rossini, Siena\nProdotto in Italia",
    0.8,
  );
  expect(r.classType.value).toBe("Chianti Rosso");
  expect(r.nameAndAddress.value).toContain("Imbottigliato da");
  expect(r.countryOfOrigin.value).toBe("Italia");
});
it("recognizes Portuguese producer and country phrasing", () => {
  const r = parseOcrText(
    "QUINTA DO VALE\nVinho Verde Branco\n11% Vol.\n750 mL\nEngarrafado por Quinta do Vale, Porto\nProduzido em Portugal",
    0.8,
  );
  expect(r.classType.value).toBe("Vinho Verde Branco");
  expect(r.nameAndAddress.value).toContain("Engarrafado por");
  expect(r.countryOfOrigin.value).toBe("Portugal");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts`
Expected: the 4 new tests FAIL (classType/nameAndAddress/countryOfOrigin come back `null` — none of
the Romance-language vocabulary is recognized yet); all pre-existing tests still PASS.

- [ ] **Step 3: Extend `CLASS_KEYWORDS`**

In `lib/vision/ocr-parser.ts`, change:

```ts
const CLASS_KEYWORDS =
  /\b(?:whisk(?:e)?y|bourbon|rye|vodka|gin|rum|tequila|brandy|wine|ale|lager|beer|stout|porter|liqueur)\b/i;
```

to:

```ts
const CLASS_KEYWORDS =
  /\b(?:whisk(?:e)?y|bourbon|rye|vodka|gin|rum|tequila|brandy|wine|ale|lager|beer|stout|porter|liqueur|vin|vino|vinho|rouge|tinto|rosso|blanc|blanco|bianco|branco)\b/i;
```

- [ ] **Step 4: Extend the producer-line pattern**

In `lib/vision/ocr-parser.ts`, change:

```ts
const producerLine =
  lines.find((l) => /(distilled|bottled|produced|brewed|imported|made)\s+by/i.test(l) || /\bco\.,/i.test(l)) ?? null;
```

to:

```ts
const producerLine =
  lines.find(
    (l) =>
      /(distilled|bottled|produced|brewed|imported|made)\s+by/i.test(l) ||
      /mis\s+en\s+bouteille\s+par/i.test(l) ||
      /embotellado\s+por/i.test(l) ||
      /imbottigliato\s+da/i.test(l) ||
      /engarrafado\s+por/i.test(l) ||
      /\bco\.,/i.test(l),
  ) ?? null;
```

- [ ] **Step 5: Extend the country-marker pattern (extract it to a shared constant)**

`ocr-parser.ts` today has the country-marker alternation duplicated inline in two places — the
`countryLine`/`countryMatch` pair, and a second, separate inline copy inside `brandLine`'s exclusion
check. Adding 4 more languages to both copies by hand would leave three near-identical alternations
in the file (two of them for the exact same purpose); extract a single module-level source string
instead so a marker is only ever written once.

Add this new constant right after the existing `CLASS_KEYWORDS` declaration near the top of the
file:

```ts
// Shared by the country-line test, its capture, and the brandLine exclusion below — a single
// source of truth so a new marker (or language) only needs to be added in one place.
const COUNTRY_MARKERS =
  "(?:PRODUCT\\s+OF|PRODUCE\\s+OF|IMPORTED\\s+FROM|PRODUIT\\s+DE|PRODUCTO\\s+DE|PRODOTTO\\s+IN|PRODUZIDO\\s+EM)";
```

Then change:

```ts
const countryLine = lines.find((l) => /(?:PRODUCT\s+OF|PRODUCE\s+OF|IMPORTED\s+FROM)/i.test(l)) ?? null;
const countryMatch = countryLine
  ? countryLine.match(/(?:PRODUCT\s+OF|PRODUCE\s+OF|IMPORTED\s+FROM)\s+([A-Za-z ]+?)(?=$|[.]|\s+\d)/i)
  : null;
```

to:

```ts
const countryLine = lines.find((l) => new RegExp(COUNTRY_MARKERS, "i").test(l)) ?? null;
const countryMatch = countryLine
  ? countryLine.match(new RegExp(`${COUNTRY_MARKERS}\\s+([A-Za-zÀ-ÿ ]+?)(?=$|[.]|\\s+\\d)`, "i"))
  : null;
```

(Note the capture group's character class also widens from `[A-Za-z ]` to `[A-Za-zÀ-ÿ ]` — needed
so accented country names like "España" capture correctly; `À-ÿ` is the Latin-1 Supplement range
covering é/è/ñ/ç/ã/õ and similar Romance diacritics.)

Then change the duplicate inline check inside `brandLine`'s exclusion list:

```ts
        !/GOVERNMENT/i.test(l) &&
        !/(?:PRODUCT\s+OF|PRODUCE\s+OF|IMPORTED\s+FROM)/i.test(l),
```

to:

```ts
        !/GOVERNMENT/i.test(l) &&
        !new RegExp(COUNTRY_MARKERS, "i").test(l),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run lib/vision/ocr-parser.test.ts`
Expected: all tests PASS — the 4 new ones and every pre-existing one (18 total).

- [ ] **Step 7: Commit**

```bash
git add lib/vision/ocr-parser.ts lib/vision/ocr-parser.test.ts
git commit -m "Add French/Spanish/Italian/Portuguese field-detection vocabulary to ocr-parser"
```

---

### Task 4: Eval fixtures for the real-world set

**Files:**

- Create: `eval/generate-romance-samples.ts`
- Create: `eval/samples/wine-french-cotes-du-rhone.png`, `wine-spanish-rioja.png`,
  `wine-italian-chianti.png`, `wine-portuguese-vinho-verde.png` (generated, not hand-authored)
- Modify: `eval/expected-real-world.json` (append 4 entries)
- Modify: `package.json` (add `samples:romance` script)

**Interfaces:**

- Consumes: `HEALTH_WARNING_TEXT` from `@/lib/ttb/warning` (the canonical English constant — the
  mandatory warning is always English regardless of the label's other-language content).
- Produces: 4 new entries in `eval/expected-real-world.json`, run via the existing
  `pnpm eval:real-world` harness from the real-world-eval-images plan — no changes to that harness
  itself.

- [ ] **Step 1: Write `eval/generate-romance-samples.ts`**

Create `eval/generate-romance-samples.ts`:

```ts
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
```

- [ ] **Step 2: Add the `samples:romance` script**

In `package.json`, in the `"scripts"` block, add a line immediately after
`"samples:degraded": "tsx eval/generate-degraded.ts",`:

```json
    "samples:romance": "tsx eval/generate-romance-samples.ts",
```

- [ ] **Step 3: Run the generator**

Run: `pnpm samples:romance`
Expected: 4 lines of `wrote eval/samples/<file>`, exit code 0.

- [ ] **Step 4: Verify the output files**

Run: `ls eval/samples/wine-french-cotes-du-rhone.png eval/samples/wine-spanish-rioja.png eval/samples/wine-italian-chianti.png eval/samples/wine-portuguese-vinho-verde.png`
Expected: all 4 paths listed, no "No such file" errors.

- [ ] **Step 5: Append the 4 entries to `eval/expected-real-world.json`**

Open `eval/expected-real-world.json` (currently 42 entries) and change its final entry from:

```json
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  }
]
```

to:

```json
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "wine-french-cotes-du-rhone.png",
    "application": {
      "beverageType": "wine",
      "brandName": "DOMAINE LAURENT",
      "classType": "Côtes du Rhône Rouge",
      "alcoholContent": "13.5% Vol.",
      "netContents": "750 mL",
      "nameAndAddress": "Domaine Laurent, Vaison-la-Romaine, France",
      "countryOfOrigin": "France"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "wine-spanish-rioja.png",
    "application": {
      "beverageType": "wine",
      "brandName": "BODEGA MONTALVO",
      "classType": "Rioja Tinto",
      "alcoholContent": "13.5% Vol.",
      "netContents": "750 mL",
      "nameAndAddress": "Bodega Montalvo, Haro, España",
      "countryOfOrigin": "España"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "wine-italian-chianti.png",
    "application": {
      "beverageType": "wine",
      "brandName": "TENUTA ROSSINI",
      "classType": "Chianti Rosso",
      "alcoholContent": "13% Vol.",
      "netContents": "750 mL",
      "nameAndAddress": "Tenuta Rossini, Siena, Italia",
      "countryOfOrigin": "Italia"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  },
  {
    "file": "wine-portuguese-vinho-verde.png",
    "application": {
      "beverageType": "wine",
      "brandName": "QUINTA DO VALE",
      "classType": "Vinho Verde Branco",
      "alcoholContent": "11% Vol.",
      "netContents": "750 mL",
      "nameAndAddress": "Quinta do Vale, Porto, Portugal",
      "countryOfOrigin": "Portugal"
    },
    "expected": { "overall": "PASS", "violation": null },
    "tolerant": true
  }
]
```

- [ ] **Step 6: Validate JSON and run against local-ocr**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('eval/expected-real-world.json','utf8')).length)"`
Expected: `46`.

Run: `pnpm eval:real-world`
Expected: `set: real-world (46 entries)`, 46 `✓`/`✗` lines, no thrown errors, exit code 0. (The
accuracy percentages are observability, not a gate — per the design spec, a lower score on these 4
entries is expected and fine as long as nothing crashes.)

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add eval/generate-romance-samples.ts eval/samples/wine-french-cotes-du-rhone.png eval/samples/wine-spanish-rioja.png eval/samples/wine-italian-chianti.png eval/samples/wine-portuguese-vinho-verde.png eval/expected-real-world.json package.json
git commit -m "Add French/Spanish/Italian/Portuguese synthetic eval fixtures to the real-world set"
```

---

## Final verification (after Task 4, PASS branch only)

- [ ] Run: `pnpm typecheck && pnpm lint && pnpm test` — expect all green.
- [ ] Run: `pnpm eval` — expect `13/13 (100%)` overall, `8/8 (100%)` planted violations caught,
      unchanged from before this plan.
- [ ] Run: `pnpm eval:real-world` — expect `set: real-world (46 entries)`, no thrown errors, exit
      code 0. Note the printed accuracy percentages for the record.
- [ ] Confirm `git log --oneline` shows, in order: the Task 1 language-pack commit, the Task 2
      spike-gate commit, the Task 3 vocabulary commit, and the Task 4 fixtures commit — no rollback
      commit present (that only exists on the FAIL branch, Task 2b).
