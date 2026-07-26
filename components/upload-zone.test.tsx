import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { UploadZone } from "@/components/upload-zone";

describe("UploadZone file size validation", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  });
  afterEach(() => vi.restoreAllMocks());

  it("rejects files over 8 MB without calling onFile", () => {
    const onFile = vi.fn();
    const { container } = render(<UploadZone file={null} onFile={onFile} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const bigFile = new File([new Uint8Array(9 * 1024 * 1024)], "big.png", { type: "image/png" });
    Object.defineProperty(bigFile, "size", { value: 9 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [bigFile] } });
    expect(onFile).toHaveBeenCalledWith(null);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("accepts files under 8 MB", () => {
    const onFile = vi.fn();
    const { container } = render(<UploadZone file={null} onFile={onFile} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const okFile = new File([new Uint8Array(100)], "ok.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [okFile] } });
    expect(onFile).toHaveBeenCalledWith(okFile);
    expect(URL.createObjectURL).toHaveBeenCalled();
  });
});

describe("UploadZone camera capture", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  });
  afterEach(() => vi.restoreAllMocks());

  it("exposes a capture=environment input, separate from the file-picker input, for taking a photo directly", () => {
    const { getByLabelText } = render(<UploadZone file={null} onFile={() => {}} />);
    const cameraInput = getByLabelText("Take a photo") as HTMLInputElement;
    expect(cameraInput.getAttribute("capture")).toBe("environment");
    expect(cameraInput.getAttribute("accept")).toBe("image/png,image/jpeg,image/webp");
  });

  it("routes a photo taken via the camera input through the same validation as a regular upload", () => {
    const onFile = vi.fn();
    const { getByLabelText } = render(<UploadZone file={null} onFile={onFile} />);
    const cameraInput = getByLabelText("Take a photo") as HTMLInputElement;
    const bigFile = new File([new Uint8Array(9 * 1024 * 1024)], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(bigFile, "size", { value: 9 * 1024 * 1024 });
    fireEvent.change(cameraInput, { target: { files: [bigFile] } });
    expect(onFile).toHaveBeenCalledWith(null);

    const okFile = new File([new Uint8Array(100)], "photo.jpg", { type: "image/jpeg" });
    fireEvent.change(cameraInput, { target: { files: [okFile] } });
    expect(onFile).toHaveBeenCalledWith(okFile);
  });
});

describe("UploadZone object URL lifecycle", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  });
  afterEach(() => vi.restoreAllMocks());

  it("revokes the object URL it created when unmounted", () => {
    const { container, unmount } = render(<UploadZone file={null} onFile={() => {}} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" })] },
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });
});
