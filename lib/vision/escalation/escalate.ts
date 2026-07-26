import { ZodError } from "zod";
import type { ExtractedLabel } from "@/lib/schema";
import { ExtractedLabelSchema } from "@/lib/schema";
import type { ImageMeta, VisionProvider } from "@/lib/vision/types";
import { ExtractionError } from "@/lib/vision/model-extraction";
import { planRepairs, weakFields } from "@/lib/vision/escalation/policy";
import { mergeExtraction } from "@/lib/vision/escalation/merge";
import { applyTransform } from "@/lib/vision/escalation/transform";
import type {
  EscalatingProvider,
  EscalationOptions,
  ExtractionTrace,
  LabelField,
  RepairAttempt,
  RepairErrorKind,
  RepairPlan,
} from "@/lib/vision/escalation/types";

/** The brief's end-to-end budget. The ladder yields before this, inside the route's own
 *  EXTRACT_TIMEOUT_MS backstop. */
export const LADDER_BUDGET_MS = 5_000;
export const MAX_REPAIR_ATTEMPTS = 2;

/** Tiers whose output is keyed to a fixture by filename/content-hash rather than computed from the
 *  pixels. Re-extracting a transformed image returns the identical fixture, so a repair can never
 *  improve anything and only burns a call — and several mock fixtures deliberately contain absent
 *  fields, so "no weak fields" alone would not protect them. */
export const FIXTURE_KEYED_TIERS: ReadonlySet<string> = new Set(["mock"]);

/** Per-transform cost estimate (spec §3.4). A flat baselineMs estimate reduces to "no repair once
 *  baseline > budget/2 ≈ 2.5 s" — killing the ladder on most cloud calls, the tier it exists for.
 *  A crop re-read is materially cheaper than the baseline (smaller raster, fewer image tokens), so
 *  estimate half, floored at 500 ms. Enhance re-reads a same-scale image: full baseline cost. */
function estimateRepairMs(plan: RepairPlan, baselineMs: number): number {
  return plan.transform === "crop" ? Math.max(500, baselineMs / 2) : baselineMs;
}

/** Invariant 5: the client-visible trace carries a CATEGORY, never e.message — real adapter
 *  messages embed raw model output (ExtractionError), AWS error bodies, and SDK URLs. */
function categorize(e: unknown): RepairErrorKind {
  if (e instanceof ExtractionError || e instanceof ZodError) return "invalid-model-output";
  return "call-failed";
}

/** Bounds an IN-FLIGHT repair call by the ladder's remaining budget. The per-plan pre-check below
 *  refuses repairs whose ESTIMATE breaches the budget, but an estimate is not a bound: without
 *  this, a hung provider socket rides to the route's 8 s hard timeout, which rejects the whole
 *  extractWithTrace and discards an already-successful baseline — the ladder turning a working
 *  verify into a 504 (invariant 7 violation; review finding 2026-07-25). Losing the race routes
 *  into the existing fail("call-failed") path, so a hung repair degrades to the baseline instead.
 *  The abandoned extract promise settles in the background; its eventual rejection is swallowed. */
function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("repair exceeded the remaining ladder budget")), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** A crop repair's bounding boxes are relative to the CROPPED image — corrupt in the original
 *  frame. Strip them so the merge can never adopt a crop-frame box. (Enhance preserves geometry.) */
function stripBoxes(label: ExtractedLabel): ExtractedLabel {
  const out = { ...label };
  for (const name of Object.keys(out) as LabelField[]) {
    out[name] = { ...out[name], boundingBox: null };
  }
  return out;
}

