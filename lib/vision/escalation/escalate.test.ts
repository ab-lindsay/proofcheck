import { describe, expect, it, vi } from "vitest";
import type { ExtractedField, ExtractedLabel } from "@/lib/schema";
import type { VisionProvider } from "@/lib/vision/types";
import { withEscalation } from "@/lib/vision/escalation/escalate";

const field = (over: Partial<ExtractedField> = {}): ExtractedField => ({
  value: "x",
  present: true,
  confidence: 0.95,
  boundingBox: null,
  ...over,
});
const absent = (): ExtractedField => ({ value: null, present: false, confidence: 0, boundingBox: null });

function label(over: Partial<ExtractedLabel> = {}): ExtractedLabel {
  return {
    brandName: field(),
    classType: field(),
    alcoholContent: field(),
    netContents: field(),
    nameAndAddress: field(),
    countryOfOrigin: field(),
    healthWarningStatement: field(),
    ...over,
  };
}

/** A stub VisionProvider that returns a scripted sequence of results — no model, no network. */
function stubProvider(name: string, results: (ExtractedLabel | Error)[]): VisionProvider & { calls: number } {
  let index = 0;
  return {
    name,
    calls: 0,
    async extract() {
      const result = results[Math.min(index, results.length - 1)];
      index++;
      (this as { calls: number }).calls = index;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const IMAGE = Buffer.alloc(0);
const META = { filename: "label.png", mimeType: "image/png" as const };

/** cropToBox/enhance need a real raster; a zero-length Buffer is not one. Stub the transform layer
 *  so these tests exercise the loop's control flow, not sharp (covered in transform.test.ts). */
vi.mock("@/lib/vision/escalation/transform", () => ({
  applyTransform: vi.fn(async () => Buffer.alloc(0)),
}));

describe("withEscalation — no-op paths", () => {
  it("makes zero extra calls when the baseline is clean", async () => {
    const inner = stubProvider("local-ocr", [label()]);
    const { trace } = await withEscalation(inner).extractWithTrace(IMAGE, META);
    expect(inner.calls).toBe(1);
    expect(trace.extraCalls).toBe(0);
    expect(trace.stoppedBecause).toBe("clean");
  });

  it("makes zero extra calls on a fixture-keyed tier even with weak fields", async () => {
    const inner = stubProvider("mock", [label({ healthWarningStatement: absent() })]);
    const { trace } = await withEscalation(inner).extractWithTrace(IMAGE, META);
    expect(inner.calls).toBe(1);
    expect(trace.extraCalls).toBe(0);
    expect(trace.stoppedBecause).toBe("not-repairable");
  });

  it("makes zero extra calls when only countryOfOrigin is absent", async () => {
    const inner = stubProvider("local-ocr", [label({ countryOfOrigin: absent() })]);
    const { trace } = await withEscalation(inner).extractWithTrace(IMAGE, META);
    expect(inner.calls).toBe(1);
    expect(trace.stoppedBecause).toBe("clean");
  });
});

describe("withEscalation — repair paths", () => {
  // brandName, not healthWarningStatement: the warning is FILL-ONLY in the merge (spec §3.3), so a
  // present-but-weak warning is deliberately NOT replaceable — brandName exercises the replace path.
  const weakBaseline = label({
    brandName: field({ value: "OLD T0M", confidence: 0.2, boundingBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 } }),
  });

  it("repairs a weak field and reports it as improved", async () => {
    const repaired = label({ brandName: field({ value: "OLD TOM DISTILLERY", confidence: 0.9 }) });
    const inner = stubProvider("gemini", [weakBaseline, repaired]);
    const { label: result, trace } = await withEscalation(inner).extractWithTrace(IMAGE, META);
    expect(result.brandName.value).toBe("OLD TOM DISTILLERY");
    expect(trace.extraCalls).toBe(1);
    expect(trace.attempts[0].outcome).toBe("improved");
    expect(trace.attempts[0].improvedFields).toEqual(["brandName"]);
    expect(trace.stoppedBecause).toBe("clean");
  });

  it("strips bounding boxes from a crop repair before merging (crop-relative coords are corrupt)", async () => {
    const repaired = label({
      brandName: field({
        value: "OLD TOM DISTILLERY",
        confidence: 0.9,
        boundingBox: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      }),
    });
    const inner = stubProvider("gemini", [weakBaseline, repaired]);
    const { label: result } = await withEscalation(inner).extractWithTrace(IMAGE, META);
    // The adopted repair value must NOT carry the crop-frame box into the original-frame label.
    expect(result.brandName.value).toBe("OLD TOM DISTILLERY");
    expect(result.brandName.boundingBox).toBeNull();
  });

  it("stops at the attempt cap — maxAttempts 1 spends exactly one of two candidate plans", async () => {
    // weakBaseline has ONE boxed weak field → two candidate plans (crop, then enhance). The cap IS
    // planRepairs's slice (there is no in-loop check), so maxAttempts must be BELOW the natural
    // plan count for this test to pin anything: with the cap removed, the no-change crop repair
    // leaves the field weak and the enhance plan would spend a second call. (The previous version
    // used maxAttempts 2 == the natural plan count — green with or without any cap logic.)
    const inner = stubProvider("gemini", [weakBaseline, weakBaseline, weakBaseline]);
    const { trace } = await withEscalation(inner, { maxAttempts: 1 }).extractWithTrace(IMAGE, META);
    expect(inner.calls).toBe(2); // 1 baseline + exactly 1 repair
    expect(trace.extraCalls).toBe(1);
    expect(trace.attempts).toHaveLength(1);
    expect(trace.attempts[0].outcome).toBe("no-change");
    expect(trace.stoppedBecause).toBe("cap");
  });

  it("does NOT count a transform-failure as an extra extraction call (no model call happened)", async () => {
    // applyTransform is vi.mock'd above; make it throw so the repair fails BEFORE inner.extract.
    const transform = await import("@/lib/vision/escalation/transform");
    vi.mocked(transform.applyTransform).mockRejectedValueOnce(new Error("sharp: bad raster"));
    const inner = stubProvider("gemini", [weakBaseline, label()]);
    const { trace } = await withEscalation(inner, { maxAttempts: 1 }).extractWithTrace(IMAGE, META);
    expect(trace.attempts[0].outcome).toBe("failed");
    expect(trace.attempts[0].error).toBe("transform-failed");
    // The model was never called for the repair, so this must not inflate the cost metric.
    expect(trace.extraCalls).toBe(0);
  });

  it("keeps the baseline and records a failure CATEGORY — never the raw message — when a repair throws", async () => {
    const inner = stubProvider("gemini", [weakBaseline, new Error("401 https://api.example.com?key=sk-SECRET")]);
    const { label: result, trace } = await withEscalation(inner, { maxAttempts: 1 }).extractWithTrace(IMAGE, META);
    expect(result).toEqual(weakBaseline);
    expect(trace.attempts[0].outcome).toBe("failed");
    // Invariant 5: real adapter messages embed raw model output, AWS error bodies, SDK URLs.
    // The client-visible trace must carry only the category; the detail goes to console.error.
    expect(trace.attempts[0].error).toBe("call-failed");
    expect(JSON.stringify(trace)).not.toContain("SECRET");
    expect(trace.extraCalls).toBe(1);
  });

  it("stops before a repair that would breach the budget", async () => {
    // Baseline takes 3400ms. Crop estimate = max(500, 3400/2) = 1700. Budget 5000:
    // 3400 + 1700 = 5100 > 5000 → no repair, stoppedBecause "budget".
    const times = [0, 3400, 3400];
    let i = 0;
    const now = () => times[Math.min(i++, times.length - 1)];
    const inner = stubProvider("gemini", [weakBaseline, label()]);
    const { trace } = await withEscalation(inner, { budgetMs: 5000, now }).extractWithTrace(IMAGE, META);
    expect(trace.extraCalls).toBe(0);
    expect(trace.stoppedBecause).toBe("budget");
  });

  it("a realistic 3s cloud baseline still gets a crop repair (per-transform estimate, spec §3.4)", async () => {
    // Review finding: a flat baselineMs estimate reduces to "no repair once baseline > budget/2",
    // killing the ladder on most cloud calls. Crop estimate = max(500, 3000/2) = 1500:
    // 3000 + 1500 = 4500 ≤ 5000 → the repair fires.
    const times = [0, 3000, 3000, 3000, 4200, 4200];
    let i = 0;
    const now = () => times[Math.min(i++, times.length - 1)];
    const repaired = label({ brandName: field({ value: "OLD TOM DISTILLERY", confidence: 0.9 }) });
    const inner = stubProvider("gemini", [weakBaseline, repaired]);
    const { trace } = await withEscalation(inner, { budgetMs: 5000, now }).extractWithTrace(IMAGE, META);
    expect(trace.extraCalls).toBe(1);
    expect(trace.attempts[0].outcome).toBe("improved");
  });

  it("bounds an IN-FLIGHT repair by the remaining budget — a hung repair degrades to the baseline", async () => {
    // Review 2026-07-25: the per-plan budget check is a PRE-check against an estimate; without a
    // real bound on the in-flight call, a hung provider socket rides to the route's 8 s timeout,
    // which rejects the whole extractWithTrace and discards this already-successful baseline.
    // No bounding box → the single plan is "enhance" (estimate = baselineMs), so a small fake
    // baseline duration keeps the pre-check green while the real race timer stays short (~40 ms).
    const noBoxWeak = label({ brandName: field({ value: "OLD T0M", confidence: 0.2 }) });
    let calls = 0;
    const inner: VisionProvider = {
      name: "gemini",
      extract() {
        calls++;
        if (calls === 1) return Promise.resolve(noBoxWeak);
        return new Promise<ExtractedLabel>(() => {}); // hangs forever — never settles
      },
    };
    const times = [0, 10, 10, 10, 10];
    let i = 0;
    const now = () => times[Math.min(i++, times.length - 1)];
    const { label: result, trace } = await withEscalation(inner, { budgetMs: 50, now }).extractWithTrace(IMAGE, META);
    expect(result).toEqual(noBoxWeak);
    expect(trace.attempts[0].outcome).toBe("failed");
    expect(trace.attempts[0].error).toBe("call-failed");
    expect(trace.extraCalls).toBe(1);
  });

  it("rejects a structurally invalid repair as invalid-model-output (pins the ladder's re-validation)", async () => {
    // Every real tier Zod-validates its own output (invariant 2), so this guards a tier that is
    // already misbehaving — the parse at the merge boundary is deliberate defense-in-depth: without
    // it, a string-typed confidence coerces through the merge comparison and escapes as an
    // "improvement" (verified by mutation during the 2026-07-25 review).
    const invalid = {
      ...label(),
      brandName: { value: "OLD TOM", present: true, confidence: "0.9", boundingBox: null },
    } as unknown as ExtractedLabel;
    const inner = stubProvider("gemini", [weakBaseline, invalid]);
    const { label: result, trace } = await withEscalation(inner, { maxAttempts: 1 }).extractWithTrace(IMAGE, META);
    expect(result).toEqual(weakBaseline);
    expect(trace.attempts[0].outcome).toBe("failed");
    expect(trace.attempts[0].error).toBe("invalid-model-output");
    expect(trace.extraCalls).toBe(1);
  });
});

describe("withEscalation — repair image format", () => {
  it("labels the repair call as image/png (applyTransform always emits PNG, whatever the original)", async () => {
    // Regression: a JPEG upload's meta.mimeType is image/jpeg, but the cropped/enhanced buffer is
    // PNG. Passing the original mime made Bedrock reject every repair with a 400 format mismatch —
    // the cloud ladder silently no-op'd on JPEGs. The repair meta must declare PNG.
    const seen: string[] = [];
    let n = 0;
    const inner: VisionProvider = {
      name: "gemini",
      async extract(_img, meta) {
        seen.push(meta.mimeType);
        return n++ === 0
          ? label({
              brandName: field({
                value: "OLD T0M",
                confidence: 0.2,
                boundingBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
              }),
            })
          : label({ brandName: field({ value: "OLD TOM DISTILLERY", confidence: 0.9 }) });
      },
    };
    await withEscalation(inner).extractWithTrace(IMAGE, { filename: "photo.jpg", mimeType: "image/jpeg" });
    expect(seen[0]).toBe("image/jpeg"); // baseline uses the real upload type
    expect(seen[1]).toBe("image/png"); // repair uses the transform's actual output type
  });
});

describe("withEscalation — VisionProvider compatibility", () => {
  it("satisfies VisionProvider: extract() returns just the label", async () => {
    const inner = stubProvider("local-ocr", [label()]);
    const escalating = withEscalation(inner);
    expect(escalating.name).toBe("local-ocr");
    await expect(escalating.extract(IMAGE, META)).resolves.toEqual(label());
  });
});
