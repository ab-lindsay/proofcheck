// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const { selectProvider, selectCloudProvider, providerByName } = vi.hoisted(() => ({
  selectProvider: vi.fn(),
  selectCloudProvider: vi.fn(() => undefined),
  providerByName: vi.fn(),
}));
vi.mock("@/lib/vision/select", () => ({ selectProvider, selectCloudProvider, providerByName }));

import { POST } from "@/app/api/verify/route";

const CLEAN_FIELD = { value: "x", present: true, confidence: 0.95, boundingBox: null };
const CLEAN_LABEL = {
  brandName: { ...CLEAN_FIELD, value: "Old Tom Distillery" },
  classType: { ...CLEAN_FIELD, value: "Kentucky Straight Bourbon Whiskey" },
  alcoholContent: { ...CLEAN_FIELD, value: "45% Alc./Vol." },
  netContents: { ...CLEAN_FIELD, value: "750 mL" },
  nameAndAddress: { ...CLEAN_FIELD, value: "Old Tom Distillery Co., Bardstown, KY" },
  countryOfOrigin: { value: null, present: false, confidence: 0, boundingBox: null },
  healthWarningStatement: { ...CLEAN_FIELD, value: "GOVERNMENT WARNING: (1) ACCORDING TO THE SURGEON GENERAL" },
};

const ABSENT_FIELD = { value: null, present: false, confidence: 0, boundingBox: null };

const APPLICATION = {
  beverageType: "distilled-spirits",
  brandName: "Old Tom Distillery",
  classType: "Kentucky Straight Bourbon Whiskey",
  alcoholContent: "45% Alc./Vol.",
  netContents: "750 mL",
};

/** A minimal valid PNG, so the route's magic-byte sniff and sharp metadata guards pass. */
async function pngBytes(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } })
    .png()
    .toBuffer();
}

/** Faked-Request pattern from the existing route tests: bypass real multipart encoding entirely —
 *  the route only calls headers.get and formData(). (Under jsdom, `image instanceof File` fails
 *  cross-realm, which is why this file pins the node environment.) */
async function postVerify(extra: Record<string, string> = {}): Promise<Response> {
  const bytes = await pngBytes();
  const file = new File([new Uint8Array(bytes)], "upload.png", { type: "image/png" });
  const fd = new FormData();
  fd.append("image", file);
  fd.append("application", JSON.stringify(APPLICATION));
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  const req = {
    headers: { get: (h: string) => (h === "content-length" ? String(bytes.byteLength + 512) : null) },
    formData: async () => fd,
  } as unknown as Request;
  return POST(req);
}

beforeEach(() => {
  // The route builds the local-ocr fallback LADDER eagerly for any cloud-tier provider
  // (withFallback(withEscalation(cloud), withEscalation(providerByName("local-ocr")))), so
  // providerByName must always return a provider even in tests that never exercise the fallback.
  providerByName.mockReturnValue({ name: "local-ocr", extract: vi.fn(async () => CLEAN_LABEL) });
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/verify — escalation ladder is OFF by default", () => {
  beforeEach(() => vi.stubEnv("DEV_CONTROLS_ENABLED", "1"));

  it("makes NO repair call for a weak extraction unless explicitly enabled", async () => {
    // Evidence-based default (measured 2026-07-25): the ladder cost ~75% more latency and ~55% more
    // model calls, pushed both the cloud and keyless tiers past the brief's 5 s requirement, and
    // produced a NULL accuracy gain. So the default path must stay single-shot.
    const weak = {
      ...CLEAN_LABEL,
      brandName: {
        value: "Old T0m",
        present: true,
        confidence: 0.2,
        boundingBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
      },
    };
    const extract = vi.fn().mockResolvedValue(weak);
    selectProvider.mockReturnValue({ name: "gemini", extract });

    const json = await (await postVerify()).json();

    expect(extract).toHaveBeenCalledTimes(1); // baseline only
    expect(json.extraction.extraCalls).toBe(0);
    expect(json.overall).toMatch(/APPROVED|REJECTED/); // still a verdict, just single-shot
  });

  it("honours a per-request escalate=1 (the dev-mode ladder switch)", async () => {
    // Lets a reviewer watch the agentic loop on the deployed URL without a redeploy, while everyday
    // requests stay single-shot. Absent warning -> no bounding box -> "enhance" plan, real sharp.
    const weak = { ...CLEAN_LABEL, healthWarningStatement: ABSENT_FIELD };
    const extract = vi.fn().mockResolvedValueOnce(weak).mockResolvedValue(CLEAN_LABEL);
    selectProvider.mockReturnValue({ name: "gemini", extract });

    const json = await (await postVerify({ escalate: "1" })).json();

    expect(extract).toHaveBeenCalledTimes(2); // baseline + one repair
    expect(json.extraction.extraCalls).toBe(1);
  });
});

