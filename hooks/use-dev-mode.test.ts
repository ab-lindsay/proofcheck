// hooks/use-dev-mode.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useDevMode, setDevMode } from "@/hooks/use-dev-mode";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("useDevMode", () => {
  it("defaults to false when nothing is stored", () => {
    const { result } = renderHook(() => useDevMode());
    expect(result.current).toBe(false);
  });

  it("reflects a stored true value on mount", () => {
    localStorage.setItem("devMode", "true");
    const { result } = renderHook(() => useDevMode());
    expect(result.current).toBe(true);
  });

  it("updates every subscribed hook instance when setDevMode is called", () => {
    const a = renderHook(() => useDevMode());
    const b = renderHook(() => useDevMode());
    act(() => setDevMode(true));
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(true);
    expect(localStorage.getItem("devMode")).toBe("true");
  });
});
