import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TRACKED_CLIENTS, rateLimit } from "@/lib/rate-limit";

// Each test uses its own IP (or a fresh set of IPs) so the module-level `clients` map (no reset hook
// by design — this is a standalone singleton limiter) can't leak state between cases.
describe("rateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // Per-IP behavior only makes sense once the caller-supplied IP is trusted — the opt-in
  // TRUST_PROXY_HEADERS=1 path (see the trust-boundary doc comment in lib/rate-limit.ts). These
  // mirror the pre-hardening tests, now explicit about which mode they exercise.
  describe("with TRUST_PROXY_HEADERS=1 (per-IP mode)", () => {
    beforeEach(() => {
      vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    });

    it("allows requests while under the limit", () => {
      const ip = "allow-under-limit";
      for (let i = 0; i < 3; i++) {
        expect(rateLimit(ip, { max: 3, windowMs: 1000 })).toEqual({ ok: true });
      }
    });

    it("denies requests once the limit is exceeded, returning a positive retryAfter", () => {
      const ip = "deny-over-limit";
      expect(rateLimit(ip, { max: 2, windowMs: 1000 })).toEqual({ ok: true });
      expect(rateLimit(ip, { max: 2, windowMs: 1000 })).toEqual({ ok: true });

      const denied = rateLimit(ip, { max: 2, windowMs: 1000 });
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(denied.retryAfter).toBeGreaterThan(0);
        expect(denied.retryAfter).toBe(1); // ceil(windowMs / 1000) when denied at the same instant
      }
    });

    it("lets requests through again once the window has elapsed", () => {
      const ip = "window-expiry";
      expect(rateLimit(ip, { max: 1, windowMs: 1000 })).toEqual({ ok: true });
      expect(rateLimit(ip, { max: 1, windowMs: 1000 }).ok).toBe(false);

      vi.setSystemTime(1001); // just past the window
      expect(rateLimit(ip, { max: 1, windowMs: 1000 })).toEqual({ ok: true });
    });

    it("tracks separate IPs independently", () => {
      expect(rateLimit("ip-a", { max: 1, windowMs: 1000 })).toEqual({ ok: true });
      // A different IP has its own budget, unaffected by ip-a's usage.
      expect(rateLimit("ip-b", { max: 1, windowMs: 1000 })).toEqual({ ok: true });
      expect(rateLimit("ip-a", { max: 1, windowMs: 1000 }).ok).toBe(false);
    });

    it("falls back to the documented defaults (windowMs 60s, max 60) when opts are omitted", () => {
      const ip = "defaults";
      for (let i = 0; i < 60; i++) {
        expect(rateLimit(ip)).toEqual({ ok: true });
      }
      expect(rateLimit(ip).ok).toBe(false);
    });
  });

  // The default (TRUST_PROXY_HEADERS unset): X-Forwarded-For is an unauthenticated, client-supplied
  // value, so it must NOT buy a caller its own quota — every IP shares one bucket. This is the fix
  // for the finding that a spoofed/rotating header could otherwise defeat the limiter entirely.
  describe("without TRUST_PROXY_HEADERS (default, shared-bucket mode)", () => {
    // All tests in this block target the same shared key regardless of the IP passed in, so — unlike
    // the per-IP block above, where distinct IPs give each test a naturally isolated key — they'd
    // pollute each other's bucket if they all started at the same fake system time. Give each test
    // its own well-separated clock so any earlier test's timestamps have long since aged out.
    let clock = 10_000_000;
    beforeEach(() => {
      clock += 1_000_000;
      vi.setSystemTime(clock);
    });

    it("buckets distinct IPs into the same shared limit", () => {
      expect(rateLimit("1.1.1.1", { max: 2, windowMs: 1000 })).toEqual({ ok: true });
      // A different IP does NOT get its own budget — it competes for the same shared quota.
      expect(rateLimit("2.2.2.2", { max: 2, windowMs: 1000 })).toEqual({ ok: true });
      const denied = rateLimit("3.3.3.3", { max: 2, windowMs: 1000 });
      expect(denied.ok).toBe(false);
    });

    it('stays in shared-bucket mode even when TRUST_PROXY_HEADERS is set to something other than "1"', () => {
      vi.stubEnv("TRUST_PROXY_HEADERS", "true"); // only the literal "1" opts in
      expect(rateLimit("4.4.4.4", { max: 1, windowMs: 1000 })).toEqual({ ok: true });
      expect(rateLimit("5.5.5.5", { max: 1, windowMs: 1000 }).ok).toBe(false);
    });
  });

  // Env values are operator input and must fail safe: a nonsense or negative value must never
  // disable limiting (negative window), deny everything (negative max), or emit Retry-After: NaN.
  describe("env-var hardening", () => {
    beforeEach(() => {
      vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    });

    it("a negative RATE_LIMIT_MAX falls back to the default instead of denying everything", () => {
      vi.stubEnv("RATE_LIMIT_MAX", "-1");
      const denied = rateLimit("env-negative-max");
      expect(denied).toEqual({ ok: true });
    });

    it("a negative RATE_LIMIT_WINDOW_MS falls back to the default instead of disabling limiting", () => {
      vi.stubEnv("RATE_LIMIT_WINDOW_MS", "-1");
      vi.stubEnv("RATE_LIMIT_MAX", "1");
      expect(rateLimit("env-negative-window")).toEqual({ ok: true });
      const denied = rateLimit("env-negative-window");
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(Number.isFinite(denied.retryAfter)).toBe(true);
        expect(denied.retryAfter).toBeGreaterThan(0);
      }
    });

    it("a non-numeric RATE_LIMIT_MAX falls back to the default and never yields Retry-After NaN", () => {
      vi.stubEnv("RATE_LIMIT_MAX", "sixty");
      for (let i = 0; i < 60; i++) {
        expect(rateLimit("env-non-numeric")).toEqual({ ok: true });
      }
      const denied = rateLimit("env-non-numeric");
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(Number.isFinite(denied.retryAfter)).toBe(true);
    });
  });

  // Trusted-proxy mode must not let distinct source IPs grow the clients map without bound (memory
  // DoS via IP churn): once the map is at capacity, NEW ips are lumped into the shared bucket, which
  // still rate-limits them collectively, while established entries keep their own quotas.
  describe("with TRUST_PROXY_HEADERS=1, map growth is bounded", () => {
    beforeEach(() => {
      vi.stubEnv("TRUST_PROXY_HEADERS", "1");
      vi.setSystemTime(50_000_000);
    });

    it("new IPs beyond the tracking cap share one bucket instead of growing the map", () => {
      const windowMs = 100_000;
      // Exactly fill the cap — going past it would land overflow traffic in the shared bucket and
      // consume the very budget the late arrivals below are asserting on.
      for (let i = 0; i < MAX_TRACKED_CLIENTS; i++) {
        rateLimit(`flood-${i}`, { max: 5, windowMs });
      }
      // The map is full: two brand-new IPs must now compete for the SAME overflow budget.
      expect(rateLimit("late-arrival-a", { max: 1, windowMs })).toEqual({ ok: true });
      expect(rateLimit("late-arrival-b", { max: 1, windowMs }).ok).toBe(false);
    });
  });
});
