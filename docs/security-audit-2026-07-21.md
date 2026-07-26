# ProofCheck — Security Audit (2026-07-21)

**Method:** 7 parallel per-dimension finders (prompt-injection/verdict-integrity, output-handling/XSS,
upload/DoS, secrets & key hygiene, CSV/batch injection, auth/trust-boundary, supply-chain), each
finding independently **adversarially verified** by a second reviewer that traced the real callers and
tried to refute it. `pnpm audit` and key-hygiene greps were run.

**Result:** 20 raw findings → **11 confirmed** (1 HIGH, 10 INFO), **9 false-positives** (rejected), 0 uncertain.

**Status:** **Remediated 2026-07-22 — see §0 below.** (Originally filed as a backlog to action.)
Separately, the earlier bug-sweep produced 11 fixes that **are** committed (`14a64d4`…`1fc3702`), and this
audit **re-verified** the two security-relevant ones as intact:

- Source-spoof mock gate (`isGenuineSample` byte-hash in `route.ts` + `lib/vision/sample-hashes.ts`) — holds.
- CSV `\r` escape (`escapeCsvCell`) — complete for `= + - @` prefix and `" , \n \r` quoting.

---

## 0. Remediation status (2026-07-22)

All actionable findings were applied on 2026-07-22 (test-first for every behavioral change). Verification:
**115 unit tests pass**; `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm audit --prod` are all clean;
and the production CSP was validated in a headless browser — the page hydrates and the full verify flow
runs with **zero CSP violations**. Key rotation (§4) is intentionally excluded from this pass.

