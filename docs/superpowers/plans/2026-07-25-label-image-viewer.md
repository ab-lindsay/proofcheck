# Label Image Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a zoomable in-app viewer for the label image, surfaced from `VerdictCard` in both single-label and batch mode, so a reviewer can visually check things the extractor can't verify (e.g. bolding on the health warning statement) without leaving the result.

**Architecture:** A shared `usePreviewUrl` hook (extracted from `upload-zone.tsx`'s existing object-URL lifecycle) backs a new `LabelImageViewer` component: a small thumbnail trigger + a native `<dialog>` modal (same pattern as `dev-mode-confirm.tsx`) with hand-rolled CSS-transform zoom/pan. `VerdictCard` takes an optional `image` prop and renders the viewer; both `app/page.tsx` (single-label) and `app/batch/page.tsx` → `BatchTable` (batch) thread their already-in-memory `File` objects into it.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Tailwind, Vitest + Testing Library. No new dependencies.

## Global Constraints

- Client-side only — the `File` never leaves the browser for this feature; the server never persists or echoes label images (CLAUDE.md invariant 6).
- No new runtime dependency — zoom/pan and the modal are hand-rolled, following the existing native `<dialog>` precedent in `components/dev-mode-confirm.tsx`.
- `VerdictCard`'s new `image` prop is optional; every existing call site and test that omits it must keep working unchanged.
- UI bar: big touch targets, high contrast, plain-English copy (CLAUDE.md working style).
- Spec: `docs/superpowers/specs/2026-07-25-label-image-viewer-design.md`.

---

### Task 1: `usePreviewUrl` hook

**Files:**

- Create: `hooks/use-preview-url.ts`
- Test: `hooks/use-preview-url.test.ts`

**Interfaces:**

- Produces: `usePreviewUrl(file: File | null): string | null` — a React hook. Returns a blob URL for a given `File`, `null` for a `null` file. Creates a new URL and revokes the previous one whenever `file` changes (by reference); revokes on unmount.

- [ ] **Step 1: Write the failing test**

Create `hooks/use-preview-url.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { usePreviewUrl } from "@/hooks/use-preview-url";

afterEach(cleanup);

function pngFile(name = "a.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

describe("usePreviewUrl", () => {
  let counter = 0;
  beforeEach(() => {
    counter = 0;
    URL.createObjectURL = vi.fn(() => `blob:mock-${counter++}`) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns null for a null file and never calls createObjectURL", () => {
    const { result } = renderHook(() => usePreviewUrl(null));
    expect(result.current).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("creates an object URL for a file", () => {
    const { result } = renderHook(() => usePreviewUrl(pngFile()));
    expect(result.current).toBe("blob:mock-0");
  });

  it("revokes the previous URL and creates a new one when the file changes", () => {
    const { result, rerender } = renderHook(({ file }) => usePreviewUrl(file), {
      initialProps: { file: pngFile("a.png") as File | null },
    });
    expect(result.current).toBe("blob:mock-0");
    rerender({ file: pngFile("b.png") });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-0");
    expect(result.current).toBe("blob:mock-1");
  });

  it("revokes the URL on unmount", () => {
    const { unmount } = renderHook(() => usePreviewUrl(pngFile()));
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-0");
  });

  it("revokes without creating a new URL when the file becomes null", () => {
    const { result, rerender } = renderHook(({ file }) => usePreviewUrl(file), {
      initialProps: { file: pngFile("a.png") as File | null },
    });
    expect(result.current).toBe("blob:mock-0");
    rerender({ file: null });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-0");
    expect(result.current).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- hooks/use-preview-url.test.ts`
Expected: FAIL — `Cannot find module '@/hooks/use-preview-url'` (the module doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `hooks/use-preview-url.ts`:

```ts
"use client";
import { useEffect, useState } from "react";

/** Turns a File into a revocable blob URL, re-creating it whenever `file` changes and revoking the
 *  previous URL on every change and on unmount. Shared by UploadZone's thumbnail and
 *  LabelImageViewer's trigger/modal so both depend on one lifecycle instead of two copies of it. */
export function usePreviewUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return url;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- hooks/use-preview-url.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add hooks/use-preview-url.ts hooks/use-preview-url.test.ts
git commit -m "feat: add usePreviewUrl hook for File-to-blob-URL lifecycle"
```

---

### Task 2: Refactor `UploadZone` to use `usePreviewUrl`

**Files:**

- Modify: `components/upload-zone.tsx`
- Test: `components/upload-zone.test.tsx` (existing — regression guard, no new test cases needed)

**Interfaces:**

- Consumes: `usePreviewUrl(file: File | null): string | null` (Task 1).
- Produces: no change to `UploadZone`'s own public props or behavior — this is a pure internal refactor.

- [ ] **Step 1: Run the existing tests to confirm the current baseline passes**

Run: `pnpm test -- components/upload-zone.test.tsx`
Expected: PASS (3 tests) — this is the regression baseline the refactor must not break.

- [ ] **Step 2: Refactor the object-URL lifecycle to use the hook**

In `components/upload-zone.tsx`, change the import line:

```ts
// Before
import { useCallback, useEffect, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";

// After
import { useCallback, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import { usePreviewUrl } from "@/hooks/use-preview-url";
```

Replace the `objectUrl` state, the `choose` callback's URL creation, and the manual revocation `useEffect`:

```tsx
// Before
const inputRef = useRef<HTMLInputElement>(null);
const [dragOver, setDragOver] = useState(false);
const [objectUrl, setObjectUrl] = useState<string | null>(null);

const choose = useCallback(
  (f: File | null) => {
    if (f && f.size > 8 * 1024 * 1024) {
      if (inputRef.current) inputRef.current.value = "";
      onFile(null);
      return;
    }
    setObjectUrl(f ? URL.createObjectURL(f) : null);
    onFile(f);
  },
  [onFile],
);

// Revoke the blob URL when it changes or the component unmounts. Revocation lives here (cleanup
// only, no setState) rather than in `choose` because a parent loading a sample sets the preview
// without going through `choose`, and soft client-side nav unmounts the page — either path would
// otherwise leak the blob for the document's lifetime.
useEffect(() => {
  if (!objectUrl) return;
  return () => URL.revokeObjectURL(objectUrl);
}, [objectUrl]);

const preview = previewSrc ?? objectUrl;

// After
const inputRef = useRef<HTMLInputElement>(null);
const [dragOver, setDragOver] = useState(false);
const [selectedFile, setSelectedFile] = useState<File | null>(null);

const choose = useCallback(
  (f: File | null) => {
    if (f && f.size > 8 * 1024 * 1024) {
      if (inputRef.current) inputRef.current.value = "";
      onFile(null);
      return;
    }
    setSelectedFile(f);
    onFile(f);
  },
  [onFile],
);

const objectUrl = usePreviewUrl(selectedFile);
const preview = previewSrc ?? objectUrl;
```

- [ ] **Step 3: Run the tests to verify no regression**

Run: `pnpm test -- components/upload-zone.test.tsx`
Expected: PASS (3 tests) — identical outcome to Step 1, now routed through the shared hook.

- [ ] **Step 4: Commit**

```bash
git add components/upload-zone.tsx
git commit -m "refactor: route UploadZone's preview URL through usePreviewUrl"
```

---

### Task 3: `LabelImageViewer` component

**Files:**

- Create: `components/label-image-viewer.tsx`
- Test: `components/label-image-viewer.test.tsx`

**Interfaces:**

- Consumes: `usePreviewUrl(file: File | null): string | null` (Task 1).
- Produces: `LabelImageViewer({ file, alt }: { file: File | null; alt: string })` — a React component. Renders `null` when `file` is `null` or the image fails to load. Otherwise renders a thumbnail `<button>` that opens a `<dialog>` with +/− zoom, a reset button, scroll-wheel zoom, and click-drag pan.

- [ ] **Step 1: Write the failing test**

Create `components/label-image-viewer.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LabelImageViewer } from "@/components/label-image-viewer";

afterEach(cleanup);

function pngFile(name = "label.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

describe("LabelImageViewer", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders nothing when file is null", () => {
    const { container } = render(<LabelImageViewer file={null} alt="Label" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a trigger and opens the dialog on click", () => {
    const { container } = render(<LabelImageViewer file={pngFile()} alt="Sample label" />);
    expect(container.querySelector("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View label image" }));
    expect(container.querySelector("dialog")).toBeInTheDocument();
    expect(screen.getByAltText("Sample label")).toBeInTheDocument();
  });

  it("zoom in increases the image's scale transform", () => {
    render(<LabelImageViewer file={pngFile()} alt="Sample label" />);
    fireEvent.click(screen.getByRole("button", { name: "View label image" }));
    const image = screen.getByAltText("Sample label") as HTMLImageElement;
    expect(image.style.transform).toContain("scale(1)");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(image.style.transform).toContain("scale(1.5)");
  });

  it("resets zoom to 1 each time the dialog is reopened", () => {
    render(<LabelImageViewer file={pngFile()} alt="Sample label" />);
    fireEvent.click(screen.getByRole("button", { name: "View label image" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect((screen.getByAltText("Sample label") as HTMLImageElement).style.transform).toContain("scale(1.5)");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "View label image" }));
    expect((screen.getByAltText("Sample label") as HTMLImageElement).style.transform).toContain("scale(1)");
  });

  it("closes on backdrop click", () => {
    const { container } = render(<LabelImageViewer file={pngFile()} alt="Sample label" />);
    fireEvent.click(screen.getByRole("button", { name: "View label image" }));
    fireEvent.click(container.querySelector("dialog")!);
    expect(container.querySelector("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape (native cancel event)", () => {
    const { container } = render(<LabelImageViewer file={pngFile()} alt="Sample label" />);
    fireEvent.click(screen.getByRole("button", { name: "View label image" }));
    fireEvent(container.querySelector("dialog")!, new Event("cancel", { cancelable: true }));
    expect(container.querySelector("dialog")).not.toBeInTheDocument();
  });

  it("hides the trigger if the thumbnail image fails to load", () => {
    const { container } = render(<LabelImageViewer file={pngFile()} alt="Sample label" />);
    const thumbnail = container.querySelector("button img") as HTMLImageElement;
    fireEvent.error(thumbnail);
    expect(screen.queryByRole("button", { name: "View label image" })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- components/label-image-viewer.test.tsx`
Expected: FAIL — `Cannot find module '@/components/label-image-viewer'`.

- [ ] **Step 3: Write the implementation**

Create `components/label-image-viewer.tsx`:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { usePreviewUrl } from "@/hooks/use-preview-url";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;

export function LabelImageViewer({ file, alt }: { file: File | null; alt: string }) {
  const previewUrl = usePreviewUrl(file);
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [broken, setBroken] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dragState = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  // Mirrors dev-mode-confirm.tsx: the <dialog> only exists in the tree while `open` is true, so this
  // effect (keyed on `open`) always finds a fresh ref to call showModal() on.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    setZoom(1);
    setPan({ x: 0, y: 0 });
    dialog.showModal();
  }, [open]);

  if (!file || !previewUrl || broken) return null;

  const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  const close = () => setOpen(false);

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    setZoom((z) => clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    setPan({
      x: dragState.current.panX + (e.clientX - dragState.current.startX),
      y: dragState.current.panY + (e.clientY - dragState.current.startY),
    });
  };
  const onPointerUp = () => {
    dragState.current = null;
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-left transition-colors hover:border-proof hover:bg-accent"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- object URL preview */}
        <img
          src={previewUrl}
          alt=""
          onError={() => setBroken(true)}
          className="h-12 w-12 shrink-0 rounded-md border border-border object-cover"
        />
        <span className="text-base font-semibold text-foreground">View label image</span>
      </button>
      {open ? (
        <dialog
          ref={dialogRef}
          aria-label="Label image viewer"
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
          className="m-auto max-h-[90vh] max-w-[90vw] rounded-xl border border-border bg-card p-0 shadow-lg backdrop:bg-black/60"
        >
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-lg font-semibold text-foreground">Label image</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Zoom out"
                  onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
                  className="flex h-10 w-10 items-center justify-center rounded-md border border-border hover:bg-muted"
                >
                  <ZoomOut aria-hidden className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
                  className="flex h-10 w-10 items-center justify-center rounded-md border border-border hover:bg-muted"
                >
                  <ZoomIn aria-hidden className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  aria-label="Reset zoom"
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                  className="flex h-10 w-10 items-center justify-center rounded-md border border-border hover:bg-muted"
                >
                  <RotateCcw aria-hidden className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="rounded-md px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted"
                >
                  Close
                </button>
              </div>
            </div>
            <div
              className="flex h-[70vh] w-[80vw] max-w-3xl items-center justify-center overflow-hidden rounded-lg bg-muted/40"
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- object URL preview, zoomed via CSS transform */}
              <img
                src={previewUrl}
                alt={alt}
                draggable={false}
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  cursor: zoom > 1 ? "grab" : "default",
                }}
                className="max-h-full max-w-full select-none object-contain"
              />
            </div>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- components/label-image-viewer.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add components/label-image-viewer.tsx components/label-image-viewer.test.tsx
git commit -m "feat: add LabelImageViewer component with zoom/pan modal"
```

---

### Task 4: Wire the viewer into `VerdictCard`

**Files:**

- Modify: `components/verdict-card.tsx`
- Test: `components/verdict-card.test.tsx`

**Interfaces:**

- Consumes: `LabelImageViewer({ file, alt }: { file: File | null; alt: string })` (Task 3).
- Produces: `VerdictCard({ result, image }: { result: VerifyResponse; image?: File | null })` — `image` is optional; omitting it renders no viewer trigger (existing behavior unchanged).

- [ ] **Step 1: Write the failing test**

In `components/verdict-card.test.tsx`, change the top import line:

```ts
// Before
import { afterEach, describe, expect, it } from "vitest";

// After
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
```

Append a new `describe` block at the end of the file:

```tsx
describe("VerdictCard label image viewer", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows no viewer trigger when no image is passed", () => {
    render(<VerdictCard result={result} />);
    expect(screen.queryByRole("button", { name: "View label image" })).not.toBeInTheDocument();
  });

  it("shows the viewer trigger when an image is passed", () => {
    const image = new File([new Uint8Array([1, 2, 3])], "label.png", { type: "image/png" });
    render(<VerdictCard result={result} image={image} />);
    expect(screen.getByRole("button", { name: "View label image" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- components/verdict-card.test.tsx`
Expected: FAIL — the second new test fails because `VerdictCard` doesn't accept or render an `image` prop yet.

- [ ] **Step 3: Wire the prop and render the viewer**

In `components/verdict-card.tsx`, add the import:

```ts
// Before
import { ExtractionTrail } from "@/components/extraction-trail";

// After
import { ExtractionTrail } from "@/components/extraction-trail";
import { LabelImageViewer } from "@/components/label-image-viewer";
```

Change the component signature:

```tsx
// Before
export function VerdictCard({ result }: { result: VerifyResponse }) {

// After
export function VerdictCard({ result, image }: { result: VerifyResponse; image?: File | null }) {
```

Insert the viewer at the top of the card body, right after the header banner div closes and before the reviews notice:

```tsx
// Before
      <div className="px-5 py-5 sm:px-6">
        {/* Still shown on a rejection: the mismatch is the headline, but unverified fields need an
            eye too, and the count is not otherwise visible. Redundant-looking under a NEEDS
            CORRECTION banner, but it is the only place the *number* appears. */}
        {reviews > 0 ? (

// After
      <div className="px-5 py-5 sm:px-6">
        {image ? (
          <div className="mb-4">
            <LabelImageViewer file={image} alt={`Label image: ${image.name}`} />
          </div>
        ) : null}

        {/* Still shown on a rejection: the mismatch is the headline, but unverified fields need an
            eye too, and the count is not otherwise visible. Redundant-looking under a NEEDS
            CORRECTION banner, but it is the only place the *number* appears. */}
        {reviews > 0 ? (
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- components/verdict-card.test.tsx`
Expected: PASS (all existing tests plus the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add components/verdict-card.tsx components/verdict-card.test.tsx
git commit -m "feat: render LabelImageViewer in VerdictCard when an image is provided"
```

---

### Task 5: Thread the image into single-label verify

**Files:**

- Modify: `app/page.tsx`

**Interfaces:**

- Consumes: `VerdictCard`'s `image?: File | null` prop (Task 4).

- [ ] **Step 1: Pass `file` through to `VerdictCard`**

In `app/page.tsx`:

```tsx
// Before
            ) : result ? (
              <VerdictCard key={runId} result={result} />
            ) : (

// After
            ) : result ? (
              <VerdictCard key={runId} result={result} image={file} />
            ) : (
```

`file` is already guaranteed to be a real `File` whenever `result` is non-null — both `onUpload` and `loadSample` set it before a verification can run, and `reset()` clears `result` whenever `file` changes.

- [ ] **Step 2: Run the full test suite to confirm no regression**

Run: `pnpm test -- app/page.test.tsx`
Expected: PASS (no changes to existing assertions; the new prop is additive).

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "feat: pass the label image into VerdictCard on the single-label page"
```

---

### Task 6: Thread images into batch verify

**Files:**

- Modify: `components/batch-table.tsx`
- Modify: `app/batch/page.tsx`
- Test: `components/batch-table.test.tsx`

**Interfaces:**

- Consumes: `VerdictCard`'s `image?: File | null` prop (Task 4).
- Produces: `BatchTable({ items, files }: { items: BatchItem[]; files?: Map<string, File> })` — `files` is optional; omitting it renders no viewer triggers in any row (existing behavior unchanged).

- [ ] **Step 1: Write the failing test**

In `components/batch-table.test.tsx`, change the top import line:

```ts
// Before
import { afterEach, describe, expect, it } from "vitest";

// After
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
```

Append a new `describe` block at the end of the file:

```tsx
describe("BatchTable label image viewer", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  });
  afterEach(() => vi.restoreAllMocks());

  it("threads the matching file into the expanded row's VerdictCard", () => {
    const items: BatchItem[] = [{ filename: "a.png", status: "done", result: passResult() }];
    const files = new Map([["a.png", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" })]]);
    render(<BatchTable items={items} files={files} />);
    fireEvent.click(screen.getByRole("button", { name: /view details/i }));
    expect(screen.getByRole("button", { name: "View label image" })).toBeInTheDocument();
  });

  it("shows no viewer trigger when files is omitted", () => {
    const items: BatchItem[] = [{ filename: "a.png", status: "done", result: passResult() }];
    render(<BatchTable items={items} />);
    fireEvent.click(screen.getByRole("button", { name: /view details/i }));
    expect(screen.queryByRole("button", { name: "View label image" })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- components/batch-table.test.tsx`
Expected: FAIL — `BatchTable` doesn't accept a `files` prop yet, so the first new test's trigger is never rendered.

- [ ] **Step 3: Wire `files` through `BatchTable`**

In `components/batch-table.tsx`, change the component signature:

```tsx
// Before
export function BatchTable({ items }: { items: BatchItem[] }) {

// After
export function BatchTable({ items, files }: { items: BatchItem[]; files?: Map<string, File> }) {
```

Pass the matching file into the expanded row's `VerdictCard`:

```tsx
// Before
{
  open ? (
    <div id={detailsId} className="mt-3 max-w-2xl">
      <VerdictCard result={it.result} />
    </div>
  ) : null;
}

// After
{
  open ? (
    <div id={detailsId} className="mt-3 max-w-2xl">
      <VerdictCard result={it.result} image={files?.get(it.filename) ?? null} />
    </div>
  ) : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- components/batch-table.test.tsx`
Expected: PASS (all existing tests plus the 2 new ones).

- [ ] **Step 5: Pass `files` from the batch page**

In `app/batch/page.tsx`:

```tsx
// Before
{
  items.length > 0 ? <BatchTable items={items} /> : null;
}

// After
{
  items.length > 0 ? <BatchTable items={items} files={files} /> : null;
}
```

- [ ] **Step 6: Commit**

```bash
git add components/batch-table.tsx components/batch-table.test.tsx app/batch/page.tsx
git commit -m "feat: thread label images into batch VerdictCards"
```

---

### Task 7: Full verification and manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass (existing 588 plus the new ones from Tasks 1, 3, 4, 6 — 5 + 7 + 2 + 2 = 16 new tests).

- [ ] **Step 2: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Manual smoke test in the browser**

Use the `test-page` skill (or start `pnpm dev` manually) to walk the single-label happy path: load a bundled sample, verify it, confirm the "View label image" trigger appears in the result card, click it, confirm the modal opens with the full image, use zoom in/out and drag-to-pan, close via the Close button, reopen and close via Escape, then via a backdrop click. Repeat once in batch mode: load the sample batch, expand a row's details, confirm the same trigger and modal work there.

- [ ] **Step 4: Report results**

No commit for this task — it's verification only. If anything fails, return to the relevant task above, fix it there (with its own commit), and re-run this task.
