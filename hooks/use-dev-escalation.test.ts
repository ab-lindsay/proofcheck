import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useDevEscalation, setDevEscalation } from "@/hooks/use-dev-escalation";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("useDevEscalation", () => {
  it("defaults to false when nothing is stored — matches the server default (ladder off)", () => {
    const { result } = renderHook(() => useDevEscalation());
    expect(result.current).toBe(false);
  });

  it("reflects a stored 'true' value on mount", () => {
    localStorage.setItem("devEscalation", "true");
    const { result } = renderHook(() => useDevEscalation());
    expect(result.current).toBe(true);
  });

  it("reflects a stored 'false' value on mount", () => {
    localStorage.setItem("devEscalation", "false");
    const { result } = renderHook(() => useDevEscalation());
    expect(result.current).toBe(false);
  });

  it("updates every subscribed hook instance when setDevEscalation is called", () => {
    const a = renderHook(() => useDevEscalation());
    const b = renderHook(() => useDevEscalation());
    act(() => setDevEscalation(true));
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(true);
    expect(localStorage.getItem("devEscalation")).toBe("true");
  });
});
