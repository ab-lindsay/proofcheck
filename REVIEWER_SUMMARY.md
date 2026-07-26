# ProofCheck — Reviewer Summary

**Live demo:** https://proofcheck-ttb.vercel.app  
**Repo:** https://github.com/ab-lindsay/proofcheck

## What This Is

AI-assisted TTB alcohol label verification. Upload a label image + application data; ProofCheck extracts the fields and checks them against the application. Every verdict comes from deterministic matching rules — the model never decides pass/fail. This matters most for the health warning statement, which is checked character-for-character against 27 CFR Part 16.

## Try It (30 seconds)

Click any bundled sample in the app (a passing label, a title-case warning violation, or "Bad photo (glare)"). Each pre-fills its application data. Press **Verify label** — the whole pipeline runs, no API key needed.

## Key Technical Decisions

### 1. Keyless by default

Works with zero env vars. Four extraction tiers behind one interface:

- `mock` — canned fixtures for samples (demo always works)
- `local-ocr` — Tesseract.js, runs air-gapped (answers Marcus's firewall constraint)
- `local-llm` — Ollama + Qwen2.5-VL, fully local vision LLM (opt-in)
- `cloud` — Amazon Bedrock (best accuracy when a key is set)

### 2. Extract/judge split (security by design)

The model only extracts what it sees — never a pass/fail verdict. All verdicts come from pure, unit-tested matching functions. The health warning check is a string compare; it cannot be prompt-injected into passing. **Measured:** 5 planted injections, all inert on both local-ocr and Bedrock (eval/history.jsonl, 2026-07-24).

### 3. Built → measured → acted on the results

- **English-only OCR:** Adding 4 extra language packs measured 3.3× worse p95 latency for zero accuracy gain on the real-world eval set → reverted to English-only (p95 now 1464ms, well inside the 5s budget).
- **Escalation ladder OFF by default:** The self-correcting re-read loop measured ~72% more cloud latency and ~55% more model calls for a null accuracy gain → shipped opt-in, not on. A cost with no demonstrated benefit doesn't belong in the default path.
- **Committed measurement history:** Every accuracy/latency claim in the README traces to a line in eval/history.jsonl with its git SHA.

### 4. Real-time batch progress

The live batch page fans out client-side (N concurrent `/api/verify` calls, ≤5 at a time) rather than using the separate `/api/batch` server endpoint. This trades one round-trip for real-time progress updates row-by-row (queued → running → done status per label), which matters for the 200–300 label batches Sarah's interview described — a 2-minute batch with no feedback reads as stuck.

### 5. Verdicts that match TTB's own language

APPROVED / NEEDS CORRECTION / REJECTED at the overall level, COMPLIANT / NON_COMPLIANT / NEEDS_CORRECTION per field — the same three dispositions TTB uses in COLAs Online. NEEDS_CORRECTION flags a human decision without rejecting the label outright; only NON_COMPLIANT causes a rejection.

### 6. Cost/abuse controls: ops-tunable, never client-bypassable

Two related guards, same underlying rule — a request-controlled field may never let its own sender grant themselves more resource budget:

- **Rate limiting** (`lib/rate-limit.ts`): per-IP sliding window on `/api/verify` and `/api/batch`, keyed on `X-Forwarded-For` only when `TRUST_PROXY_HEADERS=1` confirms a real upstream sets it honestly — by default every request shares one global bucket instead, so a forged/rotating header can't mint a fresh quota. The ceiling is an **ops-tunable env var** (`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`), not a toggle exposed to the client — a "raise my own limit" request field would let any visitor lift the shared bucket for everyone else too.
- **Dev-mode overrides** (`devTier`, `devBedrockModel`, `escalate` — tier override, model override, and the escalation ladder opt-in): each multiplies cloud cost or latency, so all three are gated behind `DEV_CONTROLS_ENABLED`, off by default in production. Unset, a request carrying any of them gets a clean 400 instead of being silently honored.
- **`VISION_PROVIDER=mock` is refused outright in production** (`lib/vision/select.ts`), independent of `DEV_CONTROLS_ENABLED`: the mock tier returns fabricated fixture data keyed off the (client-controlled) filename, so forcing it on a production deploy would let any upload named after a bundled fixture come back as a fabricated APPROVED. The bundled sample gallery still works in production — it verifies through a separate, content-hash-gated path (`lib/vision/sample-hashes.ts`), not this env var.

For this review deployment: `RATE_LIMIT_MAX` was raised via env var (not a code change) to comfortably cover an active review session; `DEV_CONTROLS_ENABLED` was deliberately left off, since the dev-mode UI toggles it gates are best explored with someone narrating them, not left for unsupervised discovery.

## Stakeholder Requirements Met

✅ **Sarah's < 5s latency budget:** local-ocr (keyless default) measures p95 1464ms / max 2253ms on real photographed labels — comfortably within the adoption-killer threshold. Gated in CI.

✅ **Sarah's 73-year-old mother bar:** Plain-English copy, 44px touch targets, `role="alert"` error messages, confidence explanations always-visible (not hover-only).

✅ **Jenny's exact warning requirement:** Title-case "Government Warning:" → NON_COMPLIANT/rejected. Wording/punctuation exact but case/spacing differs → NEEDS_CORRECTION. Fully whitespace-collapsed exact → COMPLIANT. Character-for-character, never fuzzy.

✅ **Dave's judgment call:** "STONE'S THROW" vs "Stone's Throw" on brand name → NEEDS_CORRECTION (not rejection). Covered by unit test + eval fixture.

✅ **Marcus's firewall constraint:** local-ocr tier runs air-gapped (no cloud call). local-llm (Ollama) runs fully local too.

✅ **Batch uploads:** CSV template + multi-file select, per-row error handling (one bad label never blocks the batch), results export. Real-time progress updates for large batches.

✅ **Field capture (value-add, not an explicit brief line):** on mobile, "Take a photo" opens the rear camera directly instead of the gallery picker — a plausible real-world path for an agent photographing a label on-site rather than uploading an existing file. Scoped to touch devices via CSS (`pointer: coarse`); hidden on desktop, where the underlying `capture` attribute is ignored by the browser and would otherwise sit next to "Choose a file" doing the exact same thing under a misleading label.

## Known Limitations (Documented)

- **Prototype scope:** standalone, no COLAs Online integration, no auth, ephemeral processing (per the brief).
- **TTB rules simplified** to common cross-class fields; beverage type drives requiredness only (not full standards-of-identity).
- **Bold text unverifiable** from extracted text — flagged as a note on every result.
- **Batch table not virtualized:** renders every row, fine for ~50 but would need windowing (`virtua` or similar) for the 200-300 peak scale.
- **Cloud-tier rate limits** would throttle very large batches without provisioned capacity.

## Evidence Backing the Claims

- **606/606 unit/component tests pass** (as of the most recent CI run pre-concurrent-session)
- **CI gates:** lint, typecheck, tests, build, e2e, eval (mock tier 100%), adversarial injection (local-ocr), latency budget (local-ocr real-world, p95 and max)
- **Eval history:** eval/history.jsonl with git SHAs — best cloud run 41/46 (89%) overall on real-world set, 5/5 planted violations caught
- **Injection red-team:** differential one-directional gate (injected vs clean twin, can only worsen verdicts)
- **Deployed and working:** https://proofcheck-ttb.vercel.app

## What I'd Do Next (If This Weren't a Prototype)

1. **Virtualize the batch table** for 200-300 row scale
2. **Cross-check local-ocr vs cloud** for confidence (deriving it from an independent signal instead of trusting model self-report)
3. **Field-of-vision check** from bounding boxes (advisory, not enforced)
4. **COLAs Online integration**, auth, audit logging, retention policies

## Time Spent

Built with Claude Code (AI-first workflow):

- Spec → plan → TDD implementation → adversarial review cycle
- 14 design specs, 8+ implementation plans in docs/superpowers/
- Project-scoped skills (run-eval, check-latency, security-review, add-test-label, check-a11y, tune-matching, deploy-smoke) close feedback loops
- Built → measured → acted: escalation ladder, language packs, model choice all empirically driven

Total calendar time not tracked (AI-assisted development), but the commit history and docs/ show the process: every feature starts as a spec, becomes a plan, lands as reviewed commits.

---

**Questions?** The README has setup instructions, ARCHITECTURE.md has the invariants, and docs/BRIEF.md is your original take-home.