describe("POST /api/verify — extraction trace (ESCALATION_ENABLED=1)", () => {
  beforeEach(() => vi.stubEnv("ESCALATION_ENABLED", "1"));

  it("returns a trace with zero extra calls for a clean extraction", async () => {
    const extract = vi.fn(async () => CLEAN_LABEL);
    selectProvider.mockReturnValue({ name: "local-ocr", extract });

    const res = await postVerify();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(json.extraction).toMatchObject({ tier: "local-ocr", extraCalls: 0, stoppedBecause: "clean" });
  });

  it("fills an ABSENT health warning via a repair and reports it in the trace", async () => {
    // Absent, not present-but-garbled: the warning is FILL-ONLY in the merge (spec §3.3) — a
    // present transcription is deliberately never replaced. Absent → no bounding box → the plan is
    // "enhance", which runs real sharp on the tiny PNG (applyTransform is not mocked here).
    const weak = {
      ...CLEAN_LABEL,
      healthWarningStatement: { value: null, present: false, confidence: 0, boundingBox: null },
    };
    const extract = vi.fn().mockResolvedValueOnce(weak).mockResolvedValue(CLEAN_LABEL);
    selectProvider.mockReturnValue({ name: "local-ocr", extract });

    const json = await (await postVerify()).json();

    expect(extract).toHaveBeenCalledTimes(2);
    expect(json.extraction.extraCalls).toBe(1);
    expect(json.extraction.attempts[0].improvedFields).toContain("healthWarningStatement");
    // The merged (filled) transcription is what the matcher judged.
    const warningRow = json.fields.find((f: { field: string }) => f.field === "healthWarningStatement");
    expect(warningRow.labelValue).toBe(CLEAN_LABEL.healthWarningStatement.value);
  });

  it("still returns a verdict when the repair call fails, with a category not a message", async () => {
    const weak = {
      ...CLEAN_LABEL,
      brandName: {
        value: "Old T0m",
        present: true,
        confidence: 0.2,
        boundingBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
      },
    };
    const extract = vi.fn().mockResolvedValueOnce(weak).mockRejectedValue(new Error("500 internal: key=sk-SECRET"));
    selectProvider.mockReturnValue({ name: "local-ocr", extract });

    const res = await postVerify();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.overall).toMatch(/APPROVED|REJECTED/);
    expect(json.extraction.attempts.some((a: { outcome: string }) => a.outcome === "failed")).toBe(true);
    expect(JSON.stringify(json.extraction)).not.toContain("SECRET");
  });
});

