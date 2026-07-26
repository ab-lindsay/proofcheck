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
    const file = pngFile();
    const { result } = renderHook(() => usePreviewUrl(file));
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
    const file = pngFile();
    const { unmount } = renderHook(() => usePreviewUrl(file));
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
