import { defineConfig } from "@playwright/test";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  // In CI, retry once and keep a trace of the retried run so a failure ships with a replayable
  // trace + screenshot (uploaded as an artifact) instead of an opaque red X.
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:3111",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Runs on the deterministic mock tier, which the app forbids under NODE_ENV=production
    // (lib/vision/select.ts — mock returns fabricated data, never allowed on a real deploy).
    // So the behavioral smoke uses `next dev`; the production build is boot-smoked separately in CI.
    command: "pnpm dev --port 3111",
    url: "http://localhost:3111",
    env: { VISION_PROVIDER: "mock" },
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
