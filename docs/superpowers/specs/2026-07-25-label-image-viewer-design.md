# Design Spec: Label Image Viewer

**Date:** 2026-07-25
**Status:** Approved
**Scope:** A zoomable in-app viewer for the label image, surfaced from the verdict card.

---

## Summary

`verify.ts` already tells the user _"Bold formatting of GOVERNMENT WARNING cannot be verified from extracted text — check visually"_ — but there is currently no way to do that check inside the app. The only image preview anywhere is a static, unzoomable ~256px thumbnail in the upload step (`upload-zone.tsx`), and it isn't shown at all in batch mode. This adds a small clickable thumbnail + zoom modal to `VerdictCard`, so a reviewer can inspect the actual label pixels (bolding, or any other field they want to eyeball against the photo) without leaving the result.

General-purpose, not warning-specific: one viewer entry point per card, useful for double-checking any field — a NON_COMPLIANT verdict that might be an OCR error, a low-confidence read, or the health-warning bold requirement.

Ships for both single-label verify and batch review: batch's "view details" already mounts the same `VerdictCard` component (`batch-table.tsx`), so it comes along once `VerdictCard` accepts an image.

Out of scope for this pass: highlighting/jumping to a field's specific bounding-box region. `FieldResult` doesn't currently carry `boundingBox` to the client (only the internal `ExtractedField` does, server-side), and bounding boxes only exist on the cloud/mock tiers — local-ocr and local-llm would fall back to a full-image view anyway. Plain pan/zoom on the full image covers the stated need without that extra API surface change.

---

## Architecture Decision

**Approach:** Native `<dialog>` modal + hand-rolled CSS-transform zoom/pan, no new dependency.

This repo already has a precedent for a native `<dialog>`-based modal (`components/dev-mode-confirm.tsx` — `showModal()`, built-in focus trap, Escape-to-cancel, `::backdrop`), so the viewer follows the same pattern rather than introducing a new one. The interaction itself (+/− buttons, scroll-wheel zoom, click-drag pan on one static image) is bounded enough to hand-roll without a library.

**Why not a zoom/pan library** (e.g. `react-zoom-pan-pinch`): would likely deliver marginally more polished gesture handling (momentum panning, more robust mobile pinch-to-zoom) for less code, but adds a new runtime dependency to a codebase that is deliberately minimal and pinned (`CLAUDE.md`: "pinned stack"). Not worth it for an interaction this narrow.

**Why not open the image in a new tab:** zero UI code, but exits the single-screen workflow the product is built around (design spec §8), and object-URL revocation gets awkward once a blob URL can outlive the component that created it (a new tab can stay open after the card unmounts).

---

## Section 1: `useObjectUrl` hook

### New file: `hooks/use-preview-url.ts`

```typescript
function useObjectUrl(file: File | null): string | null;
```

Creates a blob URL (`URL.createObjectURL`) when `file` changes, revokes the previous one on change/unmount. This is the same lifecycle already inlined in `upload-zone.tsx` (its `objectUrl` state + cleanup `useEffect`); extracting it removes the duplication the new viewer would otherwise introduce.

`upload-zone.tsx` is refactored to call this hook instead of managing the state/effect itself: `const objectUrl = useObjectUrl(file); const preview = previewSrc ?? objectUrl;`. Behavior is unchanged — this is a pure extraction, not a UX change to the upload zone.

---

## Section 2: `LabelImageViewer` component

### New file: `components/label-image-viewer.tsx`

```typescript
function LabelImageViewer({ file, alt }: { file: File | null; alt: string }): JSX.Element | null;
```

- Renders `null` if `file` is `null` — no broken-image state, no placeholder.
- Otherwise renders a small square thumbnail `<button>` (uses `useObjectUrl(file)` for its `src`). Clicking it opens a `<dialog>`.
- The dialog shows the same image larger, with:
  - `+` / `−` buttons and a "Reset" button, large touch targets (matches the existing UI bar — big targets, high contrast).
  - Scroll-wheel zoom.
  - Click-drag pan once zoom > 1×, via pointer events, implemented as a CSS `transform: scale(...) translate(...)` on the `<img>`.
  - Escape closes it (native `<dialog>` behavior — no extra code needed).
  - Clicking the backdrop closes it: `onClick` on the `<dialog>` element checking `e.target === e.currentTarget` (native `<dialog>` doesn't do this itself).
- If the `<img>` fails to load (corrupt blob — should be unreachable given the upload path's magic-byte/MIME validation, but handled defensively), `onError` hides the trigger entirely rather than showing a broken-image icon. Decorative-only failure mode: never blocks or alters the verdict card itself.
- Zoom/pan state (`zoom`, `pan`) resets to defaults each time the dialog opens (`open` → `false→true` transition), instead of being remembered across opens.

---

## Section 3: Wiring into `VerdictCard`, single-label, and batch

- **`components/verdict-card.tsx`**: one new optional prop, `image?: File | null`. Renders `<LabelImageViewer file={image ?? null} alt={...} />` near the top of the card body, below the header banner. Existing call sites and tests that don't pass `image` are unaffected — the prop is optional and the component already renders `null` internally when there's no file.
- **`app/page.tsx`**: passes the existing `file` state straight through — `<VerdictCard key={runId} result={result} image={file} />`. `file` is already a real `File` by the time a result exists, for both uploads and bundled samples (`loadSample` wraps the fetched sample bytes in a `File`), so no new state is needed here.
- **`app/batch/page.tsx`**: passes its existing `files: Map<string, File>` state down as a new prop to `BatchTable`.
- **`components/batch-table.tsx`**: accepts `files: Map<string, File>`; each expanded row resolves its own file — `files.get(it.filename) ?? null` — into `<VerdictCard result={it.result} image={...} />`.

**Data flow:** the `File` never leaves the browser for this feature. It's the same in-memory object already sent to `/api/verify`, which the server never persists (invariant 6) and never echoes back — the client's own copy is the only source. The blob URL is created lazily: only when a `VerdictCard` actually mounts (single-label: once a result exists; batch: only for an expanded row), never for every collapsed batch row up front.

---

## Testing

- `hooks/use-preview-url.test.ts` — creates a URL for a given file, revokes on file change, revokes on unmount, returns `null` for `null` input.
- `components/label-image-viewer.test.tsx` — no trigger when `file` is `null`; trigger renders and opens the dialog on click; zoom buttons change the applied transform; Escape and backdrop-click both close it; `onError` hides the trigger.
- `components/verdict-card.test.tsx` — extend with a case asserting the viewer trigger renders when `image` is passed and is absent when it isn't (regression guard for existing call sites that omit it).
- `components/batch-table.test.tsx` — extend with a case asserting the correct file (by filename) reaches the correct row's `VerdictCard`.
- `components/upload-zone.test.tsx` — existing tests should pass unchanged after the `useObjectUrl` extraction; this is the regression guard that the refactor didn't change upload-zone behavior.
- No changes to `lib/matching`, `lib/schema`, or `app/api/verify/route.ts` — this feature is purely client-side presentation and never touches verdict computation.
