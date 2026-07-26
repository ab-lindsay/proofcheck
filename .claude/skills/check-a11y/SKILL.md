---
name: check-a11y
description: Use after UI changes — audits app/ and components/ against the "usable by a non-technical 73-year-old" bar (labels, keyboard nav, color-independent verdicts, contrast/target size, plain-English copy).
---

# Check A11y

Audit `/` and `/batch` (running app via `pnpm dev`, or code review of `components/*.tsx`):

1. **Labels:** every input reachable by `getByLabelText` — no placeholder-as-label. Check
   `upload-zone.tsx`, `application-form.tsx`, `dev-mode-toggle.tsx`, `tier-switcher.tsx`, and
   `model-picker.tsx` for inputs missing a `<label htmlFor>` or `aria-label`.
2. **Keyboard:** tab through the whole flow — upload, form, verify, results, batch table. No
   mouse-only actions (`upload-zone.tsx`'s dropzone must expose its file input to keyboard users).
3. **Not color alone:** verdicts must carry icon + text, never color only. `field-row.tsx` and
   `verdict-card.tsx` pair icon + word for COMPLIANT/NON_COMPLIANT/NEEDS_CORRECTION and
   APPROVED/NEEDS_CORRECTION/REJECTED; `batch-table.tsx` rows likewise. Verify any new verdict UI
   does too.
4. **Contrast & target size:** body text ≥ 16px, buttons/targets large enough for an older user on a
   touch screen, banner text high-contrast on the approve/reject backgrounds.
5. **Plain English:** every `reason`/explanation string is readable by a non-technical user — no
   jargon, no raw vocabulary tokens (`NON_COMPLIANT`, `REJECTED`, etc.) leaking into UI copy.
6. **Accessible names stay field-scoped:** any control that repeats per field/row (feedback buttons,
   status badges) needs its own scoped name (e.g. `aria-label="Mark the Brand name explanation as
   helpful"`), not one name shared across every instance — this exact bug shipped once (see
   `docs/review-2026-07-26.md`) and is easy to reintroduce when adding a new per-field control.
7. `eslint-config-next`'s transitive `eslint-plugin-jsx-a11y` rules run in `pnpm lint` and catch some
   of this mechanically — this skill covers what static lint can't: contrast, plain-English copy,
   real tab order, and color-independence as *experienced*, not just markup-present.
8. Report violations with file:line and a concrete fix for each.
