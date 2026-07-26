import type { ExtractedLabel } from "@/lib/schema";
import type { ImageMeta } from "@/lib/vision/types";
import type { EscalatingProvider, EscalationOptions, ExtractionTrace } from "@/lib/vision/escalation/types";

/**
 * Composes two ESCALATING providers into one: run `primary`'s full ladder, and if it rejects, retry
 * once with `fallback`'s ladder. `onFallback`, if given, fires exactly once whenever the fallback
 * path is taken — callers use it to signal the fallback (e.g. a response warning) without
 * withFallback itself carrying that state.
 *
 * Fallback composes OVER escalation (review finding, 2026-07-25). The old inside-the-ladder
 * composition — withEscalation(withFallback(cloud, localOcr)) — let a single failed cloud REPAIR
 * call silently run on local OCR and merge OCR confidences against cloud confidences (two
 * incomparable scales arbitrating field values), while the response still reported the cloud tier
 * and pushed the "cloud extraction failed" warning for a baseline that had actually succeeded.
 * With fallback outside, a repair always re-reads on the tier that produced its baseline: only a
 * BASELINE failure falls back (a failed repair already fails closed to its baseline inside the
 * ladder), so cross-tier merges are structurally impossible.
 *
 * The composed provider's static `name` is the primary's — a per-call answer can't live in a static
 * field. `trace.tier` names the tier that actually produced the extraction; read that, not `name`.
 */
export function withFallback(
  primary: EscalatingProvider,
  fallback: EscalatingProvider,
  onFallback?: () => void,
): EscalatingProvider {
  async function extractWithTrace(
    image: Buffer,
    meta: ImageMeta,
    opts?: EscalationOptions,
  ): Promise<{ label: ExtractedLabel; trace: ExtractionTrace }> {
    try {
      return await primary.extractWithTrace(image, meta, opts);
    } catch (e) {
      onFallback?.();
      // Detail server-side only — the primary's message can embed provider URLs and error bodies.
      console.error(
        `${primary.name} extraction failed — falling back to ${fallback.name}:`,
        e instanceof Error ? e.message : e,
      );
      return await fallback.extractWithTrace(image, meta, opts);
    }
  }

  return {
    name: primary.name,
    async extract(image, meta) {
      return (await extractWithTrace(image, meta)).label;
    },
    extractWithTrace,
  };
}

/**
 * Races an EscalatingProvider's own ladder against a hard deadline (review finding W1, D3
 * 2026-07-25 hardening). Compose it OUTSIDE withFallback —
 * `withFallback(withProviderTimeout(primary, ms), fallback)` — so a primary that hangs past `ms`
 * REJECTS and withFallback's own catch treats that exactly like any other primary failure,
 * degrading to the fallback tier instead of riding all the way to the route's outer (longer)
 * timeout. The abandoned primary promise settles in the background; its eventual rejection is
 * swallowed so it can never surface as an unhandled rejection.
 */
export function withProviderTimeout(provider: EscalatingProvider, ms: number): EscalatingProvider {
  function raceTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${provider.name} extraction exceeded ${ms}ms`)), ms);
    });
    promise.catch(() => {});
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  }

  return {
    name: provider.name,
    async extract(image, meta) {
      return raceTimeout(provider.extract(image, meta));
    },
    async extractWithTrace(image, meta, opts) {
      return raceTimeout(provider.extractWithTrace(image, meta, opts));
    },
  };
}
