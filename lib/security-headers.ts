// Baseline security headers applied to every response (wired in next.config.ts).
//
// No XSS sink exists today — all untrusted extracted text renders as auto-escaped React text nodes, and
// the only <img src> is a same-origin /samples/* path or a blob: URL of the user's own upload. These
// headers cap the blast radius of any *future* raw-HTML/URL sink and block clickjacking of the verify
// flow. See docs/security-audit-2026-07-21.md §2.
//
// NOTE on 'unsafe-inline' (script/style): Next.js App Router injects inline hydration scripts and inline
// styles, so a nonce-less CSP must permit inline to render at all. Given there is no HTML-injection sink,
// this is an accepted trade-off. A nonce-based policy would require: (1) middleware.ts to inject
// per-request nonces, (2) build-time nonce injection into the Next.js runtime, (3) removing
// 'unsafe-inline' — the documented future hardening step; see
// docs/superpowers/specs/2026-07-25-codebase-cleanup-design.md §6.

export function contentSecurityPolicy(isDev: boolean = process.env.NODE_ENV !== "production"): string {
  const scriptSrc = ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : [])]; // 'unsafe-eval' only for dev HMR
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function securityHeaders(isDev?: boolean): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(isDev) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "X-Frame-Options", value: "DENY" },
  ];
}
