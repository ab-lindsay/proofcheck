// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";

// Mock tesseract.js so the local-ocr-tier tests below never touch a real worker — no
// eng.traineddata download, no /tmp cache dependency. Mirrors app/api/verify/route.test.ts.
const mockRecognize = vi.fn();
vi.mock("tesseract.js", () => ({
  createWorker: async () => ({ recognize: mockRecognize, setParameters: vi.fn().mockResolvedValue(undefined) }),
  PSM: { SINGLE_COLUMN: "4" },
}));

import { POST } from "@/app/api/batch/route";

afterEach(() => {
  vi.unstubAllEnvs();
  mockRecognize.mockReset();
});

const app = {
  beverageType: "distilled-spirits",
  brandName: "OLD TOM DISTILLERY",
  classType: "Kentucky Straight Bourbon Whiskey",
  alcoholContent: "45% Alc./Vol. (90 Proof)",
  netContents: "750 mL",
};

// PNG signature only — sniffs as image/png but sharp cannot read it, so it is rejected per item
// after the MIME check and before provider selection.
const TRUNCATED_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Genuine bundled-sample bytes — required for the mock tier now that the route hash-verifies samples.
const OLD_TOM = readFileSync("public/samples/old-tom-clean.png");
const OCR_TEXT = { data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } };

function request(
  overrides: {
    files?: Array<{ name?: string; type?: string; bytes?: Uint8Array }>;
    applications?: unknown[];
    applicationsRaw?: string;
    source?: string;
    devTier?: string;
    devBedrockModel?: string;
    escalate?: string;
    ip?: string;
  } = {},
) {
  const fd = new FormData();
  const files = overrides.files ?? [{}];
  let totalBytes = 0;
  for (const file of files) {
    const bytes = file.bytes ?? TRUNCATED_PNG;
    totalBytes += bytes.length;
    fd.append(
      "images",
      new File([new Uint8Array(bytes)], file.name ?? "old-tom-clean.png", { type: file.type ?? "image/png" }),
    );
  }
  fd.set("applications", overrides.applicationsRaw ?? JSON.stringify(overrides.applications ?? files.map(() => app)));
  if (overrides.source !== undefined) fd.set("source", overrides.source);
  if (overrides.devTier !== undefined) fd.set("devTier", overrides.devTier);
  if (overrides.devBedrockModel !== undefined) fd.set("devBedrockModel", overrides.devBedrockModel);
  if (overrides.escalate !== undefined) fd.set("escalate", overrides.escalate);

  // Node's Request doesn't set Content-Length for a FormData body in tests. Provide an approximate
  // value so the route's Content-Length precheck sees what the real HTTP layer would send.
  const contentLength = String(totalBytes + 1024);
  return {
    headers: {
      get: (k: string) => {
        const key = k.toLowerCase();
        if (key === "content-length") return contentLength;
        // Unset by default so the many pre-existing tests above all share the same "unknown"
        // rate-limit bucket (well under the default max); the rate-limit test passes a distinct ip.
        if (key === "x-forwarded-for") return overrides.ip ?? null;
        return null;
      },
    },
    formData: async () => fd,
  } as unknown as Request;
}

