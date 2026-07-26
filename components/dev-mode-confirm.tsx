// components/dev-mode-confirm.tsx
"use client";
import { useEffect, useRef } from "react";

/**
 * Positioned against the trigger, rather than centered or pinned to the viewport edge.
 *
 * Explicit positioning is required, not cosmetic: the UA stylesheet gives `dialog:modal`
 * `position: fixed; inset: 0; margin: auto`, and the `margin: auto` is the only thing centering it
 * inside that inset box — but Tailwind Preflight resets `margin: 0` on every element, so the dialog
 * collapses to the viewport's top-left corner. `bottom-auto`/`left-auto` neutralize the rest of the
 * UA `inset: 0` so the box isn't over-constrained; the actual top/left come from the anchor rect
 * measured at open time (see positionAgainst), which is the only way to sit beside a trigger whose
 * x-position depends on the header's contents and the viewport width.
 */
const ANCHORED_DIALOG_CLASS =
  "fixed bottom-auto left-auto m-0 max-w-[calc(100vw-1.5rem)] " +
  "rounded-xl border border-border bg-card p-0 text-foreground shadow-lg backdrop:bg-black/40";

/** Gap between the trigger and the dialog, and the minimum breathing room from a viewport edge. */
const ANCHOR_GAP = 8;
const VIEWPORT_MARGIN = 12;

/**
 * Right-align the dialog to the trigger's right edge and hang it just below — so it reads as
 * belonging to that button — then clamp into the viewport so it can never run off-screen on narrow
 * widths. Measured rather than expressed in CSS because the trigger's position depends on what else
 * the header is rendering (the tier switcher appears once dev mode is on).
 */
function positionAgainst(dialog: HTMLDialogElement, anchor: HTMLElement | null): void {
  if (!anchor) return;
  const a = anchor.getBoundingClientRect();
  const d = dialog.getBoundingClientRect();
  const maxLeft = window.innerWidth - d.width - VIEWPORT_MARGIN;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(a.right - d.width, maxLeft));
  const maxTop = window.innerHeight - d.height - VIEWPORT_MARGIN;
  const top = Math.max(VIEWPORT_MARGIN, Math.min(a.bottom + ANCHOR_GAP, maxTop));
  dialog.style.left = `${Math.round(left)}px`;
  dialog.style.top = `${Math.round(top)}px`;
}

export function DevModeConfirm({
  open,
  onConfirm,
  onCancel,
  anchorRef,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** The control that opens this dialog; the dialog is positioned against it. */
  anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // DevModeConfirm itself typically stays mounted across `open` toggles (its parent renders it
  // unconditionally and just flips the prop), so this effect must depend on `open` rather than
  // run once — an empty dep array would only fire on DevModeConfirm's own first mount, which is
  // usually while `open` is still false. What genuinely mounts fresh each time `open` becomes
  // true is the <dialog> DOM node (see the `if (!open) return null` below unmounting it when
  // false), so re-running this effect on every `open` transition always finds a fresh, valid ref
  // to call showModal() on — giving a real native modal (backdrop, focus trap, Escape-to-cancel).
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    dialog.showModal();
    // Position AFTER showModal(): the dialog has no measurable box until it's in the top layer.
    const reposition = () => positionAgainst(dialog, anchorRef?.current ?? null);
    reposition();
    // Keep it attached to the trigger if the viewport changes while it's open.
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [open, anchorRef]);

  if (!open) return null;

  // dialog.close() (not just calling the callback) so the native dialog algorithm restores focus to
  // the Dev toggle button that opened this — see label-image-viewer.tsx's identical fix.
  const handleCancel = () => {
    ref.current?.close();
    onCancel();
  };
  const handleConfirm = () => {
    ref.current?.close();
    onConfirm();
  };

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault(); // stay controlled: handleCancel (not the browser) decides what happens next
        handleCancel();
      }}
      className={ANCHORED_DIALOG_CLASS}
    >
      <div className="w-80 max-w-full p-5">
        <p className="text-base font-semibold text-foreground">Enable dev mode?</p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Dev mode reveals technical debugging tools, like a character-by-character comparison of extracted label text.
          It&apos;s meant for testing, not everyday review.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-md px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Enable
          </button>
        </div>
      </div>
    </dialog>
  );
}
