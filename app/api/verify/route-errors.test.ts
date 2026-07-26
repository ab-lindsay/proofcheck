// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_FIXTURES } from "@/lib/vision/mock";

const cloudExtract = vi.fn();
const ocrExtract = vi.fn();
vi.mock("@/lib/vision/select", () => ({
  selectProvider: () => ({ name: "gemini", extract: cloudExtract }),
  // The route always constructs a withFallback(withProviderTimeout(primary, 6s),
  // providerByName("local-ocr")) wrapper for any auto-detected cloud-tier provider (D3, 2026-07-25
  // hardening), so providerByName must exist even in tests that don't exercise the fallback path.
  // A SEPARATE mock from the primary's lets the D3 test below give the two DIFFERENT behavior
  // (primary hangs, fallback succeeds); the pre-existing tests below instead deliberately give
  // both the SAME behavior so a primary failure propagates through the fallback attempt too,
  // preserving their original intent.
  providerByName: () => ({ name: "local-ocr", extract: ocrExtract }),
  selectCloudProvider: () => null,
}));
// Isolate these tests to the extraction step: stub the raster guard's metadata() so it resolves
// instantly (no native libvips async) and never races the fake-timer clock in the timeout test.
vi.mock("sharp", () => ({
  default: () => ({ metadata: async () => ({ width: 2, height: 2 }) }),
}));

import { POST } from "@/app/api/verify/route";

// A real, decodable 2×2 PNG — the route hard-rejects undecodable uploads before selecting a tier, so
// these failure-mode tests (which exercise the tier's extract()) need a valid image to reach it.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgEpHjEpFjgFAABk4A8YCCZIUAAAAASUVORK5CYII=",
  "base64",
);

function request(overrides?: { devBedrockModel?: string }) {
  const fd = new FormData();
  fd.set("image", new File([new Uint8Array(PNG_BYTES)], "upload.png", { type: "image/png" }));
  fd.set(
    "application",
    JSON.stringify({
      beverageType: "distilled-spirits",
      brandName: "X",
      classType: "Vodka",
      alcoholContent: "40% Alc./Vol.",
      netContents: "750 mL",
    }),
  );
  if (overrides?.devBedrockModel !== undefined) fd.set("devBedrockModel", overrides.devBedrockModel);
  const contentLength = String(PNG_BYTES.length + 1024);
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? contentLength : null) },
    formData: async () => fd,
  } as unknown as Request;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("POST /api/verify — failure modes", () => {
  it("maps provider 429s to a friendly rate-limit message", async () => {
    const err = Object.assign(new Error("quota"), { status: 429 });
    cloudExtract.mockRejectedValue(err);
    ocrExtract.mockRejectedValue(err);
    const res = await POST(request());
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/rate-limited/i);
  });
  // The fake-timer tests below drive real async route work (formData, sharp metadata, the deadline race)
  // between clock advances. Under a saturated full-suite run that real work can exceed Vitest's default
  // 5s test wall-clock even though the logic is sound — the intermittent "timed out in 5000ms" flake.
  // A generous per-test timeout removes the load sensitivity without weakening the assertions.
  it("times out with a friendly 504 when even the fallback can't beat the deadline", async () => {
    vi.useFakeTimers();
    cloudExtract.mockImplementation(() => new Promise(() => {}));
    ocrExtract.mockImplementation(() => new Promise(() => {})); // fallback ALSO hangs — this pins the OUTER 8s backstop, not the D3 fallback path
    const pending = POST(request());
    await vi.advanceTimersByTimeAsync(9_000);
    const res = await pending;
    expect(res.status).toBe(504);
    expect((await res.json()).error).toMatch(/took too long/i);
  }, 20_000);
  it("clears the deadline timer when extraction resolves (no leaked timer)", async () => {
    vi.useFakeTimers();
    cloudExtract.mockResolvedValue(MOCK_FIXTURES["old-tom-clean.png"]);
    await POST(request());
    expect(vi.getTimerCount()).toBe(0);
  }, 20_000);
  it("degrades to local-ocr within the route timeout when the PRIMARY cloud provider hangs (D3, 2026-07-25 — not a 504)", async () => {
    vi.useFakeTimers();
    cloudExtract.mockImplementation(() => new Promise(() => {})); // never resolves
    ocrExtract.mockResolvedValue(MOCK_FIXTURES["old-tom-clean.png"]);
    const pending = POST(request());
    // Past the 6s CLOUD_PRIMARY_TIMEOUT_MS composition-site cap, well under the 8s outer backstop.
    await vi.advanceTimersByTimeAsync(7_000);
    const res = await pending;
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tier).toBe("local-ocr");
    expect(body.provider).toBe("local-ocr");
  }, 20_000);

  it("an explicit devBedrockModel override is exempt from the cloud-primary cap — a slow model finishes instead of degrading (D3 review)", async () => {
    vi.useFakeTimers();
    cloudExtract.mockImplementation(
      () => new Promise((res) => setTimeout(() => res(MOCK_FIXTURES["old-tom-clean.png"]), 6_500)),
    );
    const pending = POST(request({ devBedrockModel: "opus" }));
    await vi.advanceTimersByTimeAsync(6_600);
    const res = await pending;
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.provider).toBe("gemini"); // the mocked primary finished; no local-ocr degradation
  }, 20_000);
});
