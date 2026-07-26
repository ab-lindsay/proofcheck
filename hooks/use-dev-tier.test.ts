import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useDevTier, setDevTier } from "@/hooks/use-dev-tier";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("useDevTier", () => {
  // Idempotence: turning dev mode ON must not change any verdict. "auto" means "route exactly as
  // the app does with dev mode off" — which sends genuine bundled samples to their mock fixtures.
  // Defaulting to a concrete tier (it used to be "cloud") bypassed that fixture routing, so the
  // sample gallery's curated "passes"/"fails" labels could disagree with what the app showed.
  it("defaults to 'auto' when nothing is stored", () => {
    const { result } = renderHook(() => useDevTier());
    expect(result.current).toBe("auto");
  });

  it("reflects a stored valid value on mount", () => {
    localStorage.setItem("devTier", "local-ocr");
    const { result } = renderHook(() => useDevTier());
    expect(result.current).toBe("local-ocr");
  });

  it("accepts 'auto' as a stored value", () => {
    localStorage.setItem("devTier", "auto");
    const { result } = renderHook(() => useDevTier());
    expect(result.current).toBe("auto");
  });

  it("falls back to 'auto' for a malformed stored value", () => {
    localStorage.setItem("devTier", "not-a-real-tier");
    const { result } = renderHook(() => useDevTier());
    expect(result.current).toBe("auto");
  });

  it("updates every subscribed hook instance when setDevTier is called", () => {
    const a = renderHook(() => useDevTier());
    const b = renderHook(() => useDevTier());
    act(() => setDevTier("local-llm"));
    expect(a.result.current).toBe("local-llm");
    expect(b.result.current).toBe("local-llm");
    expect(localStorage.getItem("devTier")).toBe("local-llm");
  });
});
