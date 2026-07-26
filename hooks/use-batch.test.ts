// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBatch } from "@/hooks/use-batch";
import type { BatchRow } from "@/lib/csv";
import type { VerifyResponse } from "@/hooks/use-verify";

const RESP: VerifyResponse = {
  overall: "APPROVED",
  fields: [],
  warnings: [],
  processingMs: 10,
  tier: "mock",
  provider: "mock",
  beverageType: "distilled-spirits",
};

const ok = () => ({ ok: true, json: async () => RESP }) as unknown as Response;

function rowsAndFiles(n: number, opts: { missing?: string[] } = {}) {
  const rows: BatchRow[] = [];
  const files = new Map<string, File>();
  for (let i = 0; i < n; i++) {
    const filename = `label-${i}.png`;
    rows.push({
      filename,
      application: { beverageType: "distilled-spirits", brandName: "X", classType: "Y", netContents: "750 mL" },
    });
    if (!opts.missing?.includes(filename)) files.set(filename, new File(["x"], filename, { type: "image/png" }));
  }
  return { rows, files };
}

// use-batch paces dispatch to at most one request/second across all workers (see the module doc in
// hooks/use-batch.ts), so any test with more than one fetch call needs fake timers advanced explicitly
// — real timers never fire under vi.useFakeTimers(), and without this every such test would burn a
// real wall-clock second per row.
async function runToCompletion(run: () => Promise<void>) {
  let done = false;
  const runPromise = run().then(() => {
    done = true;
  });
  for (let i = 0; i < 10_000 && !done; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
  if (!done) throw new Error("run() did not complete — likely a deadlock in the retry loop.");
  await runPromise;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useBatch", () => {
  it("resolves every matched row to done with its result and clears running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok()),
    );
    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(3);
    await runToCompletion(() => result.current.run(rows, files));
    expect(result.current.items).toHaveLength(3);
    expect(result.current.items.every((i) => i.status === "done")).toBe(true);
    expect(result.current.items[0].result).toEqual(RESP);
    expect(result.current.running).toBe(false);
  });

  it("marks a row with no matching image as error and never fetches it", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(2, { missing: ["label-1.png"] });
    await runToCompletion(() => result.current.run(rows, files));
    const missing = result.current.items.find((i) => i.filename === "label-1.png")!;
    expect(missing.status).toBe("error");
    expect(missing.error).toMatch(/no uploaded image/i);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the matched row hits the API
  });

  it("surfaces a non-OK response as an error item carrying the server message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "rate-limited" }) }) as unknown as Response),
    );
    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(1);
    await runToCompletion(() => result.current.run(rows, files));
    expect(result.current.items[0].status).toBe("error");
    expect(result.current.items[0].error).toBe("rate-limited");
  });

  // The server's rate limiter (60/min, shared bucket by default) makes batches larger than the
  // limit partially 429 — the brief's 200-300-label scale must complete by pacing itself against
  // Retry-After, not fail 70% of its rows.
  it("retries a 429 after Retry-After and completes the row", async () => {
    const tooMany = () =>
      ({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "0" }),
        json: async () => ({ error: "Rate limit exceeded" }),
      }) as unknown as Response;
    const fetchMock = vi
      .fn<typeof fetch>(async () => ok())
      .mockResolvedValueOnce(tooMany())
      .mockResolvedValueOnce(tooMany());
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(1);
    await runToCompletion(() => result.current.run(rows, files));
    expect(fetchMock).toHaveBeenCalledTimes(3); // 429, 429, then success
    expect(result.current.items[0].status).toBe("done");
  });

  it("gives up after bounded 429 retries with a plain-English rate-limit message", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: false,
          status: 429,
          headers: new Headers({ "retry-after": "0" }),
          json: async () => ({ error: "Rate limit exceeded" }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(1);
    await runToCompletion(() => result.current.run(rows, files));
    expect(fetchMock).toHaveBeenCalledTimes(5); // initial attempt + 4 retries
    expect(result.current.items[0].status).toBe("error");
    expect(result.current.items[0].error).toMatch(/try again|smaller batch/i);
  });

  it("surfaces a thrown fetch (network error) as an error item", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(1);
    await runToCompletion(() => result.current.run(rows, files));
    expect(result.current.items[0].status).toBe("error");
    expect(result.current.items[0].error).toBe("network down");
  });

  it("runs at most CONCURRENCY (5) requests at once and still completes every row", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    // Processing must outlast the ~1s dispatch pacing gap between the 1st and 5th worker's first
    // request, or pacing itself (not the concurrency cap) becomes the bottleneck and maxInFlight
    // never climbs high enough to prove the cap is 5.
    const PROCESSING_MS = 5000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, PROCESSING_MS));
        inFlight--;
        return ok();
      }),
    );
    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(12);
    await runToCompletion(() => result.current.run(rows, files));
    expect(maxInFlight).toBe(5); // 12 queued, capped at 5 workers, never exceeded
    expect(result.current.items.filter((i) => i.status === "done")).toHaveLength(12);
    expect(result.current.running).toBe(false);
  });

  it("sets running=true while requests are in flight and false once finished", async () => {
    // A 50ms fetch keeps the single request pending across the microtask checkpoint below, so we can
    // observe running=true after React has committed it, then false after the run resolves. This is
    // the batch's first-ever dispatch, so pacing adds no delay here (see hooks/use-batch.ts) — only
    // the fetch's own fake-timed delay needs advancing.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(ok()), 50))),
    );
    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(1);
    let done!: Promise<void>;
    await act(async () => {
      done = result.current.run(rows, files);
      await Promise.resolve(); // let React commit setRunning(true); the 50ms fetch is still pending
    });
    expect(result.current.running).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      await done;
    });
    expect(result.current.running).toBe(false);
  });

  it("does not include devTier when dev mode is off", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(1);
    await runToCompletion(() => result.current.run(rows, files));
    const [, init] = fetchMock.mock.calls[0];
    const fd = init!.body as FormData;
    expect(fd.get("devTier")).toBeNull();
  });

  it("includes devTier on every request when dev mode is on", async () => {
    localStorage.setItem("devMode", "true");
    localStorage.setItem("devTier", "cloud");
    const fetchMock = vi.fn<typeof fetch>(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(2);
    await runToCompletion(() => result.current.run(rows, files));
    for (const call of fetchMock.mock.calls) {
      const [, init] = call;
      const fd = init!.body as FormData;
      expect(fd.get("devTier")).toBe("cloud");
    }
  });

  // The "Re-read weak fields" switch lives in the shared header, so it is visible on the batch page
  // too. Honouring it for single verifies but not batch would make one switch mean two things.
  it("does not include escalate when the dev ladder toggle is off", async () => {
    localStorage.setItem("devMode", "true");
    const fetchMock = vi.fn<typeof fetch>(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(1);
    await runToCompletion(() => result.current.run(rows, files));
    expect((fetchMock.mock.calls[0][1]!.body as FormData).get("escalate")).toBeNull();
  });

  it("includes escalate=1 on EVERY request when dev mode and the ladder toggle are on", async () => {
    localStorage.setItem("devMode", "true");
    localStorage.setItem("devEscalation", "true");
    const fetchMock = vi.fn<typeof fetch>(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(3);
    await runToCompletion(() => result.current.run(rows, files));
    expect(fetchMock.mock.calls).toHaveLength(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init!.body as FormData).get("escalate")).toBe("1");
    }
  });

  it("does not include escalate when the toggle is on but dev mode is off", async () => {
    localStorage.setItem("devEscalation", "true"); // stale flag, dev mode never enabled
    const fetchMock = vi.fn<typeof fetch>(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(1);
    await runToCompletion(() => result.current.run(rows, files));
    expect((fetchMock.mock.calls[0][1]!.body as FormData).get("escalate")).toBeNull();
  });
});
