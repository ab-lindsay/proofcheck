# AI-Powered Alcohol Label Verification — Design Spec

**Date:** 2026-07-21
**Status:** Approved for planning
**Amended:** 2026-07-21 (during implementation) — health-warning **case/spacing-only** deviations
re-routed MISMATCH → REVIEW after real-label evidence from the eval set (9 of 10 approved COLAs
print an all-caps body; see §6 "documented discrepancy"). Wording, punctuation, and the ALL-CAPS
`GOVERNMENT WARNING:` prefix remain strict MISMATCHes. Supersedes the original strict
case-sensitive-to-MISMATCH rule here, in `CLAUDE.md` §Invariants, and `ARCHITECTURE.md` invariant 5.

**Amended:** 2026-07-26 (codebase cleanup) — the verdict vocabulary throughout this document is
updated to match what TTB itself calls its COLAs Online dispositions: `MATCH` → `COMPLIANT`,
`MISMATCH` → `NON_COMPLIANT`, `REVIEW` → `NEEDS_CORRECTION`. The overall verdict also widened from
**PASS/FAIL** to a three-way `APPROVED | NEEDS_CORRECTION | REJECTED` — `REJECTED` iff any field is
`NON_COMPLIANT`, else `NEEDS_CORRECTION` iff any field needs correction, else `APPROVED` (what this
document originally called "REVIEW-only does not fail" is now its own overall state, not folded into
a pass). This is a naming and disposition-cardinality change only — the underlying rules below are
unchanged; `CLAUDE.md` and `docs/ARCHITECTURE.md` remain canonical on any conflict.
**Context:** Take-home project. A standalone proof-of-concept web app that helps TTB compliance
agents verify that an alcohol beverage label's artwork matches the data submitted in its
application. Not integrated with COLAs Online (TTB's filing system); no sensitive data persisted.

**Repo:** `ttb-label-verifier` · **Product name (UI + README branding):** **ProofCheck**

---

## 1. Problem & Goals

Compliance agents today verify labels by eye: does the brand name, ABV, net contents, and
health warning statement on the label match the application? It is mostly routine matching that
"drowns" a small team. This tool automates the routine matching so agents can focus on judgment.

**Primary goal:** Given a label image and its application data, extract the label's fields via
AI and produce a clear, per-field verdict (COMPLIANT / NON_COMPLIANT / NEEDS_CORRECTION) plus an
overall APPROVED / NEEDS_CORRECTION / REJECTED disposition.

**Success criteria (derived from stakeholder interviews):**

- **Fast:** end-to-end result for a single label in **< 5 seconds**. (Sarah: the prior vendor's
  30–40s killed adoption.)
- **Obvious UX:** usable by a non-technical 73-year-old — one screen, big targets, unmistakable
  result, no hunting for buttons. (Sarah.)
- **Batch:** handle 200–300 labels submitted at once without one-at-a-time drudgery. (Sarah/Janet.)
- **Correct on the strict fields:** the health warning statement is validated **deterministically,
  word-for-word**: exact after collapsing whitespace runs (a line-wrapped transcription still counts
  as exact) → COMPLIANT; wording and punctuation exact but letter case or spacing differs (prefix
  still exactly `GOVERNMENT WARNING:`) → NEEDS_CORRECTION; anything else → NON_COMPLIANT. A
  title-case prefix is still caught hard (Jenny's case), while all-caps warning bodies — which TTB
  approves in practice (9/10 real approved COLAs in `eval/samples/`) — are flagged for human
  confirmation rather than false-failed (Dave's cry-wolf concern). Full rule in §6.
- **Judgment on fuzzy fields:** trivial brand-name differences (STONE'S THROW vs Stone's Throw)
  are flagged for review, not hard-failed. (Dave.)
- **Robust to imperfect images:** tolerate glare/angles as far as the vision model allows
  (nice-to-have). (Jenny.)

---

## 2. Scope

Scope is split into **MVP** (must ship, rock-solid), **stretch goals** (attempted after the MVP is
solid; individually cuttable without harming the core), and **out of scope** (documented, not built).

**MVP:**

- Single-label verification (form + image → per-field verdicts + overall APPROVED/NEEDS_CORRECTION/REJECTED)
- Batch verification (CSV + images, streamed results, CSV export)
- Tiered field extraction (mock / local OCR / cloud LLM) that **works with no API key by default**
- **Beverage type selector** (distilled spirits / wine / malt beverage) driving **field requiredness
  only** — e.g. alcohol content is mandatory for spirits and wine > 14% ABV, but optional for wine
  ≤ 14% designated "table"/"light" wine and for malt beverages (see §6 for rules + sources). No
  deeper per-type rule coverage.
- Deterministic matching layer; clear results UI; per-item error handling
- Evaluation harness with planted violations
- CI pipeline (GitHub Actions: lint, typecheck, tests, build, Playwright smoke, eval — fully keyless)
- Deployment to a public URL

**Stretch goals (in priority order):**

1. **Same field of vision check** (cloud tier, advisory NEEDS_CORRECTION-only — designed in §6)
2. **"Try an example" sample gallery** — one click loads a bundled sample label + prefilled
   application data (runs on the mock tier). Cheap, and the best possible first-30-seconds for a
   reviewer or a new agent.
3. Per-tier eval comparison reporting (`--provider` flag)
4. **Health-warning diff view** — character-level highlight of exactly where the extracted statement
   deviates from the canonical text (the `reason` string already knows; this renders it visually)
5. **Multi-image per label** (front + back panels) — real COLAs often place the health warning on the
   back label; accept 1–3 images per application and merge extractions (field-of-vision check stays
   per-image, per 27 CFR 5.63)
6. Zip upload for batch images
7. **Bounding-box overlay** — render the extraction boxes on the label image in the results view
   (boxes already exist for the field-of-vision check; this just draws them)
8. **Verdict feedback capture** — a "flag this verdict" button that exports the case (application
   data + extracted values + verdict) as JSON for the `tune-matching` loop; in-memory/download only,
   nothing persisted server-side
9. **Themed UI** (dark mode / theme switcher) — MVP ships a single high-contrast light theme
10. Image-quality warnings (glare/angle detection hints)
11. Per-verification telemetry footer (tier used + processing ms — feeds the < 5 s story)

**Out of scope (documented as such):** COLAs Online integration, authentication/user accounts, persisting
labels or PII, full TTB rule coverage across every beverage class (standards of identity, qualifying
phrases, etc.), image preprocessing (deskew/glare removal).

**Note:** on-prem/air-gapped operation is _partially in scope_ — the local-OCR tier (below) runs
with no cloud call or API key, which is the honest answer to Marcus's firewall concern.

---

## 3. Technical Choices

| Decision          | Choice                                                                           | Rationale                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Stack             | **Next.js (TypeScript) + Tailwind CSS**                                          | One language, one deploy target, high UX ceiling.                                                                                    |
| Deploy            | **Vercel** (free tier), public URL                                               | Required deliverable; `git push` → URL. API key server-side only.                                                                    |
| AI                | **Tiered extraction behind one `VisionProvider` interface** (keyless by default) | Every tier returns the same `ExtractedLabel` shape, so matching/UI/eval never change. See tiers below.                               |
| Extraction output | **Strict JSON schema**, validated server-side                                    | No regex-scraping free text; schema forces `present: false` instead of hallucinated values. Applies to every tier.                   |
| Matching          | **Deterministic code**, not the model                                            | The extractor returns _what it sees_; code decides pass/fail. Critical for the exact health-warning check, and provider-independent. |

The full pinned stack (styling, forms, state, testing, package manager, env vars, project skills,
threat model) lives in **`docs/ARCHITECTURE.md`** — canonical for implementation detail. This table
records only the load-bearing choices.

**Provider tiers (all implement `VisionProvider`, all return `ExtractedLabel`):**

1. **Mock** — canned extraction results for the bundled sample labels, keyed by filename. Zero config,
   works offline. Guarantees the deployed demo _always_ functions even if a key expires, rate-limits,
   or the network blocks the cloud call.
2. **Local OCR (Tesseract.js)** — real extraction on _any_ uploaded image, no cloud call, no API key.
   Runs air-gapped — the honest answer to Marcus's firewall concern. OCR yields raw text, so this tier
   adds a **heuristic text→fields parser** to populate `ExtractedLabel`. Lower accuracy on stylized
   labels and no fuzzy "judgment"; confidence is reported accordingly. Runs server-side by default;
   an early latency spike decides whether it moves in-browser (tesseract.js is isomorphic) — see
   `docs/ARCHITECTURE.md` §Risks & Mitigations.
3. **Cloud vision LLM** — Gemini Flash (free key) / Claude / OpenAI, selected by env var. Best accuracy
   and the only tier that does light reasoning/judgment. Enabled when an API key is present.

**Selection logic:** recognized bundled sample filenames always use **mock** — even when a cloud key
is configured — so the demo stays deterministic. For other uploads: key present → the configured
**cloud** provider; no key → **local OCR**. An env var can force a specific tier. The key, when used,
is server-side only and never shipped to the browser.

**Key principle — task split:** the extractor never returns a pass/fail decision. It returns extracted
values + presence + confidence. All verdicts are computed by deterministic matching rules. This keeps
the strict checks trustworthy, makes behavior testable, and keeps every provider tier interchangeable.

---

## 4. Architecture

```
                 ┌─────────────────────────── Next.js app (Vercel) ───────────────────────────┐
 Browser (agent) │                                                                             │
   │             │   React UI                    API routes (server)                           │
   │  form data  │   - single-label screen  ──►  /api/verify        ──► VisionProvider.extract  │
   │  + image(s) │   - batch screen ──► /api/verify ×N (client fan-out, ≤5 concurrent)          │
   │             │                                     │                                        │
   │  verdicts   │◄─────────────────────────── Matcher (deterministic per-field rules)         │
   │             │                                     │                                        │
   └─────────────┘   VisionProvider tiers: mock | local-ocr | cloud(gemini|claude|openai)          │
                 └─────────────────────────────────────────────────────────────────────────────┘
```

**Modules (each independently testable):**

- `lib/vision/` — `VisionProvider` interface + the tier adapters (`mock`, `local-ocr`, `cloud/*`) +
  a selector that picks a tier from env/key state. Input: image bytes (+ filename for mock lookup).
  Output: validated `ExtractedLabel`. The cloud adapters own the extraction prompt + schema
  enforcement + one retry on invalid JSON; the local-OCR adapter owns Tesseract + the text→fields
  parser; all three converge on the same validated shape.
- `lib/matching/` — pure functions, no I/O. Input: `ExtractedLabel` + `ApplicationData`.
  Output: `VerificationResult`. One function per field rule + an aggregator for overall verdict.
- `lib/ttb/` — canonical constants: the exact health warning statement text, unit normalizers,
  proof↔ABV conversion, per-beverage-type required-fields map.
- `app/api/verify` — thin HTTP handler wiring vision → matching. Batch fans out client-side: one
  short request per label (keeps every serverless invocation within platform limits).
- `app/(ui)` — single-label and batch screens + shared verdict components.
- `eval/` — test images, expected ground truth, and the accuracy runner.
- `e2e/` — thin Playwright smoke specs mirroring user workflows 1–2 (run against the mock tier).

---

## 5. Data Model

```ts
// Which TTB commodity the application is for. Drives field REQUIREDNESS only
// (e.g. alcohol content: mandatory for spirits and wine >14% ABV; optional for
// "table"/"light" wine ≤14% and malt beverages) — not deeper per-type rules.
type BeverageType = "distilled-spirits" | "wine" | "malt-beverage";

// What the agent submits from the application (ground truth to compare against)
interface ApplicationData {
  beverageType: BeverageType;
  brandName: string;
  classType: string; // e.g. "Kentucky Straight Bourbon Whiskey"
  alcoholContent?: string; // e.g. "45% Alc./Vol. (90 Proof)" — optionality per beverageType
  netContents: string; // e.g. "750 mL"
  nameAndAddress?: string; // name/address of bottler/producer
  countryOfOrigin?: string; // for imports
}

// Normalized bounding box (0..1 of image w/h). Populated by tiers that can
// report position (cloud LLM; mock via canned data). null when unavailable.
interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// One extracted field from the label image
interface ExtractedField {
  value: string | null; // null when not present
  present: boolean;
  confidence: number; // 0..1, model-reported
  boundingBox?: BoundingBox | null; // best-effort position; used by the field-of-vision check
}

// What the vision provider returns (validated against schema)
interface ExtractedLabel {
  brandName: ExtractedField;
  classType: ExtractedField;
  alcoholContent: ExtractedField;
  netContents: ExtractedField;
  nameAndAddress: ExtractedField;
  countryOfOrigin: ExtractedField;
  healthWarningStatement: ExtractedField; // verbatim, case preserved; text begins "GOVERNMENT WARNING:"
}

type Verdict = "COMPLIANT" | "NON_COMPLIANT" | "NEEDS_CORRECTION";

interface FieldResult {
  field: string;
  applicationValue: string | null;
  labelValue: string | null;
  verdict: Verdict;
  reason: string; // plain-English, agent-facing
}

interface VerificationResult {
  // REJECTED iff any field is NON_COMPLIANT; else NEEDS_CORRECTION iff any field needs
  // correction; else APPROVED.
  overall: "APPROVED" | "NEEDS_CORRECTION" | "REJECTED";
  fields: FieldResult[];
  warnings: string[]; // e.g. "bold formatting cannot be verified from text"
  processingMs: number;
}
```

---

## 6. Matching Rules

| Field                                                          | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **healthWarningStatement** (text begins `GOVERNMENT WARNING:`) | Compare extracted verbatim text to canonical TTB text, **case-sensitive**, exact after collapsing whitespace runs. Verify the `GOVERNMENT WARNING:` prefix is present and ALL CAPS; both mandatory sentences appear word-for-word. Per TTB the statement **"must appear exactly as it appears in the TTB regulations"** ([TTB label tool](https://www.ttb.gov/regulated-commodities/beverage-alcohol/beer/labeling/anatomy-of-a-malt-beverage-label-tool); [27 CFR 16.21](https://www.ecfr.gov/current/title-27/chapter-I/subchapter-A/part-16/subpart-C/section-16.21)). | Exact (after whitespace-collapse) → COMPLIANT. Wording and punctuation exact but **letter case and/or spacing** differ (prefix still exactly `GOVERNMENT WARNING:`) → **NEEDS_CORRECTION** ("confirm styling"). Any wording/punctuation deviation, or a non-ALL-CAPS prefix → NON_COMPLIANT, with the specific diff in `reason` (e.g. "'Government Warning' must be ALL CAPS", "sentence 2 wording altered"). **Bold rule** (only the words "GOVERNMENT WARNING" must be bold; the remainder must _not_ be) cannot be verified from extracted text → recorded in `warnings`. |
| **brandName**                                                  | Normalize case/whitespace/punctuation (apostrophes, possessives), then compare. Levenshtein distance for near-misses.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Raw-exact → COMPLIANT. Normalized-equal (case/punctuation-only difference, e.g. STONE'S THROW vs Stone's Throw) → **NEEDS_CORRECTION** ("same name — confirm styling"). Small distance → NEEDS_CORRECTION. Large → NON_COMPLIANT.                                                                                                                                                                                                                                                                                                                                            |
| **alcoholContent**                                             | Parse to numeric ABV; reconcile proof (proof = 2 × ABV). Compare with small tolerance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Equal → COMPLIANT; else NON_COMPLIANT.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **netContents**                                                | Normalize units/spacing ("750 mL" == "750ML").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | COMPLIANT / NON_COMPLIANT.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **classType**                                                  | Normalized fuzzy compare.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | COMPLIANT / NEEDS_CORRECTION / NON_COMPLIANT.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **nameAndAddress, countryOfOrigin**                            | Extracted and displayed; normalized fuzzy compare when application value present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | COMPLIANT / NEEDS_CORRECTION / NON_COMPLIANT (skipped if not provided).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Why warning case/spacing-only deviations are NEEDS_CORRECTION, not NON_COMPLIANT (documented discrepancy):**
the § 16.21 statement as printed in the CFR has a sentence-case body, and
[27 CFR 16.22(a)(2)](https://www.ecfr.gov/current/title-27/chapter-I/subchapter-A/part-16/subpart-C/section-16.22)
mandates capitals only for the words "GOVERNMENT WARNING". In practice TTB approves all-caps
bodies: **9 of the 10 real approved COLAs in `eval/samples/` print the body in ALL CAPS** (see
`eval/samples/SOURCES.md`; one also prints `WARNING:(1)` with no space after the colon). Hard-failing
case would therefore flag ~90% of real approved labels. A case/spacing-only difference goes to a
human as NEEDS_CORRECTION — mirroring the brand-name case-only rule — while wording, punctuation, and the
ALL-CAPS `GOVERNMENT WARNING:` prefix remain strict NON_COMPLIANTs (Jenny's title-case rejection stays
a NON_COMPLIANT). This is consistent with the brief: exactness there is "word-for-word" plus the _prefix_
in caps and bold; body case is never specified.

**Presence/confidence overrides:** if a field is `present: false` on the label, or confidence is
below a threshold, verdict is NEEDS_CORRECTION with a reason noting it needs a human — never a silent APPROVED.

**Requiredness by beverage type:** a per-type required-fields map decides how a field _absent from
both the application and the label_ is treated (absence → no verdict issue, noted informationally).
Alcohol content: **required** for distilled spirits and for wine > 14% ABV; **optional** for wine
≤ 14% ABV _only when_ the class/type designation is "table wine"/"light wine"
([27 CFR 4.36](https://www.ecfr.gov/current/title-27/chapter-I/subchapter-A/part-4/subpart-D/section-4.36));
optional for malt beverages ([27 CFR Part 7](https://www.ecfr.gov/current/title-27/chapter-I/subchapter-A/part-7);
background in [TTB's Alcohol Facts rulemaking](https://www.federalregister.gov/documents/2025/01/17/2025-00957/alcohol-facts-statements-in-the-labeling-of-wines-distilled-spirits-and-malt-beverages)).
When the application _does_ state a value, it is always matched regardless of type. The health
warning statement is required for every type (≥ 0.5% ABV).

**Cross-field check — same field of vision (stretch goal; best-effort):** TTB requires the brand name, alcohol
content, and class/type designation to appear in the **same field of vision**, defined in
[27 CFR 5.63](https://www.ecfr.gov/current/title-27/chapter-I/subchapter-A/part-5/subpart-E/section-5.63)
as a single side of a container (for a cylindrical container, 40% of the circumference) where the
information can be viewed **simultaneously without turning the container** (see also
[TTB DS mandatory label info](https://www.ttb.gov/regulated-commodities/beverage-alcohol/distilled-spirits/ds-labeling-home/ds-brand-label)).
Because this is a _spatial_ check, it runs only when bounding boxes are available (cloud tier; mock via
canned boxes). Heuristic: one uploaded image ≈ one side of the container, so the three fields' boxes
must all be present in that image and fall within a single contiguous band (not split across clearly
separate panels). Verdict is **COMPLIANT**
(co-located) or **NEEDS_CORRECTION** (separated, or position undeterminable) — **never NON_COMPLIANT**, so it can
**never cause an overall REJECTED**. This is deliberately advisory: a false "not in field of vision" would
erode agent trust (Dave's concern), so it flags for human eyes rather than rejecting. When boxes are
unavailable (local-OCR/no-position tiers), the check is skipped with a note in `warnings`.

**Canonical health warning statement text (TTB):**

> GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic
> beverages during pregnancy because of the risk of birth defects. (2) Consumption of alcoholic
> beverages impairs your ability to drive a car or operate machinery, and may cause health problems.

---

## 7. Batch Mode

- **Input:** a CSV of application records (one row per label, with `image_filename` and
  `beverage_type` columns) plus the corresponding images (multi-file select; zip upload is stretch
  goal #3). Images matched to rows by filename.
- **Processing:** the client fans out one short request per label to `/api/verify` with bounded
  concurrency (~5 in flight), so a slow or failed label never blocks others and each serverless
  invocation stays within platform limits. Results stream into a sortable table: filename, overall
  verdict, issue count.
- **Per row:** "view details" opens the same verdict card as single mode.
- **Export:** download all results as CSV.
- **Mismatched rows** (CSV row without a matching image, or vice versa) are skipped and reported,
  not fatal.
- **Platform-limit note:** Vercel free-tier serverless functions have a ~10s execution cap. This is
  _why_ batch is chunked/streamed rather than one long request — each invocation stays short and
  within limits. Single-label is comfortably under the cap (target < 5s).

---

## 8. UX

- Single screen, two zones: **left** = application fields form (beverage type selector first — it
  sets which fields are required) + large drag-and-drop image upload; **right** = results. A tab or
  toggle switches to batch mode. Batch CSV includes a `beverage_type` column.
- Result = one unmistakable verdict: large green **APPROVED** / amber **NEEDS CORRECTION** / red
  **REJECTED** banner (three states, not two — a field needing correction is never silently folded
  into a pass), then a field-by-field list with ✓ / ✕ / ⚠ per row and a plain-English reason.
- Big touch targets, high contrast, large readable type. Keyboard accessible; screen-reader labels.
- Clear loading/progress state so the sub-5s wait feels fast, not stuck.

**User workflows** (the tool informs the agent's decision — it never auto-approves/rejects; that
judgment stays human, per Dave):

_Workflow 1 — verify one label (the 90% case):_

1. Open the app — no login, lands directly on the verify screen.
2. Pick beverage type → the form shows exactly the fields required for that type.
3. Enter the application values; drag the label image onto the upload zone.
4. Click **Verify** (one primary button).
5. Within ~5 s: APPROVED/NEEDS CORRECTION/REJECTED banner + per-field rows. Extracted value is
   shown **beside** the application value so a flagged row can be eyeballed instantly.
6. Agent acts: APPROVED → proceed as usual · NEEDS_CORRECTION → check the flagged field(s), decide ·
   REJECTED → reject/request correction, quoting the plain-English reason.

_Workflow 2 — batch (peak season):_

1. Switch to the Batch tab; download the CSV template (one click).
2. Drop the filled CSV + select the label images.
3. Rows stream in as each finishes; sort by verdict to triage REJECTED/NEEDS_CORRECTION first.
4. Click any row for its full verdict card; export the results CSV when done.

_Workflow 3 — recovery:_ unreadable/corrupt image → clear per-item error and the agent swaps in a
better image (mirrors today's practice of requesting a better photo, per Jenny); a CSV row without a
matching image is reported and skipped while the rest of the batch continues.

**Zero-training bar:** first verdict in ≤ 4 interactions from page load, every action visible on
screen (no nested menus), and the Playwright smoke specs mirror workflows 1–2, so the critical
user journeys are executable checks.

---

## 9. Error Handling

Per-item, never fail the whole batch:

- Invalid/corrupt/unsupported image → clear message, skip.
- Model returns malformed JSON → schema-validate, one retry, then surface a friendly error.
- API timeout / rate limit → clear message, no hang.
- Missing required application field → inline form validation before submit.
- Batch CSV↔image filename mismatch → skip row, list it in results.
- Oversized upload → guard with a friendly size/type limit message.

---

## 10. Evaluation Harness

- `eval/` contains ~8–12 test labels and `expected.json` with ground-truth application data +
  expected per-field verdicts, **including planted violations**: title-case warning, wrong ABV,
  mismatched brand, missing net contents. Samples are **synthetic renders generated from the mock
  fixtures** — a single source of truth with fully controlled ground truth; real approved labels from
  [TTB's public COLA Registry](https://www.ttb.gov/regulated-commodities/labeling/cola-public-registry)
  can be added over time via the `add-test-label` skill (they exercise the local-OCR/cloud tiers only).
- `pnpm eval` runs extraction + matching across the set and prints **per-field accuracy, overall
  accuracy, and whether each planted violation was caught**, for the currently selected tier.
- **Stretch (goal #2):** a `--provider` flag to score the **same set per tier** (mock / local-ocr /
  cloud) in one report, quantifying the OCR-vs-cloud gap.
- Purpose: demonstrate measured correctness, catch regressions, and make the tier trade-offs concrete.

---

## 11. Documented Assumptions & Limitations (for README)

- **Runs without an API key:** the default experience needs no key — local OCR handles real uploads
  and mock mode covers the bundled samples, so a reviewer can test the deployed URL with zero setup.
- **Firewall / on-prem (Marcus):** the local-OCR tier runs air-gapped with no outbound ML call,
  directly addressing TTB's blocked endpoints. The cloud tier (optional key) is where accuracy and
  judgment improve — a production on-prem deployment would lean on a self-hosted model in that slot.
- **Accuracy trade-off across tiers:** local OCR is lower-accuracy on stylized labels and does no
  fuzzy judgment; the cloud tier is the high-fidelity path. The eval harness quantifies the gap.
- **Bold text** on the health warning statement cannot be verified from extracted text (any tier);
  flagged as a limitation.
- **Same field of vision is best-effort:** verified only when positional data is available (cloud
  tier), using a 2D-image heuristic. It can't reason about a 3D container wrapping around, so it's
  advisory (NEEDS_CORRECTION, never REJECTED) and skipped on tiers without bounding boxes.
- **No PII persisted:** images and application data are processed ephemerally; nothing stored.
- **TTB rules simplified** to the common cross-class fields; not a complete regulatory implementation.
- **Cloud tier keys** (Claude/OpenAI/Gemini) are optional; only the tiers you configure are exercised
  end-to-end. Mock + local OCR are always available.
- **Warning case/spacing deviations flag for review, not failure:** TTB approves all-caps warning
  bodies in practice (9 of 10 real approved labels in our eval set), so a warning whose wording and
  punctuation are exact but whose letter case or spacing differs is routed to a human as
  NEEDS_CORRECTION. Altered wording, punctuation changes, or a non-ALL-CAPS `GOVERNMENT WARNING:`
  prefix are still NON_COMPLIANT (see §6).

---

## 12. Testing Strategy

- **Unit:** `lib/matching/` pure functions (each field rule + aggregator) and `lib/ttb/` normalizers
  — including the exact government-warning deviations. This is the highest-value test surface.
- **Adapter:** cloud `VisionProvider` schema validation + malformed-JSON retry (mocked model response);
  local-OCR **text→fields parser** against representative OCR output strings; the **tier selector**
  (env/key state → correct tier).
- **E2E smoke:** thin Playwright suite (2–3 flows: single verify, batch, one error path) against the
  **mock tier** — deterministic and keyless. Layers/mocking detail: `docs/ARCHITECTURE.md` §Testing
  Strategy.
- **Eval:** the `pnpm eval` harness above (integration-level correctness signal); per-tier comparison
  once stretch goal #2 lands.
- **CI:** GitHub Actions runs every keyless layer on each push — lint, typecheck, tests, build,
  Playwright smoke, eval (operational loops TW1–TW6: `docs/ARCHITECTURE.md` §Test Workflows).
- **Manual:** single + batch happy paths and error paths on the deployed URL, with **no key set**
  (default keyless path) and with a cloud key set.
