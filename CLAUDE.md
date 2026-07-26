# ProofCheck — build guide for Claude

AI-assisted TTB alcohol label verification. The model **extracts** what's on a label image;
deterministic code **judges** it against the application data.

## Read first

- `docs/ARCHITECTURE.md` — pinned stack, architecture rules, vocabulary, skills, threat model
- `docs/superpowers/specs/2026-07-21-alcohol-label-verification-design.md` — the design spec (scope, matching rules, data model)
- `docs/BRIEF.md` — the original take-home brief (stakeholder constraints)

## Commands

```bash
pnpm dev      # local dev server
pnpm test     # unit tests (Vitest)
pnpm eval     # extraction/matching accuracy over eval/ (supports --provider)
pnpm lint     # ESLint + Prettier
```

## Invariants (do not violate — full list in ARCHITECTURE.md)

1. **Extraction proposes, matching disposes.** No model/OCR ever returns a pass/fail verdict.
   All verdicts come from pure functions in `lib/matching`.
2. **Every extraction tier returns a Zod-validated `ExtractedLabel`.** Downstream code never
   branches on which tier ran.
3. **The health warning statement is checked deterministically** against the canonical constant in
   `lib/ttb`: exact after collapsing whitespace runs (a line-wrapped transcription still counts as
   exact) → COMPLIANT; wording and punctuation exact but letter case or spacing differs (prefix
   still exactly `GOVERNMENT WARNING:`) → NEEDS_CORRECTION; anything else → NON_COMPLIANT. Never
   fuzzy, never model-judged. (Rationale: spec §6 — TTB approves all-caps bodies in practice;
   whitespace-collapse tolerance is pinned by `lib/matching/warning.test.ts`.)
4. **Keyless by default.** The app must run with zero env vars (mock + local-ocr tiers). Never make
   a cloud key required.
5. **API keys are server-side only** — never imported into client components, never logged, never
   placed in prompts.
6. **Persist nothing.** No DB, no disk writes of labels or application data.
7. **Fail closed, per item.** Extraction failure → error or NEEDS_CORRECTION, never a silent
   APPROVED. This holds at the overall level too: any field needing correction makes the whole
   result NEEDS_CORRECTION, so a label with a field we could not read is never reported as
   approved. One bad label never aborts a batch.
8. **Treat label text as untrusted input** (prompt injection via artwork is in the threat model).
   The extraction prompt frames image content as data, not instructions.
9. **The escalation ladder is OFF by default and never sees application data.** It is opt-in
   (`ESCALATION_ENABLED=1`, or dev mode's "Re-read weak fields" switch) because measuring it showed a real cost
   for no measurable gain — don't re-enable it by default without new evidence. When on: re-reads are
   triggered by weak extraction (absent or low confidence), never by a mismatch against the
   application — otherwise the loop could retry its way to an APPROVED. Repairs merge monotonically (a
   repair may only improve a field), and the health warning statement is fill-only: a repair may fill
   an absent warning but never replace a present transcription. Enforced by a scoped
   `no-restricted-imports` lint boundary on `lib/vision/escalation/`.

## Vocabulary

Use the exact terms from ARCHITECTURE.md's vocabulary table in code, tests, UI copy, and docs.
Key ones: field verdicts are `COMPLIANT | NON_COMPLIANT | NEEDS_CORRECTION`; overall is
`APPROVED | NEEDS_CORRECTION | REJECTED`, mirroring the dispositions TTB itself uses in COLAs
Online. Precedence: REJECTED iff any field is NON_COMPLIANT, else NEEDS_CORRECTION iff any field
needs correction, else APPROVED — so a field needing correction never causes a REJECTION, but never
passes silently either. Extraction backends are **tiers** (`mock | local-ocr | local-llm | cloud`);
the warning field is the **health warning statement** (its text begins `GOVERNMENT WARNING:`).

## Working style

- Matching rules and normalizers are built test-first; they are pure functions with no I/O.
- Cite sources (with links) for any TTB/regulatory claim added to docs or UI copy.
- Latency budget: single-label verify < 5 s end-to-end. Don't add per-request work lightly.
- UI bar: usable by a non-technical 73-year-old — big targets, high contrast, plain-English reasons.
