"use client";
import { useEffect, useRef, useState } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { usePreviewUrl } from "@/hooks/use-preview-url";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;
const PAN_STEP = 40;

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
  // dialog.close() (not just setOpen(false)) so the native dialog algorithm restores focus to
  // whatever triggered showModal() — the "View label image" button — before React unmounts it.
  const close = () => {
    dialogRef.current?.close();
    setOpen(false);
  };

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
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (zoom <= 1) return;
    const step: Record<string, { x: number; y: number }> = {
      ArrowUp: { x: 0, y: PAN_STEP },
      ArrowDown: { x: 0, y: -PAN_STEP },
      ArrowLeft: { x: PAN_STEP, y: 0 },
      ArrowRight: { x: -PAN_STEP, y: 0 },
    };
    const delta = step[e.key];
    if (!delta) return;
    e.preventDefault();
    setPan((p) => ({ x: p.x + delta.x, y: p.y + delta.y }));
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
                  className="flex h-11 w-11 items-center justify-center rounded-md border border-border hover:bg-muted"
                >
                  <ZoomOut aria-hidden className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
                  className="flex h-11 w-11 items-center justify-center rounded-md border border-border hover:bg-muted"
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
                  className="flex h-11 w-11 items-center justify-center rounded-md border border-border hover:bg-muted"
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
              role="group"
              aria-label="Label image viewport — use arrow keys to pan while zoomed in"
              tabIndex={0}
              className="flex h-[70vh] w-[80vw] max-w-3xl items-center justify-center overflow-hidden rounded-lg bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              onKeyDown={onKeyDown}
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