| #   | Finding                                     | Status               | Where / note                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1  | Pixel/decompression-bomb DoS                | ✅ Fixed             | `route.ts` header-only pixel bound (≤25 MP; undecodable → 400) before any tier + `local-ocr.ts` downscale to ≤2000 px before OCR; `sharp` promoted to a **runtime** dep, pinned ≥0.35.0                                                                                                                    |
| §2  | No CSP / security headers                   | ✅ Fixed             | `lib/security-headers.ts` + `next.config.ts` `headers()` — CSP, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` (script/style `'unsafe-inline'` accepted; no HTML sink — nonce-based is the future step)                                                                                    |
| §2  | `VISION_PROVIDER=mock` bypass               | ✅ Fixed             | `select.ts` rejects `mock` when `NODE_ENV=production`; route selects the provider **inside** the try so the throw fails closed to a generic 502. (Chose this over a byte-check in `mockProvider.extract`, which would break the eval harness's legitimate by-filename fixture use.)                        |
| §2  | Model confidence trusted                    | ✅ Locked + accepted | `verify.ts` — invariant documented and test-locked: confidence is strictly one-directional (only downgrades MATCH→REVIEW) and can never manufacture a PASS. Independent cross-check (cloud vs local-ocr) deferred — it blows the <5 s latency budget and would make matching tier-aware (violates rule 2). |
| §2  | Whole body buffered before size check       | ✅ Fixed             | `route.ts` `Content-Length` precheck → 413 before `formData()`                                                                                                                                                                                                                                             |
| §2  | Health-warning injection residual           | ⚪ Accepted          | documented LLM01 residual; extraction prompt clause unchanged                                                                                                                                                                                                                                              |
| §3  | `shadcn` in prod deps (drags hono advisory) | ✅ Fixed             | moved to `devDependencies` — clears the MODERATE `@hono/node-server` path from the prod tree                                                                                                                                                                                                               |
| §3  | `sharp` HIGH advisory                       | ✅ Fixed             | `pnpm.overrides` `sharp: ">=0.35.0"`                                                                                                                                                                                                                                                                       |
| §3  | `postcss` MODERATE advisory                 | ✅ Fixed             | `pnpm.overrides` `postcss: ">=8.5.10"`                                                                                                                                                                                                                                                                     |
| §3  | CI actions on mutable tags                  | ✅ Fixed             | SHA-pinned (`checkout` v4.4.0, `pnpm/action-setup` v4.3.0, `setup-node` v4.4.0) + `.github/dependabot.yml` for `github-actions`                                                                                                                                                                            |
| §3  | `@playwright/mcp@latest`                    | ✅ Fixed             | pinned to `0.0.78` in `.mcp.json`                                                                                                                                                                                                                                                                          |
| §4  | `.env.local` Gemini key                     | N/A                  | moot as of 2026-07-26 — the Gemini adapter was removed from `lib/vision/`; the key was free-tier and never committed, so no rotation is needed                                                                                                                                                             |
| §5  | `escapeCsvCell` omits leading TAB           | ✅ Fixed             | `csv.ts` formula-trigger set now includes `\t`                                                                                                                                                                                                                                                             |
| §5  | `overall` unescaped in `toResultsCsv`       | ✅ Fixed             | `csv.ts` wraps it in `escapeCsvCell`                                                                                                                                                                                                                                                                       |
| §5  | `in` matches inherited keys                 | ✅ Fixed             | `mock.ts` uses `Object.hasOwn` (lookup + `isMockSample`)                                                                                                                                                                                                                                                   |
| §5  | `withTimeout` leaks the deadline timer      | ✅ Fixed             | `route.ts` `clearTimeout` in `finally`                                                                                                                                                                                                                                                                     |
| §5  | `parseApplicationsCsv` no row cap           | ⏭ Deferred           | client-side UX robustness only — not a security issue                                                                                                                                                                                                                                                      |

**Residual `pnpm audit` (non-`--prod`):** 1 MODERATE — `@hono/node-server` reachable only via the `shadcn`
**devDependency** (a scaffolding CLI that is never bundled or booted). Accepted; clears if `shadcn` is
dropped or updated.

---

## 1. Action required

### 🔴 HIGH — Pixel/decompression-bomb DoS on the keyless OCR tier

- **Where:** `app/api/verify/route.ts:55` (validation) → `lib/vision/local-ocr.ts:24` (`worker.recognize`).
- **What:** Upload validation bounds only the **compressed** byte size (≤8 MB) and the magic-byte header.
  Nothing bounds the **decoded** raster (width × height × channels). A genuine ~1–4 MB uniform-color PNG
  declaring huge dimensions passes every check and is handed straight to tesseract.js — the keyless
  **default** tier.
- **Exploit:** One unauthenticated POST of an image whose raster sits above the container's RAM (e.g.
  ~20000×20000 RGBA ≈ 1.5 GB) trips the OS OOM-killer on a default 1 GB Vercel instance → 503 for every
  co-located in-flight request; repeatable for sustained outage. The 8 s `withTimeout` does **not** help
  (OOM happens during allocation, and `Promise.race` never cancels the work). Short of OOM it pegs CPU
  and stalls the single shared tesseract worker for all local-ocr requests on that instance.
- **Fix:** Bound decoded pixels **before** any tier. Promote `sharp` to a runtime dependency and, in the
  route, `await sharp(buffer, { limitInputPixels: 25_000_000 }).metadata()` (throws on over-budget) and/or
  downscale `sharp(buffer).resize(2000, 2000, { fit: "inside", withoutEnlargement: true })` before OCR;
  reject > ~25 MP with a 400. Optionally give the timeout teeth (terminate/replace the worker on deadline).
  Note: the vulnerable `sharp@0.34.5` under Next (see §3) is a _separate_ copy from the dev `sharp@0.35.3`;
  promoting sharp to runtime should pin `>=0.35.0`.

---

## 2. App hardening (INFO — not directly exploitable today)

### No Content-Security-Policy / security headers

- **Where:** `next.config.ts` (no `headers()`), no middleware, no `vercel.json`.
- **What:** App ships no CSP, `X-Content-Type-Options`, `Referrer-Policy`, or `X-Frame-Options`. No XSS
  sink exists today — all untrusted extracted text renders as auto-escaped React text nodes; the only
  `<img src>` is a hardcoded `/samples/*` path or a `blob:` URL of the user's own file. This caps the
  blast radius of any _future_ raw-HTML/URL sink and prevents clickjacking of the verify flow.
- **Fix:** Add `async headers()` returning `Content-Security-Policy: default-src 'self'; object-src 'none';
base-uri 'none'; frame-ancestors 'none'; img-src 'self' blob: data:`, plus `X-Content-Type-Options:
nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.

### `VISION_PROVIDER=mock` bypasses the sample byte-hash gate

- **Where:** `lib/vision/select.ts:37` (checks `VISION_PROVIDER` first) → `lib/vision/mock.ts:107` (keys the
  fixture off the raw client filename `image.name`, ignores bytes).
- **What:** Not client-reachable in the default deploy (env is server-side and unset → uploads use
  local-ocr). But if an operator sets `VISION_PROVIDER=mock` in a public env (it's live in CI and
  `playwright.config.ts`), any upload named after a fixture (e.g. `old-tom-clean.png`) returns fabricated
  fixture data → a PASS for an image it doesn't show, re-opening the class the SHA-256 gate closed.
- **Fix:** Make `mockProvider.extract` verify bytes via `isGenuineSample(meta.filename, image)` and throw
  otherwise (so mock only ever returns a fixture for genuine sample bytes), and/or reject
  `VISION_PROVIDER=mock` when `NODE_ENV === "production"`.

### Model-reported confidence trusted for the MATCH→REVIEW downgrade

- **Where:** `lib/matching/verify.ts:17` (`withConfidence`).
- **What:** For cloud tiers, `confidence` is model-produced and attacker-influenceable via the same
  artwork channel. It only ever moves toward the safer verdict (REVIEW), so it cannot manufacture a false
  PASS — but an injected model can report `confidence: 1.0` to suppress the "verify by eye" hint,
  amplifying the health-warning residual below.
- **Fix:** Treat cloud confidence as untrusted — use it only to _add_ REVIEW, never as a safety signal;
  or derive it from something the label text can't control (OCR agreement, bbox presence).

### Whole multipart body buffered before the size check

- **Where:** `app/api/verify/route.ts:42` (`await req.formData()` before the `image.size` check at :55).
- **What:** Bounded in practice on Vercel (~4.5 MB platform request cap fires first), so it's a hardening
  note there; off-Vercel / self-hosted (`pnpm dev`) there's no cap and a large body is fully buffered.
- **Fix:** Pre-check `Number(req.headers.get("content-length")) > MAX_BYTES` and reject before `formData()`.

### Accepted residual — health-warning is the one injection-targetable verdict

- **Where:** `lib/matching/warning.ts:18` + the cloud extraction path.
- **What:** The correct warning value is a public constant, so a prompt-injected cloud model _can_ emit it
  on demand to hide a defective/absent printed warning (all other fields are safe — the model never sees
  the application data). This is the documented LLM01 residual; the only barrier is the `EXTRACTION_PROMPT`
  security clause. Not a code defect.
- **Optional hardening:** cross-check the cloud transcription against the local-ocr transcription and
  downgrade to REVIEW on disagreement; restate the anti-injection clause _after_ the image.

---

## 3. Dependency & CI hygiene (INFO)

These are mostly `pnpm audit` advisories that are **not reachable** in the current app but keep the audit
noisy and are one refactor away from mattering. Cheap to clear.

- **`shadcn` in production `dependencies`** (`package.json:39`) — it's a dev-only scaffolding CLI; move it
  to `devDependencies`. It drags `@modelcontextprotocol/sdk` + a **MODERATE** `@hono/node-server`
  path-traversal advisory (GHSA-frvp-7c67-39w9) into the prod tree (unreachable — that server never boots).
- **`sharp@0.34.5` via Next** (transitive `optionalDependency` of `next@16.2.11`) — a **HIGH** libvips
  advisory (GHSA-f88m-g3jw-g9cj). Unreachable today (no `next/image`, no `images.remotePatterns`; uploads
  never hit sharp). Clear + de-risk with `"pnpm": { "overrides": { "sharp": ">=0.35.0" } }`. (Also resolves
  the sharp version concern from the §1 fix.)
- **`postcss@8.4.31` via Next** — a **MODERATE** stringify-XSS advisory (GHSA-qx2v-qp2m-jg93). Build-time
  only, authored CSS, unreachable. Optional override `"postcss": ">=8.5.10"` or clears on next Next bump.
- **CI actions on mutable tags** (`.github/workflows/ci.yml:13-15`) — `actions/checkout@v4`,
  `pnpm/action-setup@v4`, `actions/setup-node@v4`. Secret-free workflow so blast radius is small; SHA-pin
  each + enable Dependabot for `github-actions`.
- **`.mcp.json` uses `@playwright/mcp@latest`** — dev-tooling only, not deployed. Pin to an exact version
  for reproducibility.

## 4. Local hygiene (INFO)

- ~~`.env.local` holds a live-looking `GEMINI_API_KEY`~~ — **N/A as of 2026-07-26.** The Gemini adapter
  was removed from `lib/vision/`; Bedrock is the only cloud tier now. The key was gitignored, never
  committed, and free-tier, so there was never any exposure or cost risk — no rotation needed.

---

## 5. Not reproducible (false-positives — rejected, no action needed)

Each was traced and refuted; a few carry an _optional_ defense-in-depth note.

| Finding                                                         | Why rejected                                                                                                    | Optional                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Second-order prompt injection via `reason`/`labelValue` strings | "agent" = human reviewer; no LLM ingests `VerificationResult`; UI/CSV sinks are escaped                         | —                                                     |
| `withTimeout` doesn't cancel OCR → work piles up                | Single **serialized** tesseract worker (not concurrent); the reachable part is the _documented_ rate-limit TODO | Cancel worker on timeout; `clearTimeout` in `finally` |
| `in` operator matches inherited keys (`mock.ts:101`)            | Byte-hash gate + Zod both fail-safe on inherited keys; unreachable                                              | Use `Object.hasOwn`                                   |
| `escapeCsvCell` omits leading TAB                               | Filenames are `.trim()`'d upstream; no cell reaches it starting with `\t`; harmless in Excel/Sheets             | Add `\t` to the formula-trigger set                   |
| `result.overall` unescaped in `toResultsCsv`                    | It's a `"PASS"                                                                                                  | "FAIL"` server-produced enum — can't carry a metachar | Wrap in `escapeCsvCell` for uniformity |
| `parseApplicationsCsv` has no row cap                           | Client-side only, on a file the same user chose; no server/cross-user impact                                    | Cap rows for UX robustness                            |

(The `sharp`/`postcss`/`@playwright/mcp@latest` items also surfaced here as "advisory present but unreachable" — captured in §3 as the actionable hygiene form.)

---

## 6. Suggested order for tomorrow

1. **The HIGH** — pixel-bomb DoS (§1). The only genuinely exploitable issue.
2. **Cheap dependency clears** (§3) — `shadcn` → devDeps + `sharp`/`postcss` pnpm overrides; re-run
   `pnpm audit --prod` to confirm it's clean. (Pairs with the §1 sharp promotion.)
3. **Security headers** (§2 CSP) and the **`VISION_PROVIDER=mock` byte-check** (§2).
4. ~~Rotate the `.env.local` Gemini key~~ (§4) — N/A, Gemini adapter since removed.
5. Remaining INFO / optional defense-in-depth as time allows.
