/**
 * Minimal in-memory sliding-window rate limiter, keyed by client IP.
 *
 * Deliberately not distributed: separate serverless instances don't share this module's memory, so
 * under multiple concurrent instances the effective limit is per-instance, not global. That's an
 * accepted approximation for this prototype (see docs/ARCHITECTURE.md) — a real production
 * deployment would back this with a shared store (e.g. Upstash Redis) instead.
 *
 * Trust boundary: the `ip` argument comes from a client-controlled header (X-Forwarded-For) that
 * callers read before any trusted proxy has necessarily verified it. Nothing here validates that the
 * header was actually set by a trusted upstream, so keying the limiter on it unconditionally would
 * let a caller mint a fresh 60-request quota on every request just by sending a new fabricated value
 * — trivially defeating the whole feature. Instead, per-IP keying is opt-in via
 * `TRUST_PROXY_HEADERS=1`, for deployments that know their upstream (e.g. Vercel's edge) sets the
 * header honestly. The default is NOT to trust it: every request collapses onto one shared bucket
 * (`UNTRUSTED_KEY`), turning the limiter into a blunt global cap instead of a per-client one. That's
 * coarser, but it's real protection with zero configuration — it can't be spoofed away by forging a
 * header, and it also keeps `clients` from growing unboundedly under a flood of fake IPs (untrusted
 * mode never creates more than one map entry).
 *
 * Batch interaction: the /batch page fans out one /api/verify call per row, so in untrusted mode a
 * batch larger than `max` WILL see 429s mid-run — by design. The client side compensates:
 * use-batch.ts honors Retry-After with bounded retries, so an over-quota batch completes at the
 * limiter's pace instead of failing its remaining rows.
 */

interface RateLimitEntry {
  timestamps: number[];
}

interface RateLimitOpts {
  windowMs?: number;
  max?: number;
}

/** Exported so client-side pacing (hooks/use-batch.ts) can derive its dispatch rate from the same
 *  numbers instead of duplicating them — the two must stay in sync or client pacing silently drifts
 *  from what the server actually enforces. */
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX = 60;
/** Trusted-proxy mode only: hard cap on tracked per-IP entries (exported for the growth-bound test). */
export const MAX_TRACKED_CLIENTS = 10_000;
// Bucket key used whenever the caller-supplied IP is not trusted (the default — see module doc above).
const UNTRUSTED_KEY = "__all__";

const clients = new Map<string, RateLimitEntry>();
let lastSweepAt = 0;
const warnedEnvVars = new Set<string>();

/** Operator env input must fail safe: a zero, negative, or non-numeric value silently disabling
 *  limiting (negative window), denying everything (negative max), or emitting Retry-After: NaN is
 *  worse than ignoring it. Warn once per var so the misconfiguration is visible, then use the default. */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  if (!warnedEnvVars.has(name)) {
    warnedEnvVars.add(name);
    console.warn(`[rate-limit] Ignoring ${name}="${raw}" — expected a positive integer; using ${fallback}.`);
  }
  return fallback;
}

/** Amortized stale-entry eviction: at most one full-map sweep per window, so per-request work stays
 *  O(own entry) instead of O(all tracked IPs) — the full scan on every request made total work
 *  quadratic in distinct IPs per window under TRUST_PROXY_HEADERS=1. */
function sweep(windowMs: number, now: number) {
  if (now - lastSweepAt < windowMs) return;
  lastSweepAt = now;
  const cutoff = now - windowMs;
  for (const [key, entry] of clients) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) clients.delete(key);
  }
}

export function rateLimit(ip: string, opts: RateLimitOpts = {}): { ok: true } | { ok: false; retryAfter: number } {
  const windowMs = opts.windowMs ?? envPositiveInt("RATE_LIMIT_WINDOW_MS", DEFAULT_WINDOW_MS);
  const max = opts.max ?? envPositiveInt("RATE_LIMIT_MAX", DEFAULT_MAX);
  const now = Date.now();
  sweep(windowMs, now);

  let key = process.env.TRUST_PROXY_HEADERS === "1" ? ip : UNTRUSTED_KEY;
  // Trusted mode must not grow the map without bound under IP churn (memory DoS): once at capacity
  // (checked after the sweep, so stale entries don't count), NEW ips are lumped into the shared
  // bucket — still rate-limited, collectively — while established entries keep their own quotas.
  // Untrusted mode only ever has the one shared entry.
  if (!clients.has(key) && clients.size >= MAX_TRACKED_CLIENTS) key = UNTRUSTED_KEY;

  let entry = clients.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    clients.set(key, entry);
  }

  entry.timestamps = entry.timestamps.filter((t) => t > now - windowMs);

  if (entry.timestamps.length >= max) {
    const oldest = entry.timestamps[0];
    const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { ok: false, retryAfter };
  }

  entry.timestamps.push(now);
  return { ok: true };
}
