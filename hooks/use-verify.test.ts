import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVerify } from "@/hooks/use-verify";
import type { ApplicationData } from "@/lib/schema";

const app: ApplicationData = {
  beverageType: "distilled-spirits",
  brandName: "OLD TOM DISTILLERY",
  classType: "Kentucky Straight Bourbon Whiskey",
  alcoholContent: "45% Alc./Vol. (90 Proof)",
  netContents: "750 mL",
};
const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("useVerify", () => {
  it("reset() clears a prior verdict so it can't linger on a changed image", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        overall: "APPROVED",
        fields: [],
        warnings: [],
        processingMs: 5,
        tier: "mock",
        provider: "mock",
      }),
    } as Response);
    const { result } = renderHook(() => useVerify());
    await act(async () => {
      await result.current.verify(app, file);
    });
    expect(result.current.result?.overall).toBe("APPROVED");
    act(() => result.current.reset());
    expect(result.current.result).toBeNull();
  });

  // The race the earlier comments wrongly claimed impossible: the user switches sample/image while a
  // slow verify is in flight (reset() runs), then the superseded response arrives. It must be
  // dropped — otherwise label A's verdict renders beside label B's image and application data.
  it("a response that resolves after reset() is dropped, never shown for the wrong image", async () => {
    let resolveFetch!: (r: Response) => void;
    vi.spyOn(global, "fetch").mockReturnValue(new Promise<Response>((r) => (resolveFetch = r)));
    const { result } = renderHook(() => useVerify());
    let inFlight!: Promise<void>;
    await act(async () => {
      inFlight = result.current.verify(app, file);
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(true);
    act(() => result.current.reset());
    expect(result.current.loading).toBe(false);
    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({
          overall: "REJECTED",
          fields: [],
          warnings: [],
          processingMs: 5,
          tier: "mock",
          provider: "mock",
        }),
      } as Response);
      await inFlight;
    });
    expect(result.current.result).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("fetch throwing sets error and leaves result null", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useVerify());
    await act(async () => {
      await result.current.verify(app, file);
    });
    expect(result.current.error).toBe("network down");
    expect(result.current.result).toBeNull();
  });

  it("non-OK response surfaces the server's error message from body.error", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      json: async () => ({ error: "rate-limited" }),
    } as Response);
    const { result } = renderHook(() => useVerify());
    await act(async () => {
      await result.current.verify(app, file);
    });
    expect(result.current.error).toBe("rate-limited");
    expect(result.current.result).toBeNull();
  });

  it("sets loading=true while the request is in flight and false once it settles", async () => {
    // A 50ms fetch keeps the request pending across the microtask checkpoint below, so we can
    // observe loading=true after React has committed it, then false after verify() resolves.
    vi.spyOn(global, "fetch").mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                json: async () => ({
                  overall: "APPROVED",
                  fields: [],
                  warnings: [],
                  processingMs: 5,
                  tier: "mock",
                  provider: "mock",
                }),
              } as Response),
            50,
          ),
        ),
    );
    const { result } = renderHook(() => useVerify());
    let done!: Promise<void>;
    await act(async () => {
      done = result.current.verify(app, file);
      await Promise.resolve(); // let React commit setState({ loading: true, ... }); the fetch is still pending
    });
    expect(result.current.loading).toBe(true);
    await act(async () => {
      await done;
    });
    expect(result.current.loading).toBe(false);
  });

  it("passes AbortSignal.timeout(30_000) to fetch", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        overall: "APPROVED",
        fields: [],
        warnings: [],
        processingMs: 5,
        tier: "mock",
        provider: "mock",
      }),
    } as Response);
    const { result } = renderHook(() => useVerify());
    await act(async () => {
      await result.current.verify(app, file);
    });
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not include devTier when dev mode is off", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        overall: "APPROVED",
        fields: [],
        warnings: [],
        processingMs: 5,
        tier: "mock",
        provider: "mock",
      }),
    } as Response);
    const { result } = renderHook(() => useVerify());
    await act(async () => {
      await result.current.verify(app, file);
    });
    const [, init] = fetchSpy.mock.calls[0];
    const fd = init?.body as FormData;
    expect(fd.get("devTier")).toBeNull();
  });

  it("includes devTier when dev mode is on", async () => {
    localStorage.setItem("devMode", "true");
    localStorage.setItem("devTier", "local-ocr");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        overall: "APPROVED",
        fields: [],
        warnings: [],
        processingMs: 5,
        tier: "local-ocr",
        provider: "local-ocr",
      }),
    } as Response);
    const { result } = renderHook(() => useVerify());
    await act(async () => {
      await result.current.verify(app, file);
    });
    const [, init] = fetchSpy.mock.calls[0];
    const fd = init?.body as FormData;
    expect(fd.get("devTier")).toBe("local-ocr");
  });

  // `escalate` is only ever sent to turn the ladder ON. Its absence means "use the server default",
  // which is off — so a stale client can never silently re-enable the latency cost.
  it("does not include escalate when the dev ladder toggle is off", async () => {
    localStorage.setItem("devMode", "true");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        overall: "APPROVED",
        fields: [],
        warnings: [],
        processingMs: 5,
        tier: "mock",
        provider: "mock",
      }),
    } as Response);
    const { result } = renderHook(() => useVerify());
    await act(async () => {
      await result.current.verify(app, file);
    });
    const fd = fetchSpy.mock.calls[0][1]?.body as FormData;
    expect(fd.get("escalate")).toBeNull();
  });

  it("includes escalate=1 when dev mode and the ladder toggle are both on", async () => {
    localStorage.setItem("devMode", "true");
    localStorage.setItem("devEscalation", "true");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        overall: "APPROVED",
        fields: [],
        warnings: [],
        processingMs: 5,
        tier: "mock",
        provider: "mock",
      }),
    } as Response);
    const { result } = renderHook(() => useVerify());
    await act(async () => {
      await result.current.verify(app, file);
    });
    const fd = fetchSpy.mock.calls[0][1]?.body as FormData;
    expect(fd.get("escalate")).toBe("1");
  });

  it("does not include escalate when the ladder toggle is on but dev mode is off", async () => {
    localStorage.setItem("devEscalation", "true"); // stale flag, dev mode never enabled
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        overall: "APPROVED",
        fields: [],
        warnings: [],
        processingMs: 5,
        tier: "mock",
        provider: "mock",
      }),
    } as Response);
    const { result } = renderHook(() => useVerify());
    await act(async () => {
      await result.current.verify(app, file);
    });
    const fd = fetchSpy.mock.calls[0][1]?.body as FormData;
    expect(fd.get("escalate")).toBeNull();
  });
});
