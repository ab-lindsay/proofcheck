// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";

// Mock tesseract.js so the local-ocr-tier tests below (JPEG/WebP magic-byte acceptance, the OCR
// warning) never touch a real worker — no eng.traineddata download, no /tmp cache path dependency.
// Mirrors lib/vision/local-ocr.test.ts's mocking convention. None of this file's other tests reach
// local-ocr (they use the mock tier via genuine sample bytes, or fail before provider selection).
const mockRecognize = vi.fn();
vi.mock("tesseract.js", () => ({
  createWorker: async () => ({ recognize: mockRecognize, setParameters: vi.fn().mockResolvedValue(undefined) }),
  PSM: { SINGLE_COLUMN: "4" },
}));

import { GET, POST } from "@/app/api/verify/route";
import { MOCK_FIXTURES } from "@/lib/vision/mock";

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

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Genuine bundled-sample bytes — required for the mock tier now that the route hash-verifies samples.
const OLD_TOM = readFileSync("public/samples/old-tom-clean.png");
const TITLE_CASE = readFileSync("public/samples/title-case-warning.png");

function request(
  overrides: {
    filename?: string;
    type?: string;
    size?: number;
    application?: string;
    magic?: number[];
    source?: string;
    bytes?: Uint8Array;
    devTier?: string;
    devBedrockModel?: string;
    escalate?: string;
    ip?: string;
  } = {},
) {
  const fd = new FormData();
  let bytes = overrides.bytes;
  if (!bytes) {
    bytes = new Uint8Array(overrides.size ?? 64);
    bytes.set(overrides.magic ?? PNG_MAGIC, 0);
  }
  fd.set(
    "image",
    new File([new Uint8Array(bytes)], overrides.filename ?? "old-tom-clean.png", {
      type: overrides.type ?? "image/png",
    }),
  );
  fd.set("application", overrides.application ?? JSON.stringify(app));
  if (overrides.source !== undefined) fd.set("source", overrides.source);
  if (overrides.devTier !== undefined) fd.set("devTier", overrides.devTier);
  if (overrides.devBedrockModel !== undefined) fd.set("devBedrockModel", overrides.devBedrockModel);
  if (overrides.escalate !== undefined) fd.set("escalate", overrides.escalate);

  // Node.js new Request() with FormData doesn't set Content-Length in the test environment.
  // Provide an approximate value so the route's Content-Length precheck works — this mirrors
  // what the real HTTP layer does in production.
  const contentLength = String(bytes.length + 1024);
  return {
    headers: {
      get: (k: string) => {
        const key = k.toLowerCase();
        if (key === "content-length") return contentLength;
        // NOTE the limiter's real bucketing: with TRUST_PROXY_HEADERS unset (this suite), the ip is
        // DISCARDED and every request in the whole file shares one "__all__" bucket — a distinct ip
        // does not isolate a test. The suite stays green only because its total request count sits
        // under the default max per window; rate-limit-specific tests must stub TRUST_PROXY_HEADERS=1
        // (per-IP isolation) or pass explicit low limits.
        if (key === "x-forwarded-for") return overrides.ip ?? null;
        return null;
      },
    },
    formData: async () => fd,
  } as unknown as Request;
}

