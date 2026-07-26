// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/verify/route";

// The fetch Request constructor forbids setting Content-Length, so exercise the precheck with a minimal
// stand-in. formData() throws to prove the guard returns BEFORE the body is buffered.
function oversizedRequest(): Request {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? String(13 * 1024 * 1024) : null) },
    formData: vi.fn(async () => {
      throw new Error("body must not be buffered when the declared size is over the cap");
    }),
  } as unknown as Request;
}

function missingContentLengthRequest(): Request {
  return {
    headers: { get: () => null },
    formData: vi.fn(async () => {
      throw new Error("body must not be buffered when Content-Length is absent");
    }),
  } as unknown as Request;
}

describe("POST /api/verify — request size precheck", () => {
  it("rejects an over-cap Content-Length with 413 without buffering the body", async () => {
    const req = oversizedRequest();
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large/i);
    expect(req.formData as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rejects a missing Content-Length in production with 413 without buffering the body", async () => {
    const original = process.env.NODE_ENV;
    vi.stubEnv("NODE_ENV", "production");
    try {
      const req = missingContentLengthRequest();
      const res = await POST(req);
      expect(res.status).toBe(413);
      expect((await res.json()).error).toMatch(/too large/i);
      expect(req.formData as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    } finally {
      vi.stubEnv("NODE_ENV", original);
    }
  });
});
