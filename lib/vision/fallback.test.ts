import { describe, expect, it, vi } from "vitest";
import { withFallback, withProviderTimeout } from "@/lib/vision/fallback";
import type { ExtractedLabel } from "@/lib/schema";
import type { EscalatingProvider, EscalationOptions, ExtractionTrace } from "@/lib/vision/escalation/types";

const IMAGE = Buffer.from([1, 2, 3]);
const META = { filename: "x.png", mimeType: "image/png" };

// Distinct sentinels per side (review 2026-07-25): a shared object identity would let a regression
// that returns the fallback's result on the success path slip past the identity assertion.
const PRIMARY_LABEL = {} as ExtractedLabel;
const FALLBACK_LABEL = {} as ExtractedLabel;

const traceFor = (tier: string): ExtractionTrace => ({
  tier,
  baselineWeakFields: [],
  attempts: [],
  extraCalls: 0,
  totalMs: 1,
  stoppedBecause: "clean",
});

type Outcome = { label: ExtractedLabel; trace: ExtractionTrace };

function stubLadder(name: string, behavior: () => Promise<Outcome>): EscalatingProvider {
  const extractWithTrace = vi.fn((_image: Buffer, _meta: typeof META, _opts?: EscalationOptions) => behavior());
  return {
    name,
    extractWithTrace,
    async extract(image: Buffer, meta: typeof META) {
      return (await extractWithTrace(image, meta)).label;
    },
  } as unknown as EscalatingProvider;
}

const cloudLadder = () => stubLadder("gemini", async () => ({ label: PRIMARY_LABEL, trace: traceFor("gemini") }));
const ocrLadder = () => stubLadder("local-ocr", async () => ({ label: FALLBACK_LABEL, trace: traceFor("local-ocr") }));
const failingLadder = (name: string, message: string) =>
  stubLadder(name, async () => {
    throw new Error(message);
  });

// The fallback path console.errors the primary's failure server-side; silence it in test output.
vi.spyOn(console, "error").mockImplementation(() => {});

describe("withFallback (composes OVER escalation — review 2026-07-25)", () => {
  it("returns the PRIMARY's outcome and never calls fallback when the primary ladder succeeds", async () => {
    const primary = cloudLadder();
    const fallback = ocrLadder();
    const { label, trace } = await withFallback(primary, fallback).extractWithTrace(IMAGE, META);
    expect(label).toBe(PRIMARY_LABEL);
    expect(trace.tier).toBe("gemini");
    expect(fallback.extractWithTrace).not.toHaveBeenCalled();
  });

  it("runs the FALLBACK ladder when the primary rejects — its trace names the tier that actually ran", async () => {
    const primary = failingLadder("gemini", "cloud down");
    const fallback = ocrLadder();
    const { label, trace } = await withFallback(primary, fallback).extractWithTrace(IMAGE, META);
    expect(label).toBe(FALLBACK_LABEL);
    expect(trace.tier).toBe("local-ocr");
    expect(fallback.extractWithTrace).toHaveBeenCalledTimes(1);
  });

  it("propagates the fallback's rejection when both ladders fail", async () => {
    const composed = withFallback(failingLadder("gemini", "cloud down"), failingLadder("local-ocr", "ocr down too"));
    await expect(composed.extractWithTrace(IMAGE, META)).rejects.toThrow("ocr down too");
  });

  it("exposes the primary's static name (per-call attribution belongs to trace.tier)", () => {
    expect(withFallback(cloudLadder(), ocrLadder()).name).toBe("gemini");
  });

  it("calls onFallback exactly once when the fallback path is taken, never on success", async () => {
    const onFallback = vi.fn();
    await withFallback(failingLadder("gemini", "down"), ocrLadder(), onFallback).extractWithTrace(IMAGE, META);
    expect(onFallback).toHaveBeenCalledTimes(1);

    const onFallbackClean = vi.fn();
    await withFallback(cloudLadder(), ocrLadder(), onFallbackClean).extractWithTrace(IMAGE, META);
    expect(onFallbackClean).not.toHaveBeenCalled();
  });

  it("forwards image, meta, and escalation options to the ladder that runs", async () => {
    const primary = cloudLadder();
    const opts = { budgetMs: 1234 };
    await withFallback(primary, ocrLadder()).extractWithTrace(IMAGE, META, opts);
    expect(vi.mocked(primary.extractWithTrace)).toHaveBeenCalledWith(IMAGE, META, opts);
  });

  it("satisfies VisionProvider: extract() returns just the label", async () => {
    await expect(withFallback(cloudLadder(), ocrLadder()).extract(IMAGE, META)).resolves.toBe(PRIMARY_LABEL);
  });
});

describe("withProviderTimeout (D3, 2026-07-25 — composition-site cap so withFallback can actually fire)", () => {
  it("resolves normally when the underlying ladder finishes before the deadline", async () => {
    const primary = cloudLadder();
    const { label, trace } = await withProviderTimeout(primary, 5_000).extractWithTrace(IMAGE, META);
    expect(label).toBe(PRIMARY_LABEL);
    expect(trace.tier).toBe("gemini");
  });

  it("rejects once the deadline elapses, so withFallback catches it and degrades to the fallback tier", async () => {
    vi.useFakeTimers();
    // Promise<never>, not a bare new Promise(() => {}): stubLadder's behavior param is typed
    // () => Promise<Outcome>, and Promise<unknown> is not assignable to it under strict TS.
    const hungPrimary = stubLadder("gemini", () => new Promise<never>(() => {}));
    const composed = withFallback(withProviderTimeout(hungPrimary, 5_000), ocrLadder());
    const pending = composed.extractWithTrace(IMAGE, META);
    await vi.advanceTimersByTimeAsync(5_001);
    const { label, trace } = await pending;
    expect(label).toBe(FALLBACK_LABEL);
    expect(trace.tier).toBe("local-ocr");
    vi.useRealTimers();
  });

  it("exposes the wrapped provider's own static name", () => {
    expect(withProviderTimeout(cloudLadder(), 5_000).name).toBe("gemini");
  });
});
