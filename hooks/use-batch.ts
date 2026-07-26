"use client";
import { useCallback, useState } from "react";
import type { BatchItem, BatchRow } from "@/lib/csv";
import type { VerifyResponse } from "@/hooks/use-verify";
import { SAMPLE_FILENAMES } from "@/lib/vision/mock";
import { DEFAULT_MAX, DEFAULT_WINDOW_MS } from "@/lib/rate-limit";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useDevTier, type DevTier } from "@/hooks/use-dev-tier";
import { useDevEscalation } from "@/hooks/use-dev-escalation";
import { useDevBedrockModel, type DevBedrockModel } from "@/hooks/use-dev-model";

const CONCURRENCY = 5;
const SAMPLE_SET = new Set(SAMPLE_FILENAMES);
// The server rate-limits /api/verify (60/min in one shared bucket by default), and this hook fans
// out one request per CSV row. Two complementary defenses keep a 200-300-row batch (the brief's
// stated scale) from failing rows outright:
//
//   1. Proactive pacing (DISPATCH_INTERVAL_MS / createDispatchPacer below): dispatch is gated to at
//      most one request per interval, globally across all CONCURRENCY workers, so the client never
//      bursts past the server's sustainable rate in the first place. Without this, 5 workers firing
//      simultaneously saturate the 60-request window in well under a second, and the earliest-queued
//      rows can exhaust their retry budget before the window starts draining — measured as 10/300
//      rows failing permanently in hooks/use-batch.scale.test.ts before this fix landed.
//   2. Reactive retry (below): a 429 that still gets through — e.g. from other traffic sharing the
//      same bucket — is retried against Retry-After, bounded, so the batch degrades to the limiter's
//      pace instead of failing rows.
const MAX_RATE_LIMIT_RETRIES = 4;
const MAX_RETRY_AFTER_S = 30;
// Derived from the server's default limiter config rather than a duplicated magic number, so the two
// can't silently drift apart if the default ever changes.
const DISPATCH_INTERVAL_MS = Math.ceil(DEFAULT_WINDOW_MS / DEFAULT_MAX);

/** A token-bucket-of-one: gates dispatch to at most one call per `intervalMs` across every caller
 *  that awaits it. Created fresh per `run()` so concurrent batches (e.g. two tabs) don't share pacing
 *  state they have no way to coordinate. */
function createDispatchPacer(intervalMs: number) {
  let nextSlot = 0;
  return async function waitForSlot() {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + intervalMs;
    const delay = slot - now;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  };
}

async function verifyOne(
  row: BatchRow,
  file: File,
  waitForSlot: () => Promise<void>,
  devTier?: DevTier,
  escalate?: boolean,
  devBedrockModel?: DevBedrockModel,
): Promise<VerifyResponse> {
  const fd = new FormData();
  fd.set("application", JSON.stringify(row.application));
  fd.set("image", file);
  if (SAMPLE_SET.has(file.name)) fd.set("source", "sample");
  if (devTier) fd.set("devTier", devTier);
  if (devBedrockModel) fd.set("devBedrockModel", devBedrockModel);
  // Must mirror use-verify.ts: the toggle lives in the shared header, so it is visible on the batch
  // page too. Honouring it for single verifies but not batch would make the same switch mean
  // different things on two screens.
  if (escalate) fd.set("escalate", "1");
  for (let attempt = 0; ; attempt++) {
    await waitForSlot();
    const res = await fetch("/api/verify", { method: "POST", body: fd, signal: AbortSignal.timeout(30_000) });
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const header = Number(res.headers?.get?.("retry-after"));
      const seconds = Number.isFinite(header) ? Math.min(Math.max(header, 0), MAX_RETRY_AFTER_S) : 2;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      continue;
    }
    const body = await res.json();
    if (!res.ok) {
      if (res.status === 429) {
        throw new Error(
          "The server is still rate-limiting after several retries — try again in a minute, or use a smaller batch.",
        );
      }
      throw new Error(body.error ?? "Verification failed.");
    }
    return body as VerifyResponse;
  }
}

export function useBatch() {
  const [items, setItems] = useState<BatchItem[]>([]);
  const [running, setRunning] = useState(false);
  const devMode = useDevMode();
  const devTier = useDevTier();
  const devEscalation = useDevEscalation();
  const devBedrockModel = useDevBedrockModel();

  const run = useCallback(
    async (rows: BatchRow[], files: Map<string, File>) => {
      const effectiveDevTier = devMode ? devTier : undefined;
      const effectiveEscalate = devMode && devEscalation;
      const effectiveDevBedrockModel = devMode ? devBedrockModel : undefined;
      const update = (filename: string, patch: Partial<BatchItem>) =>
        setItems((prev) => prev.map((it) => (it.filename === filename ? { ...it, ...patch } : it)));

      setRunning(true);
      setItems(
        rows.map((r) => ({
          filename: r.filename,
          status: files.has(r.filename) ? "queued" : "error",
          error: files.has(r.filename) ? undefined : "No uploaded image matches this filename.",
        })),
      );
      const queue = rows.filter((r) => files.has(r.filename));
      const waitForSlot = createDispatchPacer(DISPATCH_INTERVAL_MS);
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
          const row = queue.shift();
          if (!row) break;
          update(row.filename, { status: "running" });
          try {
            const result = await verifyOne(
              row,
              files.get(row.filename) as File,
              waitForSlot,
              effectiveDevTier,
              effectiveEscalate,
              effectiveDevBedrockModel,
            );
            update(row.filename, { status: "done", result });
          } catch (e) {
            update(row.filename, { status: "error", error: e instanceof Error ? e.message : "Failed." });
          }
        }
      });
      await Promise.all(workers);
      setRunning(false);
    },
    [devMode, devTier, devEscalation, devBedrockModel],
  );

  return { items, running, run };
}
