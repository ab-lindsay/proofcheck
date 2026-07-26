// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { MOCK_FIXTURES } from "@/lib/vision/mock";

const cloudExtract = vi.fn();
const ocrExtract = vi.fn();
vi.mock("@/lib/vision/select", () => ({
  selectProvider: () => ({ name: "gemini", extract: cloudExtract }),
  providerByName: () => ({ name: "local-ocr", extract: ocrExtract }),
  selectCloudProvider: () => null,
}));
// Instant metadata so the raster guard never races the fake-timer clock (mirrors route-errors.test.ts).
vi.mock("sharp", () => ({
  default: () => ({ metadata: async () => ({ width: 2, height: 2 }) }),
}));

import { POST } from "@/app/api/batch/route";

// A real, decodable 2×2 PNG (same fixture as app/api/verify/route-errors.test.ts).
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgEpHjEpFjgFAABk4A8YCCZIUAAAAASUVORK5CYII=",
  "base64",
);

const app = {
  beverageType: "distilled-spirits",
  brandName: "X",
  classType: "Vodka",
  alcoholContent: "40% Alc./Vol.",
  netContents: "750 mL",
};

function request() {
  const fd = new FormData();
  fd.append("images", new File([new Uint8Array(PNG_BYTES)], "upload.png", { type: "image/png" }));
  fd.set("applications", JSON.stringify([app]));
  const contentLength = String(PNG_BYTES.length + 1024);
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? contentLength : null) },
    formData: async () => fd,
  } as unknown as Request;
}

describe("POST /api/batch — cloud-primary timeout (D3, 2026-07-25)", () => {
  it("degrades a hung cloud primary to local-ocr per row instead of erroring the row", async () => {
    vi.useFakeTimers();
    cloudExtract.mockImplementation(() => new Promise(() => {})); // never resolves
    ocrExtract.mockResolvedValue(MOCK_FIXTURES["old-tom-clean.png"]);
    const pending = POST(request());
    // Past the 6s CLOUD_PRIMARY_TIMEOUT_MS cap, under the outer per-row EXTRACT_TIMEOUT_MS.
    await vi.advanceTimersByTimeAsync(7_000);
    const res = await pending;
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results[0].tier).toBe("local-ocr");
    expect(body.results[0].error).toBeUndefined();
    vi.useRealTimers();
  }, 20_000);
});
