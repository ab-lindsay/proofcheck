import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "@/lib/security-headers";

describe("security headers", () => {
  it("locks down framing, plugins, and base-uri in the CSP", () => {
    const csp = contentSecurityPolicy(false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Own file preview (blob:) and inline data URIs must still render.
    expect(csp).toContain("img-src 'self' blob: data:");
  });

  it("does not allow 'unsafe-eval' in production", () => {
    expect(contentSecurityPolicy(false)).not.toContain("unsafe-eval");
  });

  it("allows 'unsafe-eval' in development so HMR works", () => {
    expect(contentSecurityPolicy(true)).toContain("'unsafe-eval'");
  });

  it("ships the standard hardening headers", () => {
    const h = Object.fromEntries(securityHeaders(false).map((x) => [x.key, x.value]));
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Content-Security-Policy"]).toContain("default-src 'self'");
  });
});