describe("POST /api/batch", () => {
  it("returns 400 for missing images", async () => {
    const fd = new FormData();
    fd.set("applications", JSON.stringify([app]));
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "1024" : null) },
      formData: async () => fd,
    } as unknown as Request;
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Missing the label images");
  });

  it("returns 400 for missing applications", async () => {
    const fd = new FormData();
    fd.append("images", new File([new Uint8Array(TRUNCATED_PNG)], "old-tom-clean.png", { type: "image/png" }));
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "1024" : null) },
      formData: async () => fd,
    } as unknown as Request;
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Missing the applications data");
  });

  it("returns 400 for mismatched images and applications count", async () => {
    const res = await POST(request({ files: [{}], applications: [app, app] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("must be a JSON array with one entry per image");
  });

  it("returns 400 for a batch larger than the 50-image limit", async () => {
    const res = await POST(request({ files: Array.from({ length: 51 }, (_, i) => ({ name: `image-${i}.png` })) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("at most 50 images");
  });

  it("returns 400 for applications data that is not valid JSON", async () => {
    const res = await POST(request({ applicationsRaw: "[{not json}]" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not valid JSON");
  });

  // The whole-request ceiling. Testable only now that it is 100 MB — at the old ~450 MB it sat above
  // Vercel's own body limit, so no request could reach it and no test could either.
  it("returns 413 when the declared request size exceeds the whole-batch ceiling", async () => {
    const fd = new FormData();
    fd.append("images", new File([new Uint8Array(TRUNCATED_PNG)], "a.png", { type: "image/png" }));
    fd.set("applications", JSON.stringify([app]));
    const req = {
      headers: {
        get: (k: string) => (k.toLowerCase() === "content-length" ? String(41 * 1024 * 1024) : null),
      },
      formData: async () => fd,
    } as unknown as Request;
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("40 MB");
  });

  it("accepts a request declared just under the ceiling", async () => {
    vi.stubEnv("VISION_PROVIDER", "mock");
    const fd = new FormData();
    fd.append("images", new File([new Uint8Array(OLD_TOM)], "old-tom-clean.png", { type: "image/png" }));
    fd.set("applications", JSON.stringify([app]));
    const req = {
      headers: {
        get: (k: string) => (k.toLowerCase() === "content-length" ? String(39 * 1024 * 1024) : null),
      },
      formData: async () => fd,
    } as unknown as Request;
    expect((await POST(req)).status).toBe(200);
  });

  it("reports an unsupported image type as a per-item error, not a batch failure", async () => {
    const res = await POST(request({ files: [{ type: "application/pdf" }] }));
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].error).toContain("Unsupported format");
  });

  it("reports a payload whose bytes are not the declared image type as a per-item error", async () => {
    const res = await POST(request({ files: [{ bytes: new Uint8Array(8) }] }));
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].error).toContain("does not match");
  });

  it("reports an empty file as a per-item error", async () => {
    const res = await POST(request({ files: [{ name: "empty.png", bytes: new Uint8Array(0) }] }));
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].error).toContain("non-empty");
  });

  // The decompression-bomb guard: 6000x5000 = 30 MP, past MAX_PIXELS, but only 407 KB on the wire,
  // so it sails through the byte-size check and must be stopped on dimensions instead.
  it("reports an image over the megapixel limit as a per-item error", async () => {
    const huge = await sharp({
      create: { width: 6000, height: 5000, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    expect(huge.length).toBeLessThan(8 * 1024 * 1024);
    const res = await POST(request({ files: [{ name: "huge.png", bytes: huge }] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].error).toContain("megapixels");
    expect(body.results[0].tier).toBe("unknown");
  });

  it("returns batch results for a valid request", async () => {
    vi.stubEnv("VISION_PROVIDER", "mock");
    const res = await POST(request({ files: [{ bytes: OLD_TOM }], source: "sample" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].filename).toBe("old-tom-clean.png");
    expect(body.results[0].overall).toBe("APPROVED");
    expect(typeof body.totalMs).toBe("number");
  });

  it("processes multiple images in one batch", async () => {
    vi.stubEnv("VISION_PROVIDER", "mock");
    const res = await POST(request({ files: [{ bytes: OLD_TOM }, { bytes: OLD_TOM }], source: "sample" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results[0].overall).toBe("APPROVED");
    expect(body.results[1].overall).toBe("APPROVED");
  });

  // Invariant 7: one bad label never aborts a batch.
  it("fails per item, not per batch", async () => {
    const res = await POST(
      request({
        files: [
          { name: "old-tom-clean.png", bytes: OLD_TOM },
          { name: "bad-image.png", bytes: TRUNCATED_PNG },
        ],
        source: "sample",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results[0].overall).toBe("APPROVED");
    expect(body.results[0].error).toBeUndefined();
    expect(body.results[1].error).toContain("Could not read this image");
    // An unprocessable item is NEEDS_CORRECTION with fail-closed placeholders — never REJECTED
    // (a regulatory finding on a label we never examined) and never a partial verdict.
    expect(body.results[1].overall).toBe("NEEDS_CORRECTION");
    expect(body.results[1].tier).toBe("unknown");
  });

  // Invariant 7, the hard case. `throw null` survives verifyOne's own catch: that catch does a
  // property access on the thrown value, which itself throws on null. The worker's promise then
  // rejects, `results` keeps a hole, the strict response schema rejects it, and one unlucky item
  // becomes a 500 for the whole batch. The good row must still come back.
  it("keeps the batch alive when one item throws something verifyOne cannot catch", async () => {
    vi.stubEnv("VISION_PROVIDER", "mock");
    const good = new File([new Uint8Array(OLD_TOM)], "old-tom-clean.png", { type: "image/png" });
    const poisoned = new File([new Uint8Array(OLD_TOM)], "poisoned.png", { type: "image/png" });
    Object.defineProperty(poisoned, "arrayBuffer", {
      value: () => {
        throw null;
      },
    });
    const fd = new FormData();
    fd.append("images", good);
    fd.append("images", poisoned);
    fd.set("applications", JSON.stringify([app, app]));
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "4096" : null) },
      formData: async () => fd,
    } as unknown as Request;

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results[0].filename).toBe("old-tom-clean.png");
    expect(body.results[0].overall).toBe("APPROVED");
    expect(body.results[1].filename).toBe("poisoned.png");
    expect(body.results[1].overall).toBe("NEEDS_CORRECTION");
    expect(body.results[1].error).toBeTruthy();
  });

  it("routes a genuine bundled sample to the mock tier (source=sample)", async () => {
    const res = await POST(request({ files: [{ bytes: OLD_TOM }], source: "sample" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].provider).toBe("mock");
    expect(body.results[0].tier).toBe("mock");
    expect(body.results[0].overall).toBe("APPROVED");
  });

  // The trusted-sample gate: `source` and the filename are both client-controlled, so claiming
  // source=sample with a bundled filename must NOT buy mock-tier fixture data for other artwork —
  // that would turn arbitrary uploads into a fabricated APPROVED. Only the sample's own bytes do.
  it("denies mock-tier routing when the bytes are not the genuine sample the filename claims", async () => {
    vi.stubEnv("VISION_PROVIDER", "local-ocr");
    mockRecognize.mockResolvedValue(OCR_TEXT);
    const impostor = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const res = await POST(request({ files: [{ name: "old-tom-clean.png", bytes: impostor }], source: "sample" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].provider).not.toBe("mock");
    expect(body.results[0].tier).toBe("local-ocr");
    // The impostor was read for real, so it cannot inherit the sample fixture's health warning:
    // the field is absent here and flagged NEEDS_CORRECTION. (Absent is NEEDS_CORRECTION, never NON_COMPLIANT — invariant 3
    // — so `overall` is still APPROVED with three fields left for a human. That is the designed
    // fail-closed behaviour, and it is why "not APPROVED" would be the wrong thing to assert.)
    const warningField = body.results[0].fields.find((f: { field: string }) => f.field === "healthWarningStatement");
    expect(warningField.verdict).toBe("NEEDS_CORRECTION");
    expect(body.results[0].warnings).toEqual(expect.arrayContaining([expect.stringMatching(/local ocr/i)]));
  });

  // An unrecognized devTier must be ignored (falling back to auto-detection), never forwarded to
  // provider lookup — otherwise a client string would choose the extraction backend.
  it("ignores an unrecognized devTier instead of routing to it", async () => {
    const res = await POST(request({ files: [{ bytes: OLD_TOM }], source: "sample", devTier: "gemini" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].provider).toBe("mock");
    expect(body.results[0].error).toBeUndefined();
  });

  // Workers finish out of order, so the route writes results by index. Here the first image's OCR
  // deliberately resolves last: with results pushed in completion order, row 0 would be "second.png"
  // and every row would be paired with the wrong application.
  it("returns results in image order even when items finish out of order", async () => {
    vi.stubEnv("VISION_PROVIDER", "local-ocr");
    mockRecognize
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return OCR_TEXT;
      })
      .mockImplementation(async () => OCR_TEXT);
    const res = await POST(
      request({
        files: [
          { name: "first.png", bytes: OLD_TOM },
          { name: "second.png", bytes: OLD_TOM },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { filename: string }) => r.filename)).toEqual(["first.png", "second.png"]);
  });

  // 12 items against CONCURRENCY = 5, so each worker drains several from the shared queue — the
  // `while (queue.length > 0)` loop that a 1- or 2-item batch never enters. Two items are unreadable
  // and sit at interior positions, so a dropped or reordered row shows up as a mispairing rather
  // than just a wrong count. Each application carries its own brand name, which is what proves
  // image[i] was verified against application[i] and not merely that 12 rows came back.
  it("drains a batch larger than the concurrency limit, keeping every row paired with its application", async () => {
    vi.stubEnv("VISION_PROVIDER", "mock");
    const names = [
      "old-tom-clean.png",
      "copper-kettle-gin.png",
      "ridge-creek-table-wine.png",
      "unreadable-a.png", // index 3 — PNG signature only, fails the sharp metadata read
      "harbor-point-lager.png",
      "kirkbride-import-wine.png",
      "title-case-warning.png",
      "wrong-abv.png",
      "wrong-brand.png",
      "unreadable-b.png", // index 9
      "altered-warning.png",
      "all-caps-warning.png",
    ];
    const broken = new Set([3, 9]);
    const res = await POST(
      request({
        files: names.map((name, i) => ({ name, bytes: broken.has(i) ? TRUNCATED_PNG : OLD_TOM })),
        applications: names.map((_, i) => ({ ...app, brandName: `BRAND ${i}` })),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.results).toHaveLength(12);
    expect(body.results.map((r: { filename: string }) => r.filename)).toEqual(names);

    for (const [i, row] of body.results.entries()) {
      if (broken.has(i)) {
        expect(row.error).toContain("Could not read this image");
        continue;
      }
      expect(row.error).toBeUndefined();
      const brand = row.fields.find((f: { field: string }) => f.field === "brandName");
      expect(brand.applicationValue).toBe(`BRAND ${i}`);
    }
  });

  // Nested here (not after the rate-limit-exhaustion tests below) for the same reason as
  // app/api/verify/route.test.ts: those tests drive the shared "unknown" bucket to its cap and it
  // doesn't refill within a test run, so a later test that doesn't pass its own trusted IP would
  // spuriously 429.
  describe("POST /api/batch — DEV_CONTROLS_ENABLED gates dev-only fields (D8c, 2026-07-25)", () => {
    it("in production without DEV_CONTROLS_ENABLED, a devTier field is rejected with 400", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const res = await POST(request({ files: [{ bytes: OLD_TOM }], devTier: "local-ocr" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/developer controls/i);
    });
    it("in production without DEV_CONTROLS_ENABLED, devBedrockModel and escalate fields are rejected with 400", async () => {
      vi.stubEnv("NODE_ENV", "production");
      expect((await POST(request({ files: [{ bytes: OLD_TOM }], devBedrockModel: "haiku" }))).status).toBe(400);
      expect((await POST(request({ files: [{ bytes: OLD_TOM }], escalate: "1" }))).status).toBe(400);
    });
    it("in production WITH DEV_CONTROLS_ENABLED=1, devTier works exactly as in development", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("DEV_CONTROLS_ENABLED", "1");
      mockRecognize.mockResolvedValue(OCR_TEXT);
      const res = await POST(request({ files: [{ bytes: OLD_TOM }], devTier: "local-ocr" }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.results[0].tier).toBe("local-ocr");
    });
    // Closing a gap the hardening branch left open (D8c review): the verify route already had this
    // case; the batch route did not, and an ungated batch endpoint would trivially bypass the
    // verify route's gate anyway (see the comment at the gate site in app/api/batch/route.ts).
    it("a production request with NONE of the three dev fields is unaffected by the gate", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const res = await POST(request({ files: [{ bytes: OLD_TOM }], source: "sample" }));
      expect(res.status).toBe(200);
      expect((await res.json()).results[0].error).toBeUndefined();
    });
  });

  // X-Forwarded-For is client-controlled, so by default (TRUST_PROXY_HEADERS unset) the route must
  // NOT key the limiter on it — every request shares one global bucket. Proven here by rotating the
  // header on every call, the way an attacker would to try to dodge a per-IP limit: it still 429s.
  it("returns 429 even when the caller rotates X-Forwarded-For on every request (header untrusted by default)", async () => {
    let res: Response | undefined;
    for (let i = 0; i < 61; i++) {
      res = await POST(request({ ip: `198.51.100.${i}` }));
    }
    expect(res!.status).toBe(429);
    expect(res!.headers.get("Retry-After")).toBeTruthy();
    expect((await res!.json()).error).toMatch(/rate limit/i);
  });

  // Opt-in: TRUST_PROXY_HEADERS=1 is for deployments that know their upstream proxy sets
  // X-Forwarded-For honestly — only then does a single IP get its own quota.
  it("returns 429 with Retry-After once a trusted IP's own quota is exceeded (TRUST_PROXY_HEADERS=1)", async () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    const ip = "203.0.113.99"; // dedicated to this test, unshared with the rotating-IP test above
    let res: Response | undefined;
    for (let i = 0; i < 61; i++) {
      res = await POST(request({ ip }));
    }
    expect(res!.status).toBe(429);
    expect(res!.headers.get("Retry-After")).toBeTruthy();
    expect((await res!.json()).error).toMatch(/rate limit/i);
  });
});
