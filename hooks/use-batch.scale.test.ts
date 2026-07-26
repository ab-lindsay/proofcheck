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

function rowsAndFiles(n: number) {
  const rows: BatchRow[] = [];
  const files = new Map<string, File>();
  for (let i = 0; i < n; i++) {
    const filename = `label-${i}.png`;
    rows.push({
      filename,
      application: { beverageType: "distilled-spirits", brandName: "X", classType: "Y", netContents: "750 mL" },
    });
    files.set(filename, new File(["x"], filename, { type: "image/png" }));
  }
  return { rows, files };
}

// Drains fake timers in bounded chunks while `run` is in flight. use-batch's retry backoff and the
// simulated per-request processing latency below both go through setTimeout, so nothing advances
// without this — real timers never fire under vi.useFakeTimers().
async function runToCompletion(run: () => Promise<void>) {
  let done = false;
  const runPromise = run().then(() => {
    done = true;
  });
  for (let i = 0; i < 100_000 && !done; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
  if (!done) throw new Error("Simulation did not complete — likely a deadlock in the retry loop.");
  await runPromise;
}

describe("useBatch — realistic scale simulation against the real rate limiter", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    // The limiter's `clients` map is a module-level singleton with no reset hook (see
    // lib/rate-limit.test.ts's header comment), and in the default untrusted mode it collapses every
    // caller's key into one shared bucket regardless of what's passed in — so a stable import would
    // leak one case's timestamps into the next case's window here. Resetting modules and re-importing
    // fresh per case simulates what each scenario is actually meant to model: one isolated batch
    // hitting a server with no other traffic on it yet, not several batches sharing a clock.
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Exercises the production rateLimit() sliding-window logic (not a hand-rolled stand-in) plus a
  // representative per-request processing delay, so 429/backoff dynamics match what a real 300-label
  // batch would see against the documented 60/min shared bucket, in the default (untrusted, shared-
  // bucket) mode — the zero-env-var configuration this app actually ships with.
  it.each([100, 250, 300])("drains a %i-row batch with zero permanent rate-limit failures", async (n) => {
    const { rateLimit } = await import("@/lib/rate-limit");
    const PROCESSING_MS = 500;
    let totalCalls = 0;
    let total429s = 0;
    const attemptsPerRow = new Map<string, number>();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        totalCalls++;
        const fd = init.body as FormData;
        const filename = (fd.get("image") as File).name;
        attemptsPerRow.set(filename, (attemptsPerRow.get(filename) ?? 0) + 1);

        const r = rateLimit("sim-batch", { windowMs: 60_000, max: 60 });
        if (!r.ok) {
          total429s++;
          return {
            ok: false,
            status: 429,
            headers: new Headers({ "retry-after": String(r.retryAfter) }),
            json: async () => ({ error: "Rate limit exceeded" }),
          } as unknown as Response;
        }
        await new Promise((resolve) => setTimeout(resolve, PROCESSING_MS));
        return { ok: true, json: async () => RESP } as unknown as Response;
      }),
    );

    const { result } = renderHook(() => useBatch());
    const { rows, files } = rowsAndFiles(n);

    await runToCompletion(() => result.current.run(rows, files));

    const errors = result.current.items.filter((it) => it.status === "error");
    const maxAttempts = Math.max(...attemptsPerRow.values());

    console.log(
      `[scale sim n=${n}] calls=${totalCalls} 429s=${total429s} maxAttemptsOnOneRow=${maxAttempts} ` +
        `permanentFailures=${errors.length}`,
    );

    expect(result.current.items).toHaveLength(n);
    expect(errors.map((e) => ({ filename: e.filename, error: e.error }))).toEqual([]);
  });
});
