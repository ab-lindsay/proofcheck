// components/dev-mode-confirm.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DevModeConfirm } from "@/components/dev-mode-confirm";

afterEach(cleanup);

describe("DevModeConfirm", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<DevModeConfirm open={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the confirmation copy when open", () => {
    render(<DevModeConfirm open={true} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Enable dev mode?")).toBeInTheDocument();
  });

  it("calls onConfirm when Enable is clicked", () => {
    const onConfirm = vi.fn();
    render(<DevModeConfirm open={true} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = vi.fn();
    render(<DevModeConfirm open={true} onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not rely on the UA's margin:auto centering", () => {
    // Regression: Tailwind Preflight resets `margin: 0` on every element, which kills the UA
    // stylesheet's `dialog:modal { margin: auto }` — the only thing centering a native modal inside
    // its `inset: 0` box. With margin:0 and no explicit positioning the dialog pinned to the
    // viewport's top-left corner, far from the Dev toggle that opens it.
    const { container } = render(<DevModeConfirm open={true} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const cls = (container.querySelector("dialog") as HTMLDialogElement).className;
    expect(cls).toContain("fixed");
    // The UA `inset: 0` also sets bottom/left; both must be neutralized or the box is over-constrained.
    expect(cls).toContain("bottom-auto");
    expect(cls).toContain("left-auto");
  });

  it("right-aligns to the anchor's right edge and hangs just below it", () => {
    // Pinning to the viewport edge put the dialog far to the right of the button that opened it
    // (the header has other controls to the Dev toggle's right), so it must be measured against the
    // trigger rather than expressed as a fixed offset.
    // jsdom defaults to a 1024px-wide window; use the real desktop width the bug was measured at so
    // the anchor (Dev toggle at x 989-1035) is genuinely on-screen and the clamp doesn't engage.
    window.innerWidth = 1280;
    window.innerHeight = 720;
    const anchor = document.createElement("button");
    anchor.getBoundingClientRect = () =>
      ({ top: 25, bottom: 53, left: 989, right: 1035, width: 46, height: 28 }) as DOMRect;
    const { container } = render(
      <DevModeConfirm open={true} onConfirm={vi.fn()} onCancel={vi.fn()} anchorRef={{ current: anchor }} />,
    );
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    // jsdom reports a zero-size box, so the dialog's right edge lands exactly on the anchor's.
    expect(dialog.style.left).toBe("1035px");
    expect(dialog.style.top).toBe("61px"); // anchor.bottom + 8px gap
  });

  it("clamps into the viewport instead of overflowing when the anchor sits near an edge", () => {
    const anchor = document.createElement("button");
    anchor.getBoundingClientRect = () => ({ top: 0, bottom: 10, left: 0, right: 4, width: 4, height: 10 }) as DOMRect;
    const { container } = render(
      <DevModeConfirm open={true} onConfirm={vi.fn()} onCancel={vi.fn()} anchorRef={{ current: anchor }} />,
    );
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    expect(parseFloat(dialog.style.left)).toBeGreaterThanOrEqual(12);
  });

  it("still opens when no anchor is supplied", () => {
    render(<DevModeConfirm open={true} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Enable dev mode?")).toBeInTheDocument();
  });

  it("calls onCancel when the dialog's native cancel event fires (Escape key)", () => {
    const onCancel = vi.fn();
    const { container } = render(<DevModeConfirm open={true} onConfirm={vi.fn()} onCancel={onCancel} />);
    const dialog = container.querySelector("dialog") as HTMLDialogElement;
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
