import type { NextConfig } from "next";
import { securityHeaders } from "./lib/security-headers";

const nextConfig: NextConfig = {
  serverExternalPackages: ["tesseract.js", "sharp"],
  // Two assets that Next's automatic output file tracing cannot discover on its own, because
  // both are read at runtime via computed fs paths rather than a literal require/import:
  //  - assets/tessdata/**: the vendored eng.traineddata (lib/vision/local-ocr.ts) — without it,
  //    local-ocr falls back to fetching from the network on every cold start.
  //  - tesseract.js-core's .wasm binaries: they're a TRANSITIVE dependency (only tesseract.js is
  //    a direct one), so pnpm keeps them under node_modules/.pnpm with no top-level symlink, and
  //    tracing misses the .wasm file each Emscripten glue module loads next to itself. Confirmed
  //    in production (2026-07-26): every request crashed with
  //    "ENOENT ... tesseract-core-relaxedsimd.wasm" inside the tesseract worker thread — which
  //    never sends the worker a 'reject' message, so the request just rides out the full 8 s
  //    EXTRACT_TIMEOUT_MS and surfaces as a generic "took too long" timeout, not the real error.
  //    Globbed (not a pinned version) so a tesseract.js-core bump doesn't silently break this again.
  outputFileTracingIncludes: {
    "/api/verify": ["./assets/tessdata/**", "./node_modules/.pnpm/tesseract.js-core*/**/*.wasm"],
    "/api/batch": ["./assets/tessdata/**", "./node_modules/.pnpm/tesseract.js-core*/**/*.wasm"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
};

export default nextConfig;
