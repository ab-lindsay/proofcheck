import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "*.test.ts",
      "lib/**/*.test.{ts,tsx}",
      "components/**/*.test.tsx",
      "hooks/**/*.test.ts",
      "app/**/*.test.{ts,tsx}",
      "eval/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      // Gate only the deterministic core — the invariant is that every verdict comes from these
      // pure, fully-tested functions ("extraction proposes, matching disposes"). UI/adapters are
      // covered by component/adapter tests but not held to a hard bar here.
      include: ["lib/matching/**/*.ts", "lib/ttb/**/*.ts"],
      exclude: ["**/*.test.ts"],
      // Thresholds calibrated just below the current suite (functions must stay at 100% — no dead
      // functions in the core); CI fails if coverage of the matcher/TTB logic regresses. The small
      // headroom on statements/branches/lines is for genuinely-unreachable defensive guards, not slack.
      thresholds: { statements: 97, branches: 90, functions: 100, lines: 99 },
    },
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