export function withEscalation(inner: VisionProvider, defaults: EscalationOptions = {}): EscalatingProvider {
  async function extractWithTrace(
    image: Buffer,
    meta: ImageMeta,
    opts: EscalationOptions = {},
  ): Promise<{ label: ExtractedLabel; trace: ExtractionTrace }> {
    const budgetMs = opts.budgetMs ?? defaults.budgetMs ?? LADDER_BUDGET_MS;
    const maxAttempts = opts.maxAttempts ?? defaults.maxAttempts ?? MAX_REPAIR_ATTEMPTS;
    const now = opts.now ?? defaults.now ?? Date.now;

    const start = now();
    const baseline = await inner.extract(image, meta);
    const baselineMs = now() - start;
    const attempts: RepairAttempt[] = [];
    const baselineWeakFields = weakFields(baseline);

    const finish = (
      label: ExtractedLabel,
      stoppedBecause: ExtractionTrace["stoppedBecause"],
    ): { label: ExtractedLabel; trace: ExtractionTrace } => ({
      label,
      trace: {
        tier: inner.name,
        baselineWeakFields,
        attempts,
        // Only attempts that actually reached inner.extract cost a model call. A transform-failed
        // attempt threw before the model was invoked, so it must not inflate the cost metric.
        extraCalls: attempts.filter((a) => a.error !== "transform-failed").length,
        totalMs: now() - start,
        stoppedBecause,
      },
    });

    if (FIXTURE_KEYED_TIERS.has(inner.name)) return finish(baseline, "not-repairable");
    if (baselineWeakFields.length === 0) return finish(baseline, "clean");

    const plans = planRepairs(baseline, maxAttempts);
    if (plans.length === 0) return finish(baseline, "no-plan");

    let label = baseline;
    // The attempt cap is enforced by planRepairs's slice (maxPlans = maxAttempts): each iteration
    // pushes exactly one attempt and never replans, so plans.length bounds attempts.length.
    for (const plan of plans) {
      if (now() - start + estimateRepairMs(plan, baselineMs) > budgetMs) return finish(label, "budget");

      const attemptStart = now();
      const fail = (kind: RepairErrorKind, e: unknown) => {
        // Fail closed, per item (invariant 7): a failed repair yields the baseline, never an error.
        // Detail server-side only, mirroring the route's error policy.
        console.error(`escalation repair failed (${kind}):`, e instanceof Error ? e.message : e);
        attempts.push({
          transform: plan.transform,
          targetFields: plan.targetFields,
          durationMs: now() - attemptStart,
          outcome: "failed",
          improvedFields: [],
          error: kind,
        });
      };

      let transformed: Buffer;
      try {
        transformed = await applyTransform(image, plan);
      } catch (e) {
        fail("transform-failed", e);
        continue;
      }
      try {
        // applyTransform (crop/enhance) always emits PNG. The repair meta must say so — passing the
        // ORIGINAL mimeType (e.g. image/jpeg) makes format-checking cloud adapters (Bedrock) reject
        // the PNG bytes with a 400, silently no-op'ing the ladder on every non-PNG upload.
        const repairMeta = { ...meta, mimeType: "image/png" };
        const remainingMs = Math.max(1, budgetMs - (now() - start));
        // Re-validating the repair is deliberate defense-in-depth: every real tier already
        // Zod-validates its own output (invariant 2), but the merge must never be reachable by an
        // unvalidated shape from a misbehaving provider. Do not delete as redundant.
        const raw = ExtractedLabelSchema.parse(await raceDeadline(inner.extract(transformed, repairMeta), remainingMs));
        const repair = plan.transform === "crop" ? stripBoxes(raw) : raw;
        const { merged, improvedFields } = mergeExtraction(label, repair);
        label = merged;
        attempts.push({
          transform: plan.transform,
          targetFields: plan.targetFields,
          durationMs: now() - attemptStart,
          outcome: improvedFields.length > 0 ? "improved" : "no-change",
          improvedFields,
        });
      } catch (e) {
        fail(categorize(e), e);
      }

      if (weakFields(label).length === 0) return finish(label, "clean");
    }

    return finish(label, attempts.length >= maxAttempts ? "cap" : "no-plan");
  }

  return {
    name: inner.name,
    async extract(image, meta) {
      return (await extractWithTrace(image, meta)).label;
    },
    extractWithTrace,
  };
}