describe("POST /api/verify", () => {
  it("verifies a genuine bundled sample via the mock tier and PASSes (source=sample)", async () => {
    const res = await POST(request({ source: "sample", bytes: OLD_TOM }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("APPROVED");
    expect(body.tier).toBe("mock");
    expect(body.provider).toBe("mock");
    expect(typeof body.processingMs).toBe("number");
  });
  it("FAILs the title-case warning sample (source=sample)", async () => {
    const res = await POST(request({ filename: "title-case-warning.png", source: "sample", bytes: TITLE_CASE }));
    const body = await res.json();
    expect(body.overall).toBe("REJECTED");
  });

  // Idempotence across the dev-mode toggle: dev mode sends a devTier on every request, and its
  // default is "auto". "auto" must route identically to sending no devTier at all, or merely
  // enabling dev mode would silently re-extract bundled samples for real and change their verdicts
  // away from the outcomes the sample gallery advertises.
  it("routes devTier=auto exactly like no devTier — genuine samples still use their fixtures", async () => {
    const withAuto = await POST(request({ source: "sample", bytes: OLD_TOM, devTier: "auto" }));
    const withNone = await POST(request({ source: "sample", bytes: OLD_TOM }));
    const [a, n] = [await withAuto.json(), await withNone.json()];
    expect(a.tier).toBe("mock");
    expect(a.provider).toBe("mock");
    expect(a.overall).toBe(n.overall);
    expect(a.fields.map((f: { field: string; verdict: string }) => [f.field, f.verdict])).toEqual(
      n.fields.map((f: { field: string; verdict: string }) => [f.field, f.verdict]),
    );
  });

  it("keeps the title-case sample FAILing under devTier=auto", async () => {
    const res = await POST(
      request({ filename: "title-case-warning.png", source: "sample", bytes: TITLE_CASE, devTier: "auto" }),
    );
    const body = await res.json();
    expect(body.overall).toBe("REJECTED");
    expect(body.tier).toBe("mock");
  });
  it("rejects unsupported image types with 400", async () => {
    const res = await POST(request({ type: "application/pdf" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/PNG, JPEG, or WebP/);
  });
  it("rejects invalid application JSON with 400", async () => {
    const res = await POST(request({ application: "{not json" }));
    expect(res.status).toBe(400);
  });
  it("rejects a request missing the application field with 400", async () => {
    const fd = new FormData();
    fd.set("image", new File([new Uint8Array(PNG_MAGIC)], "old-tom-clean.png", { type: "image/png" }));
    // No "application" field set at all — distinct from the invalid-JSON case above.
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "2048" : null) },
      formData: async () => fd,
    } as unknown as Request;
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/missing the label image or the application data/i);
  });
  it("rejects oversized uploads with 413", async () => {
    const res = await POST(request({ size: 9 * 1024 * 1024 }));
    expect(res.status).toBe(413);
  });
  it("rejects an empty file with 400", async () => {
    const res = await POST(request({ size: 0, magic: [] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/non-empty/i);
  });
  it("rejects a payload whose bytes are not the declared image type", async () => {
    const res = await POST(request({ magic: [0, 0, 0, 0, 0, 0, 0, 0] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not match/);
  });
  it("fails closed (never a fabricated APPROVED) when VISION_PROVIDER=mock is set in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VISION_PROVIDER", "mock");
    const res = await POST(request({ bytes: OLD_TOM, source: "sample" }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await res.json()).overall).toBeUndefined();
  });
  it("echoes the beverageType in the response (for per-field regulation citations)", async () => {
    const res = await POST(request({ source: "sample", bytes: OLD_TOM }));
    const body = await res.json();
    expect(body.beverageType).toBe("distilled-spirits");
  });
  it("accepts a genuine JPEG upload (magic-byte sniff) and completes verification", async () => {
    vi.stubEnv("VISION_PROVIDER", "local-ocr");
    mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } });
    const jpegBytes = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 150, b: 100 } },
    })
      .jpeg()
      .toBuffer();
    const res = await POST(request({ filename: "upload.jpg", type: "image/jpeg", bytes: jpegBytes }));
    expect(res.status).toBe(200);
    expect((await res.json()).tier).toBe("local-ocr");
  });
  it("accepts a genuine WebP upload (magic-byte sniff) and completes verification", async () => {
    vi.stubEnv("VISION_PROVIDER", "local-ocr");
    mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } });
    const webpBytes = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 150, b: 100 } },
    })
      .webp()
      .toBuffer();
    const res = await POST(request({ filename: "upload.webp", type: "image/webp", bytes: webpBytes }));
    expect(res.status).toBe(200);
    expect((await res.json()).tier).toBe("local-ocr");
  });
  it("appends an OCR-accuracy warning when the local-ocr tier is used", async () => {
    vi.stubEnv("VISION_PROVIDER", "local-ocr");
    mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } });
    const res = await POST(request({ bytes: OLD_TOM }));
    const body = await res.json();
    expect(body.tier).toBe("local-ocr");
    expect(body.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/local ocr/i)]));
  });

  it("devTier=local-ocr bypasses auto-detection even when a cloud key is configured", async () => {
    // The test's ability to discriminate depends on three pieces, not just the key — the key, the
    // fetch stub, and DEV_CONTROLS_ENABLED. Without the stub a real bedrock call fails and
    // withFallback reports local-ocr anyway (the assertions pass for the wrong reason); without the
    // env the devTier is ignored and we get the same false-pass. Both are needed to genuinely test
    // the branch exists and does what its name says.
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    vi.stubEnv("DEV_CONTROLS_ENABLED", "1");
    const bedrockText = JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ output: { message: { content: [{ text: bedrockText }] } } }),
      }),
    );
    mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } });
    const res = await POST(request({ bytes: OLD_TOM, devTier: "local-ocr" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tier).toBe("local-ocr");
    expect(body.provider).toBe("local-ocr");
  });

  it("devTier=local-llm bypasses auto-detection and routes to Ollama", async () => {
    vi.stubEnv("DEV_CONTROLS_ENABLED", "1");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]) } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(request({ bytes: OLD_TOM, devTier: "local-llm" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tier).toBe("local-llm");
    expect(body.provider).toBe("local-llm");
  });

  it("devTier=local-llm returns a clear error naming Ollama when the call fails", async () => {
    vi.stubEnv("DEV_CONTROLS_ENABLED", "1");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const res = await POST(request({ bytes: OLD_TOM, devTier: "local-llm" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/ollama/i);
  });

  it("devTier=cloud with a key configured uses the cloud provider", async () => {
    // Bedrock is a plain fetch() call with no SDK in front of it that could retry/reshape a
    // rejection internally — a raw-fetch provider keeps this test's mock predictable.
    vi.stubEnv("DEV_CONTROLS_ENABLED", "1");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    const text = JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ output: { message: { content: [{ text }] } } }),
        text: async () => "",
      }),
    );
    const res = await POST(request({ bytes: OLD_TOM, devTier: "cloud" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tier).toBe("cloud");
    expect(body.provider).toBe("bedrock");
  });

  it("devTier=cloud with nothing configured returns a clear 400", async () => {
    vi.stubEnv("DEV_CONTROLS_ENABLED", "1");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    const res = await POST(request({ bytes: OLD_TOM, devTier: "cloud" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cloud tier requires an api key/i);
  });

  it("falls back to local-ocr and adds a warning when the cloud call fails", async () => {
    vi.stubEnv("DEV_CONTROLS_ENABLED", "1");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("cloud down")));
    const res = await POST(request({ bytes: OLD_TOM, devTier: "cloud" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    // Review 2026-07-25: `provider`/`tier` must report the tier that ACTUALLY produced the
    // extraction, not the primary's static name — local-ocr ran here, so the response must say so
    // (the old behavior kept reporting "bedrock"/"cloud" on a fallen-back response, which is the
    // exact misattribution the fallback-over-escalation composition fix corrects).
    expect(body.provider).toBe("local-ocr");
    expect(body.tier).toBe("local-ocr");
    expect(body.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/fell back to local ocr/i)]));
  });

  it("an invalid devTier value is ignored and falls back to normal auto-detection", async () => {
    vi.stubEnv("VISION_PROVIDER", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } });
    const res = await POST(request({ bytes: OLD_TOM, devTier: "not-a-real-tier" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tier).toBe("local-ocr");
  });

  it("devBedrockModel=opus routes to the Opus model ID when bedrock tier is active", async () => {
    vi.stubEnv("DEV_CONTROLS_ENABLED", "1");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    const text = JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ output: { message: { content: [{ text }] } } }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(request({ bytes: OLD_TOM, devTier: "cloud", devBedrockModel: "opus" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.provider).toBe("bedrock");
    expect(fetchMock.mock.calls[0][0]).toContain("us.anthropic.claude-opus-4-5-20251101-v1%3A0");
  });

  it("devBedrockModel=haiku routes to the Haiku model ID when bedrock tier is active", async () => {
    vi.stubEnv("DEV_CONTROLS_ENABLED", "1");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    const text = JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ output: { message: { content: [{ text }] } } }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(request({ bytes: OLD_TOM, devTier: "cloud", devBedrockModel: "haiku" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.provider).toBe("bedrock");
    expect(fetchMock.mock.calls[0][0]).toContain("us.anthropic.claude-haiku-4-5-20251001-v1%3A0");
  });

  it("falls back to BEDROCK_MODEL env when devBedrockModel is absent", async () => {
    vi.stubEnv("DEV_CONTROLS_ENABLED", "1");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    vi.stubEnv("BEDROCK_MODEL", "env-model");
    const text = JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ output: { message: { content: [{ text }] } } }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(request({ bytes: OLD_TOM, devTier: "cloud" }));
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toContain("env-model");
  });

  it("falls back to BEDROCK_MODEL env when devBedrockModel is malformed", async () => {
    vi.stubEnv("DEV_CONTROLS_ENABLED", "1");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    vi.stubEnv("BEDROCK_MODEL", "env-model");
    const text = JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ output: { message: { content: [{ text }] } } }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(request({ bytes: OLD_TOM, devTier: "cloud", devBedrockModel: "invalid-model" }));
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toContain("env-model");
  });

  // Nested here (not appended after the rate-limit-exhaustion tests below) deliberately: those tests
  // drive the shared "unknown" bucket to its 60-request cap and it doesn't refill within a test run,
  // so any later test that doesn't pass its own trusted IP would spuriously 429. Running this block
  // first keeps it on the still-fresh bucket, matching how every other non-rate-limit test in this
  // file behaves.
  describe("POST /api/verify — DEV_CONTROLS_ENABLED gates dev-only fields (D8c, 2026-07-25)", () => {
    it("in production without DEV_CONTROLS_ENABLED, a devTier field is rejected with 400", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const res = await POST(request({ bytes: OLD_TOM, devTier: "local-ocr" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/developer controls/i);
    });
    it("in production without DEV_CONTROLS_ENABLED, a devBedrockModel field is rejected with 400", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const res = await POST(request({ bytes: OLD_TOM, devBedrockModel: "haiku" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/developer controls/i);
    });
    it("in production without DEV_CONTROLS_ENABLED, an escalate field is rejected with 400", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const res = await POST(request({ bytes: OLD_TOM, escalate: "1" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/developer controls/i);
    });
    it("in production WITH DEV_CONTROLS_ENABLED=1, devTier works exactly as in development", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("DEV_CONTROLS_ENABLED", "1");
      mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } });
      const res = await POST(request({ bytes: OLD_TOM, devTier: "local-ocr" }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.tier).toBe("local-ocr");
    });
    it("a production request with NONE of the three dev fields is unaffected by the gate", async () => {
      vi.stubEnv("NODE_ENV", "production");
      // Isolate from CI's job-level VISION_PROVIDER=mock (set for every OTHER test's determinism):
      // combined with NODE_ENV=production it would trip the separate "VISION_PROVIDER=mock forbidden
      // in production" guard (lib/vision/select.ts) this test has nothing to do with — a real
      // production deploy never sets VISION_PROVIDER, so clearing it here matches reality.
      vi.stubEnv("VISION_PROVIDER", "");
      vi.stubEnv("GEMINI_API_KEY", "");
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("GROQ_API_KEY", "");
      vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
      mockRecognize.mockResolvedValue({ data: { text: "OLD TOM DISTILLERY\n750 mL", confidence: 80 } });
      const res = await POST(request({ bytes: OLD_TOM }));
      expect(res.status).toBe(200);
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
    const ip = "203.0.113.42"; // dedicated to this test, unshared with the rotating-IP test above
    let res: Response | undefined;
    for (let i = 0; i < 61; i++) {
      res = await POST(request({ ip }));
    }
    expect(res!.status).toBe(429);
    expect(res!.headers.get("Retry-After")).toBeTruthy();
    expect((await res!.json()).error).toMatch(/rate limit/i);
  });
});

describe("GET /api/verify", () => {
  it("returns cloudAvailable: true when a cloud key is configured", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    const res = await GET();
    expect((await res.json()).cloudAvailable).toBe(true);
  });

  it("returns cloudAvailable: false when no cloud key is configured", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    const res = await GET();
    expect((await res.json()).cloudAvailable).toBe(false);
  });
});