describe("POST /api/verify — cloud repairs through the real withFallback(withEscalation) composition", () => {
  beforeEach(() => vi.stubEnv("DEV_CONTROLS_ENABLED", "1"));

  // Coverage gap from the 2026-07-25 review: the JPEG->PNG repair-format fix (escalate.ts) was
  // pinned only against a bare withEscalation(stubProvider) in escalate.test.ts, never through the
  // route's actual composition — which is where the original bug (Bedrock 400s on non-PNG repair
  // bytes) was reachable. This drives a JPEG upload through a cloud-tier provider and asserts the
  // repair call sees image/png.
  it("labels a repair call image/png even though the upload was JPEG, on the real cloud+fallback path", async () => {
    const jpegBytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } })
      .jpeg()
      .toBuffer();
    const seenMimeTypes: string[] = [];
    let calls = 0;
    const extract = vi.fn(async (_img: Buffer, meta: { mimeType: string }) => {
      seenMimeTypes.push(meta.mimeType);
      calls++;
      if (calls === 1) {
        return {
          ...CLEAN_LABEL,
          brandName: {
            value: "Old T0m",
            present: true,
            confidence: 0.2,
            boundingBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
          },
        };
      }
      return CLEAN_LABEL;
    });
    selectProvider.mockReturnValue({ name: "gemini", extract });
    providerByName.mockReturnValue({ name: "local-ocr", extract: vi.fn(async () => CLEAN_LABEL) });

    const file = new File([new Uint8Array(jpegBytes)], "upload.jpg", { type: "image/jpeg" });
    const fd = new FormData();
    fd.append("image", file);
    fd.append("application", JSON.stringify(APPLICATION));
    fd.append("escalate", "1"); // the ladder is off by default; this test is about the repair path
    const req = {
      headers: { get: (h: string) => (h === "content-length" ? String(jpegBytes.byteLength + 512) : null) },
      formData: async () => fd,
    } as unknown as Request;
    const json = await (await POST(req)).json();

    expect(seenMimeTypes[0]).toBe("image/jpeg"); // baseline uses the real upload type
    expect(seenMimeTypes[1]).toBe("image/png"); // repair uses the transform's actual output type
    expect(json.provider).toBe("gemini"); // baseline succeeded — no fallback
    expect(json.tier).toBe("cloud");
  });
});

describe("POST /api/verify — escalation budget is measured from request start, not the ladder's own clock", () => {
  beforeEach(() => vi.stubEnv("DEV_CONTROLS_ENABLED", "1"));

  // Coverage gap from the 2026-07-25 review: nothing pinned that the route derives budgetMs from
  // REQUEST START (requestStart = Date.now() before formData/validation) rather than from a
  // constant or from when the ladder itself begins. Simulate slow pre-extraction work by making
  // Date.now() report a large elapsed gap between the route's very first call (requestStart) and
  // every call after — including the ladder's own internal clock, since route.ts passes no `now`
  // override. If the budget were NOT reduced by that elapsed time, the repair below would fire; if
  // it correctly derives from request start, Math.max(0, ...) yields 0 and the repair is skipped.
  it("a slow pre-extraction phase exhausts the budget before any repair, never going negative", async () => {
    // requestStart = 0; every call after is a distinct, monotonically increasing later value, so
    // the ladder's own internal deltas (baselineMs, elapsed-since-start) stay realistic and
    // nonzero — only the ROUTE's pre-extraction gap (validation etc., before the ladder starts) is
    // what simulates the 6s of slow work that exhausts the 5s budget.
    let n = -1;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      n++;
      return n === 0 ? 0 : 6_000 + n;
    });

    const weak = {
      ...CLEAN_LABEL,
      healthWarningStatement: { value: null, present: false, confidence: 0, boundingBox: null },
    };
    const extract = vi.fn().mockResolvedValueOnce(weak).mockResolvedValue(CLEAN_LABEL);
    selectProvider.mockReturnValue({ name: "local-ocr", extract });

    let json: { extraction: { stoppedBecause: string; extraCalls: number } };
    try {
      // Opt in (the ladder is off by default) — this test pins the BUDGET arithmetic, which only
      // runs when the ladder is enabled at all.
      json = await (await postVerify({ escalate: "1" })).json();
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(extract).toHaveBeenCalledTimes(1); // baseline only — no repair call spent
    expect(json.extraction.extraCalls).toBe(0);
    expect(json.extraction.stoppedBecause).toBe("budget");
  });
});
