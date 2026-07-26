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

  it("returns focus to the trigger button on close (native dialog.close(), not just unmounting)", () => {
    render(<LabelImageViewer file={pngFile()} alt="Sample label" />);
    const trigger = screen.getByRole("button", { name: "View label image" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.activeElement).toBe(trigger);
  });

  it("pans with arrow keys once zoomed in, clamped to no-op at zoom 1", () => {
    render(<LabelImageViewer file={pngFile()} alt="Sample label" />);
    fireEvent.click(screen.getByRole("button", { name: "View label image" }));
    const viewport = screen.getByRole("group", { name: /pan while zoomed in/i });
    const image = screen.getByAltText("Sample label") as HTMLImageElement;

    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    expect(image.style.transform).toContain("translate(0px, 0px)"); // zoom is 1 — no pan yet

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.keyDown(viewport, { key: "ArrowRight" });
    expect(image.style.transform).toContain("translate(-40px, 0px)");
    fireEvent.keyDown(viewport, { key: "ArrowDown" });
    expect(image.style.transform).toContain("translate(-40px, -40px)");
  });
});
