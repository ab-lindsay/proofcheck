import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useDevBedrockModel, setDevBedrockModel } from "@/hooks/use-dev-model";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("useDevBedrockModel", () => {
  it("defaults to 'haiku' when nothing is stored", () => {
    const { result } = renderHook(() => useDevBedrockModel());
    expect(result.current).toBe("haiku");
  });

  it("reflects a stored valid value on mount", () => {
    localStorage.setItem("devBedrockModel", "opus");
    const { result } = renderHook(() => useDevBedrockModel());
    expect(result.current).toBe("opus");
  });

  it("falls back to 'haiku' for a malformed stored value", () => {
    localStorage.setItem("devBedrockModel", "not-a-real-model");
    const { result } = renderHook(() => useDevBedrockModel());
    expect(result.current).toBe("haiku");
  });

  it("updates every subscribed hook instance when setDevBedrockModel is called", () => {
    const a = renderHook(() => useDevBedrockModel());
    const b = renderHook(() => useDevBedrockModel());
    act(() => setDevBedrockModel("opus"));
    expect(a.result.current).toBe("opus");
    expect(b.result.current).toBe("opus");
    expect(localStorage.getItem("devBedrockModel")).toBe("opus");
  });
});
