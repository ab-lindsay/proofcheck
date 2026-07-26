import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated artifacts (flat config does not read .gitignore):
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "blob-report/**",
    ".vercel/**",
    // Git worktrees hold a full checkout INCLUDING its own .next build output, which the ".next/**"
    // pattern above does not match at a nested path. Without these, `pnpm lint` fails on generated
    // bundles the moment anyone creates a worktree. (Same root cause as the .vercel/** entry added
    // by the 2026-07-24 sweep.)
    ".worktrees/**",
    ".claude/worktrees/**",
  ]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ["lib/vision/escalation/**"],
    rules: {
      // Spec §3.2 (2026-07-24 escalation design): the escalation ladder must be blind to
      // application data. A ladder that can see the expected values can retry a field toward
      // agreeing with the application — manufacturing APPROVEDs. CONFIDENCE_NEEDS_CORRECTION_THRESHOLD from
      // lib/matching/verify is explicitly allowed; the verdict function and matching rules are not.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/matching/verify",
              importNames: ["verifyLabel"],
              message: "The escalation ladder must not compute or consume verdicts (spec §3.2).",
            },
          ],
          patterns: [
            {
              group: ["@/lib/matching/fuzzy", "@/lib/matching/numeric", "@/lib/matching/warning"],
              message: "The escalation ladder must not consume matching rules (spec §3.2).",
            },
            {
              group: ["@/lib/ttb/warning", "@/lib/ttb/warning-diff"],
              message:
                "The escalation ladder must not see the canonical health warning text or its diff (D7, GS-15 hardening, 2026-07-25) — a ladder that could compare its own re-read against the known-correct answer could retry toward it, manufacturing a compliant verdict on a forged warning instead of an honest low-confidence transcription.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
