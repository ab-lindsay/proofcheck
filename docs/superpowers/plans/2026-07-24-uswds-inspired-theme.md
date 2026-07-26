# USWDS-Inspired Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin ProofCheck to the USWDS-inspired color/type direction approved in chat, and add a byte-level diff view for the health warning statement, without touching any verdict/matching logic.

**Architecture:** All color/typography/radius decisions live as CSS custom properties in `app/globals.css`, surfaced through the existing `@theme inline` block so Tailwind utilities (`bg-primary`, `text-verdict-match`, etc.) stay theme-aware via the existing `.dark`-class toggle — no new `dark:` variant pairs needed for anything newly tokenized. Components consume the new tokens; three swap Geist for Public Sans/Roboto Mono/Merriweather via `next/font/google` (self-hosted, no CSP change). The health-warning byte-diff is a new pure function (`lib/ttb/warning-diff.ts`) plus a small presentational component, wired into the one field that needs it.

**Tech Stack:** Next.js 16 (App Router), React 19, Tailwind v4 (CSS-first `@theme`), TypeScript, Vitest + Testing Library, `next/font/google`, lucide-react.

## Global Constraints

- **No verdict/matching changes.** `lib/matching/*` and `lib/ttb/warning.ts`'s canonical constant are untouched; the eval harness output stays identical. `lib/ttb/warning-diff.ts` is presentation-only — it never produces a verdict.
- **No new runtime dependencies.** Public Sans / Roboto Mono / Merriweather load through the `next/font/google` package already used for Geist.
- **CSP unchanged.** `font-src 'self'` (`lib/security-headers.ts`) already covers self-hosted `next/font` output.
- **Every verdict/token color pair clears WCAG AA (4.5:1 normal text)** in both themes — see the verified table in `docs/superpowers/specs/2026-07-24-uswds-inspired-theme-design.md`. Don't substitute a color without re-checking contrast.
- **Vocabulary:** verdicts `MATCH | MISMATCH | REVIEW`; overall `PASS | FAIL`; tiers `mock | local-ocr | cloud`.
- **`--radius` drops from `0.625rem` to `0.375rem`** — a single-variable change; no component's own `rounded-*` className changes.
- No seal, flag, or ".gov" styling anywhere.

### Token reference (defined in Task 1, consumed by every later task)

| Old (hardcoded)                                                    | New (token utility)                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `bg-emerald-600` / `emerald-700` (brand, buttons)                  | `bg-primary` (+ `text-primary-foreground`)                                |
| `text-emerald-600 dark:text-emerald-400` (icons/accents)           | `text-proof`                                                              |
| `hover:border-emerald-400 hover:bg-emerald-50 dark:hover:*`        | `hover:border-proof hover:bg-accent`                                      |
| `text-emerald-700 dark:text-emerald-400` (links)                   | `text-ring`                                                               |
| `border-emerald-200 bg-emerald-50 text-emerald-700 dark:*` (MATCH) | `border-verdict-match/30 bg-verdict-match-bg text-verdict-match`          |
| `border-red-200 bg-red-50 text-red-700 dark:*` (MISMATCH / errors) | `border-verdict-mismatch/30 bg-verdict-mismatch-bg text-verdict-mismatch` |
| `border-amber-200 bg-amber-50 text-amber-800/900 dark:*` (REVIEW)  | `border-verdict-review/30 bg-verdict-review-bg text-verdict-review`       |
| `focus:border-emerald-500 dark:focus:border-emerald-400`           | `focus:border-ring`                                                       |

---

### Task 1: Base tokens, fonts, radius, header restyle

**Files:**

- Modify: `app/globals.css`
- Modify: `app/layout.tsx`
- Modify: `app/layout.test.tsx`

**Interfaces:**

- Produces (Tailwind utilities from new CSS vars, consumed by every later task): `bg-primary`/`text-primary-foreground`, `bg-proof`/`text-proof`/`border-proof`, `text-ring`/`border-ring`, `bg-accent`, `bg-verdict-match`/`-bg`, `bg-verdict-review`/`-bg`, `bg-verdict-mismatch`/`-bg`, `font-heading` (Merriweather), `font-sans` (Public Sans), `font-mono` (Roboto Mono).

- [ ] **Step 1: Update the failing assertions in `app/layout.test.tsx`**

Replace the font mock and two spots:

```tsx
// Replace the existing vi.mock("next/font/google", ...) block with:
vi.mock("next/font/google", () => ({
  Public_Sans: () => ({ variable: "--font-public-sans" }),
  Roboto_Mono: () => ({ variable: "--font-roboto-mono" }),
  Merriweather: () => ({ variable: "--font-merriweather" }),
}));
```

```tsx
// Replace the viewport test body with:
it("exports viewport theme-color entries for both color schemes", () => {
  expect(viewport.themeColor).toEqual([
    { media: "(prefers-color-scheme: light)", color: "#faf8f3" },
    { media: "(prefers-color-scheme: dark)", color: "#15130f" },
  ]);
});
```

Add a new test at the end of the `describe("RootLayout", ...)` block:

```tsx
it("renders the independence disclaimer", () => {
  render(<RootLayout>content</RootLayout>);
  expect(
    screen.getByText(/Independent compliance tool — not affiliated with the U\.S\. Department of the Treasury/),
  ).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test app/layout.test.tsx`
Expected: FAIL — viewport colors don't match yet, disclaimer text doesn't exist, and the font mock now references export names (`Public_Sans` etc.) `layout.tsx` doesn't import yet.

- [ ] **Step 3: Replace `app/globals.css`**

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-public-sans);
  --font-mono: var(--font-roboto-mono);
  --font-heading: var(--font-merriweather);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar: var(--sidebar);
  --color-chart-5: var(--chart-5);
  --color-chart-4: var(--chart-4);
  --color-chart-3: var(--chart-3);
  --color-chart-2: var(--chart-2);
  --color-chart-1: var(--chart-1);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-border: var(--border);
  --color-destructive: var(--destructive);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent: var(--accent);
  --color-muted-foreground: var(--muted-foreground);
  --color-muted: var(--muted);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-secondary: var(--secondary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary: var(--primary);
  --color-popover-foreground: var(--popover-foreground);
  --color-popover: var(--popover);
  --color-card-foreground: var(--card-foreground);
  --color-card: var(--card);
  --color-proof: var(--proof-amber);
  --color-verdict-match: var(--verdict-match);
  --color-verdict-match-bg: var(--verdict-match-bg);
  --color-verdict-review: var(--verdict-review);
  --color-verdict-review-bg: var(--verdict-review-bg);
  --color-verdict-mismatch: var(--verdict-mismatch);
  --color-verdict-mismatch-bg: var(--verdict-mismatch-bg);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}

:root {
  --background: #faf8f3;
  --foreground: #1b1b1b;
  --card: #ffffff;
  --card-foreground: #1b1b1b;
  --popover: #ffffff;
  --popover-foreground: #1b1b1b;
  --primary: #142c46;
  --primary-foreground: #ffffff;
  --secondary: #f2ede2;
  --secondary-foreground: #1b1b1b;
  --muted: #f2ede2;
  --muted-foreground: #55534d;
  --accent: #f2ede2;
  --accent-foreground: #1b1b1b;
  --destructive: #b3221c;
  --border: #ddd6c7;
  --input: #ddd6c7;
  --ring: #005ea2;
  --proof-amber: #a85a1a;
  --verdict-match: #3f6b46;
  --verdict-match-bg: #e8f1e6;
  --verdict-review: #7d5f3f;
  --verdict-review-bg: #f2e7d4;
  --verdict-mismatch: #b3221c;
  --verdict-mismatch-bg: #fbe7e5;
  --chart-1: #8fae86;
  --chart-2: #6b8ba3;
  --chart-3: #a8875f;
  --chart-4: #8f6b8b;
  --chart-5: #b3835a;
  --radius: 0.375rem;
  --sidebar: #f2ede2;
  --sidebar-foreground: #1b1b1b;
  --sidebar-primary: #142c46;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: #e5ddc9;
  --sidebar-accent-foreground: #142c46;
  --sidebar-border: #ddd6c7;
  --sidebar-ring: #005ea2;
}

.dark {
  --background: #15130f;
  --foreground: #ede8dd;
  --card: #201d17;
  --card-foreground: #ede8dd;
  --popover: #201d17;
  --popover-foreground: #ede8dd;
  --primary: #1f4468;
  --primary-foreground: #ffffff;
  --secondary: #2a2720;
  --secondary-foreground: #ede8dd;
  --muted: #2a2720;
  --muted-foreground: #b6ae9e;
  --accent: #2a2720;
  --accent-foreground: #ede8dd;
  --destructive: #f08a83;
  --border: #3a362c;
  --input: #3a362c;
  --ring: #6cb6f0;
  --proof-amber: #e08a3e;
  --verdict-match: #8fc296;
  --verdict-match-bg: #1d2a1e;
  --verdict-review: #d3b587;
  --verdict-review-bg: #322a1a;
  --verdict-mismatch: #f08a83;
  --verdict-mismatch-bg: #35191a;
  --chart-1: #8fae86;
  --chart-2: #6b8ba3;
  --chart-3: #a8875f;
  --chart-4: #8f6b8b;
  --chart-5: #b3835a;
  --sidebar: #201d17;
  --sidebar-foreground: #ede8dd;
  --sidebar-primary: #1f4468;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: #2a2720;
  --sidebar-accent-foreground: #ede8dd;
  --sidebar-border: #3a362c;
  --sidebar-ring: #6cb6f0;
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
  html {
    @apply font-sans;
    color-scheme: light;
  }
}

/* The header wordmark's first letter picks up the brand accent without splitting the text node
   (keeps "ProofCheck" a single accessible string for screen readers and RTL's getByText). */
.wordmark::first-letter {
  color: var(--proof-amber);
}

/* Respect users who ask for less motion: neutralize the spinner, transitions, and smooth scroll. */
@media (prefers-reduced-motion: reduce) {
  *,
  ::before,
  ::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 4: Replace the font imports and header markup in `app/layout.tsx`**

Replace the imports and font loaders (top of file):

```tsx
import type { Metadata, Viewport } from "next";
import { Public_Sans, Roboto_Mono, Merriweather } from "next/font/google";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { ThemeToggle, THEME_INIT_SCRIPT } from "@/components/theme-toggle";
import "./globals.css";

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
});

const robotoMono = Roboto_Mono({
  variable: "--font-roboto-mono",
  subsets: ["latin"],
});

const merriweather = Merriweather({
  weight: ["700", "900"],
  variable: "--font-merriweather",
  subsets: ["latin"],
});
```

Replace the `viewport` export:

```tsx
export const viewport: Viewport = {
  // Mobile browser chrome only follows the OS-level prefers-color-scheme here, not our
  // class-based theme choice — it won't track a manual light/dark override via ThemeToggle.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f3" },
    { media: "(prefers-color-scheme: dark)", color: "#15130f" },
  ],
};
```

Replace the `<html>` className and the skip-link + header block:

```tsx
<html
  lang="en"
  suppressHydrationWarning
  className={`${publicSans.variable} ${robotoMono.variable} ${merriweather.variable} h-full antialiased`}
>
  <head>
    <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
  </head>
  <body className="min-h-full bg-background text-foreground">
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-base focus:font-semibold focus:text-primary-foreground"
    >
      Skip to main content
    </a>
    <header className="sticky top-0 z-10 bg-primary text-primary-foreground shadow-sm">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-proof text-white shadow-sm">
            <ShieldCheck aria-hidden className="h-6 w-6" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="wordmark font-heading text-xl font-bold tracking-tight">ProofCheck</span>
            <span className="mt-0.5 text-xs font-medium text-primary-foreground/75">TTB label verification</span>
          </span>
        </Link>
        <nav className="flex flex-wrap items-center gap-1 text-base" aria-label="Main">
          <Link
            className="rounded-md px-3 py-2 font-medium text-primary-foreground/80 transition-colors hover:bg-white/10 hover:text-primary-foreground"
            href="/"
          >
            Single label
          </Link>
          <Link
            className="rounded-md px-3 py-2 font-medium text-primary-foreground/80 transition-colors hover:bg-white/10 hover:text-primary-foreground"
            href="/batch"
          >
            Batch
          </Link>
          <span className="ml-1 border-l border-white/20 pl-2">
            <ThemeToggle />
          </span>
        </nav>
      </div>
    </header>
    <div className="border-b border-white/10 bg-primary/95 px-4 py-1.5 text-center text-xs text-primary-foreground/70">
      Independent compliance tool — not affiliated with the U.S. Department of the Treasury or the Alcohol and Tobacco
      Tax and Trade Bureau.
    </div>
    <main id="main-content" className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      {children}
    </main>
  </body>
</html>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test app/layout.test.tsx`
Expected: PASS (all `RootLayout` tests, including the two updated and the new disclaimer test).

- [ ] **Step 6: Commit**

```bash
git add app/globals.css app/layout.tsx app/layout.test.tsx
git commit -m "theme: USWDS-inspired tokens, fonts, and header restyle"
```

---

### Task 2: FieldRow verdict restyle

**Files:**

- Modify: `components/field-row.tsx`
- Modify: `components/field-row.test.tsx`

**Interfaces:**

- Consumes: `text-verdict-match`/`-review`/`-mismatch`, `bg-verdict-*-bg` (Task 1).

- [ ] **Step 1: Update the three verdict-icon assertions in `components/field-row.test.tsx`**

```tsx
it("renders the MATCH pill and verdict-match icon", () => {
  const { container } = render(
    <ul>
      <FieldRow result={base} beverageType="distilled-spirits" />
    </ul>,
  );
  expect(screen.getByText("Match")).toBeInTheDocument();
  expect(container.querySelector("svg.text-verdict-match")).toBeInTheDocument();
});
it("renders the MISMATCH pill and verdict-mismatch icon", () => {
  const mismatch: FieldResult = {
    ...base,
    verdict: "MISMATCH",
    labelValue: "40% Alc./Vol.",
    reason: "Does not match the application.",
  };
  const { container } = render(
    <ul>
      <FieldRow result={mismatch} beverageType="distilled-spirits" />
    </ul>,
  );
  expect(screen.getByText("Mismatch")).toBeInTheDocument();
  expect(container.querySelector("svg.text-verdict-mismatch")).toBeInTheDocument();
});
it("renders the REVIEW pill and verdict-review icon", () => {
  const review: FieldResult = {
    ...base,
    verdict: "REVIEW",
    labelValue: null,
    reason: "Alcohol content could not be read from the label — verify by eye.",
  };
  const { container } = render(
    <ul>
      <FieldRow result={review} beverageType="distilled-spirits" />
    </ul>,
  );
  expect(screen.getByText("Needs review")).toBeInTheDocument();
  expect(container.querySelector("svg.text-verdict-review")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test components/field-row.test.tsx`
Expected: FAIL — `svg.text-verdict-match` etc. don't exist yet (the component still renders `svg.text-emerald-600`).

- [ ] **Step 3: Replace the `STYLE` map in `components/field-row.tsx`**

```tsx
const STYLE = {
  MATCH: {
    icon: CheckCircle2,
    dot: "text-verdict-match",
    pill: "border-verdict-match/30 bg-verdict-match-bg text-verdict-match",
    text: "Match",
  },
  MISMATCH: {
    icon: XCircle,
    dot: "text-verdict-mismatch",
    pill: "border-verdict-mismatch/30 bg-verdict-mismatch-bg text-verdict-mismatch",
    text: "Mismatch",
  },
  REVIEW: {
    icon: AlertTriangle,
    dot: "text-verdict-review",
    pill: "border-verdict-review/30 bg-verdict-review-bg text-verdict-review",
    text: "Needs review",
  },
} as const;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test components/field-row.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/field-row.tsx components/field-row.test.tsx
git commit -m "theme: restyle FieldRow verdict chips onto verdict tokens"
```

---

### Task 3: VerdictCard restyle

**Files:**

- Modify: `components/verdict-card.tsx`

**Interfaces:**

- Consumes: `verdict-review`/`-bg` (Task 1), `font-heading` (Task 1).

No test changes — `components/verdict-card.test.tsx` asserts text content and roles only (confirmed: no color-class queries), so this is a restyle-only task; the regression check is Step 2 below.

- [ ] **Step 1: Replace the banner gradient, big verdict text, and review bar in `components/verdict-card.tsx`**

```tsx
      <div
        role="status"
        className={`flex items-center gap-4 px-6 py-5 text-white ${
          // Fixed (non-theme-toggled) gradients so white text stays legible regardless of page theme.
          // Verified: white on #24402a/#3f6b46 = 11.40:1/6.17:1; white on #7a1815/#b3221c = 10.67:1/6.64:1.
          pass
            ? "bg-gradient-to-r from-[#24402a] to-[#3f6b46]"
            : "bg-gradient-to-r from-[#7a1815] to-[#b3221c]"
        }`}
      >
        <Icon aria-hidden className="h-11 w-11 shrink-0" />
        <div>
          <div className="font-heading text-4xl font-bold tracking-wide">{result.overall}</div>
          <p className="mt-0.5 text-base font-medium text-white">
            {pass ? "No mismatches found." : "One or more fields don’t match the application."}
          </p>
        </div>
      </div>

      <div className="px-5 py-5 sm:px-6">
        {pass && reviews > 0 ? (
          <div
            role="status"
            className="mb-4 flex items-center gap-2 rounded-xl border border-verdict-review/30 bg-verdict-review-bg px-4 py-3 text-lg font-semibold text-verdict-review"
          >
            <AlertTriangle aria-hidden className="h-6 w-6 shrink-0 text-verdict-review" />
            <span>
              {reviews} item{reviews === 1 ? " needs" : "s need"} your review before approving
            </span>
          </div>
        ) : null}
```

(Everything below — the field list, warnings block, and timing footer — is unchanged.)

- [ ] **Step 2: Run the existing tests to confirm no regression**

Run: `pnpm test components/verdict-card.test.tsx`
Expected: PASS (all 7 existing tests — none assert color classes, so text/role assertions are unaffected).

- [ ] **Step 3: Commit**

```bash
git add components/verdict-card.tsx
git commit -m "theme: restyle VerdictCard banner and review bar onto verdict tokens"
```

---

### Task 4: Health warning statement byte-diff (new feature)

**Files:**

- Create: `lib/ttb/warning-diff.ts`
- Test: `lib/ttb/warning-diff.test.ts`
- Create: `components/warning-diff.tsx`
- Test: `components/warning-diff.test.tsx`
- Modify: `components/field-row.tsx`
- Modify: `components/field-row.test.tsx`

**Interfaces:**

- Produces: `export type DiffTokenKind = "same" | "case-diff" | "space-diff" | "diverge"`, `export interface DiffToken { text: string; kind: DiffTokenKind }`, `export function diffWarningTokens(canonical: string, extracted: string): { canonical: DiffToken[]; extracted: DiffToken[] }` (`lib/ttb/warning-diff.ts`); `export function WarningDiff({ canonical, extracted }: { canonical: string; extracted: string }): JSX.Element` (`components/warning-diff.tsx`).
- Consumes: `HEALTH_WARNING_TEXT` from `lib/ttb/warning.ts` (tests only); `verdict-review`/`verdict-mismatch` tokens (Task 1).

- [ ] **Step 1: Write the failing test for the pure diff function**

```ts
// lib/ttb/warning-diff.test.ts
import { describe, expect, it } from "vitest";
import { diffWarningTokens } from "@/lib/ttb/warning-diff";
import { HEALTH_WARNING_TEXT } from "@/lib/ttb/warning";

describe("diffWarningTokens", () => {
  it("marks every token 'same' for an identical match", () => {
    const { canonical, extracted } = diffWarningTokens(HEALTH_WARNING_TEXT, HEALTH_WARNING_TEXT);
    expect(canonical.every((t) => t.kind === "same")).toBe(true);
    expect(extracted.every((t) => t.kind === "same")).toBe(true);
  });

  it("marks every word token 'case-diff' for the real-world all-caps label scenario, spaces stay 'same'", () => {
    const { canonical, extracted } = diffWarningTokens(HEALTH_WARNING_TEXT, HEALTH_WARNING_TEXT.toUpperCase());
    const words = canonical.filter((t) => !/^\s+$/.test(t.text));
    const spaces = canonical.filter((t) => /^\s+$/.test(t.text));
    expect(words.length).toBeGreaterThan(0);
    expect(words.every((t) => t.kind === "case-diff")).toBe(true);
    expect(spaces.every((t) => t.kind === "same")).toBe(true);
    expect(canonical.some((t) => t.kind === "diverge")).toBe(false);
    expect(extracted.some((t) => t.kind === "diverge")).toBe(false);
  });

  it("marks only the changed whitespace run as 'space-diff' when an extra space is inserted", () => {
    const extracted = HEALTH_WARNING_TEXT.replace("GOVERNMENT WARNING: (1)", "GOVERNMENT WARNING:  (1)");
    const { canonical, extracted: ext } = diffWarningTokens(HEALTH_WARNING_TEXT, extracted);
    expect(canonical.filter((t) => t.kind === "space-diff")).toHaveLength(1);
    expect(ext.filter((t) => t.kind === "space-diff")).toHaveLength(1);
    expect(canonical.some((t) => t.kind === "diverge")).toBe(false);
  });

  it("collapses a genuine wording difference into a single trailing 'diverge' token per side", () => {
    const extracted = HEALTH_WARNING_TEXT.replace(
      "Consumption of alcoholic beverages impairs",
      "Drinking alcohol impairs",
    );
    const { canonical, extracted: ext } = diffWarningTokens(HEALTH_WARNING_TEXT, extracted);
    expect(canonical.at(-1)?.kind).toBe("diverge");
    expect(ext.at(-1)?.kind).toBe("diverge");
    expect(canonical.at(-1)?.text).toContain("Consumption of alcoholic beverages impairs");
    expect(ext.at(-1)?.text).toContain("Drinking alcohol impairs");
  });

  it("marks only the canonical side as diverging when the label is simply missing trailing text", () => {
    const cut = HEALTH_WARNING_TEXT.indexOf("(2)");
    const extracted = HEALTH_WARNING_TEXT.slice(0, cut).trimEnd();
    const { canonical, extracted: ext } = diffWarningTokens(HEALTH_WARNING_TEXT, extracted);
    expect(canonical.at(-1)?.kind).toBe("diverge");
    expect(ext.some((t) => t.kind === "diverge")).toBe(false);
    expect(ext.every((t) => t.kind === "same")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test lib/ttb/warning-diff.test.ts`
Expected: FAIL — cannot resolve `@/lib/ttb/warning-diff`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/ttb/warning-diff.ts
export type DiffTokenKind = "same" | "case-diff" | "space-diff" | "diverge";

export interface DiffToken {
  text: string;
  kind: DiffTokenKind;
}

function tokenize(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t !== "");
}

function isSpace(t: string): boolean {
  return /^\s+$/.test(t);
}

/**
 * Splits canonical/extracted into whitespace-delimited tokens and classifies where they diverge.
 * Mirrors the REVIEW/MISMATCH boundary lib/matching/warning.ts already decides — this never
 * re-judges, it only visualizes: case/space-only differences are "case-diff"/"space-diff" (the
 * conditions that already produce REVIEW there); a genuine wording difference collapses the rest
 * of both strings into one trailing "diverge" token per side (what already produces MISMATCH). If
 * one side simply runs out first (missing trailing text), only the longer side gets a diverge tail.
 */
export function diffWarningTokens(
  canonical: string,
  extracted: string,
): { canonical: DiffToken[]; extracted: DiffToken[] } {
  const a = tokenize(canonical);
  const b = tokenize(extracted);
  const canonicalOut: DiffToken[] = [];
  const extractedOut: DiffToken[] = [];
  const len = Math.min(a.length, b.length);

  let i = 0;
  for (; i < len; i++) {
    const ca = a[i];
    const cb = b[i];
    if (ca === cb) {
      canonicalOut.push({ text: ca, kind: "same" });
      extractedOut.push({ text: cb, kind: "same" });
      continue;
    }
    if (isSpace(ca) && isSpace(cb)) {
      canonicalOut.push({ text: ca, kind: "space-diff" });
      extractedOut.push({ text: cb, kind: "space-diff" });
      continue;
    }
    if (!isSpace(ca) && !isSpace(cb) && ca.toLowerCase() === cb.toLowerCase()) {
      canonicalOut.push({ text: ca, kind: "case-diff" });
      extractedOut.push({ text: cb, kind: "case-diff" });
      continue;
    }
    break;
  }

  const restA = a.slice(i).join("");
  const restB = b.slice(i).join("");
  if (restA) canonicalOut.push({ text: restA, kind: "diverge" });
  if (restB) extractedOut.push({ text: restB, kind: "diverge" });

  return { canonical: canonicalOut, extracted: extractedOut };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test lib/ttb/warning-diff.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Write the failing test for the presentational component**

```tsx
// components/warning-diff.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WarningDiff } from "@/components/warning-diff";
import { HEALTH_WARNING_TEXT } from "@/lib/ttb/warning";

describe("WarningDiff", () => {
  it("renders both labeled lines", () => {
    render(<WarningDiff canonical={HEALTH_WARNING_TEXT} extracted={HEALTH_WARNING_TEXT} />);
    expect(screen.getByText("On file (canonical)")).toBeInTheDocument();
    expect(screen.getByText("Extracted from label")).toBeInTheDocument();
  });

  it("renders no <mark> highlights and no caption for an exact match", () => {
    const { container } = render(<WarningDiff canonical={HEALTH_WARNING_TEXT} extracted={HEALTH_WARNING_TEXT} />);
    expect(container.querySelectorAll("mark")).toHaveLength(0);
    expect(screen.queryByText(/checked byte-for-byte/i)).not.toBeInTheDocument();
  });

  it("highlights case-only differences in review color", () => {
    const { container } = render(
      <WarningDiff canonical={HEALTH_WARNING_TEXT} extracted={HEALTH_WARNING_TEXT.toUpperCase()} />,
    );
    expect(container.querySelectorAll("mark.text-verdict-review").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("mark.text-verdict-mismatch")).toHaveLength(0);
    expect(screen.getByText(/checked byte-for-byte/i)).toBeInTheDocument();
  });

  it("highlights a genuine wording difference in mismatch color", () => {
    const extracted = HEALTH_WARNING_TEXT.replace(
      "Consumption of alcoholic beverages impairs",
      "Drinking alcohol impairs",
    );
    const { container } = render(<WarningDiff canonical={HEALTH_WARNING_TEXT} extracted={extracted} />);
    expect(container.querySelectorAll("mark.text-verdict-mismatch").length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm test components/warning-diff.test.tsx`
Expected: FAIL — cannot resolve `@/components/warning-diff`.

- [ ] **Step 7: Write the component**

```tsx
// components/warning-diff.tsx
import type { DiffToken } from "@/lib/ttb/warning-diff";
import { diffWarningTokens } from "@/lib/ttb/warning-diff";

function Line({ label, tokens }: { label: string; tokens: DiffToken[] }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <div className="text-sm font-semibold text-muted-foreground">{label}</div>
      <div className="font-mono text-sm leading-relaxed break-words">
        {tokens.map((t, i) =>
          t.kind === "same" ? (
            <span key={i}>{t.text}</span>
          ) : (
            <mark
              key={i}
              className={
                t.kind === "diverge"
                  ? "rounded-sm bg-verdict-mismatch-bg text-verdict-mismatch"
                  : "rounded-sm bg-verdict-review-bg text-verdict-review"
              }
            >
              {t.text}
            </mark>
          ),
        )}
      </div>
    </div>
  );
}

export function WarningDiff({ canonical, extracted }: { canonical: string; extracted: string }) {
  const { canonical: canonicalTokens, extracted: extractedTokens } = diffWarningTokens(canonical, extracted);
  const hasDifference =
    canonicalTokens.some((t) => t.kind !== "same") || extractedTokens.some((t) => t.kind !== "same");
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/60 p-3">
      <Line label="On file (canonical)" tokens={canonicalTokens} />
      <Line label="Extracted from label" tokens={extractedTokens} />
      {hasDifference ? (
        <p className="text-sm text-muted-foreground">
          Checked byte-for-byte, never guessed — highlighted text is exactly where the two differ.
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm test components/warning-diff.test.tsx`
Expected: PASS (all 4 tests).

- [ ] **Step 9: Write the failing test for FieldRow wiring**

Add to `components/field-row.test.tsx`:

```tsx
describe("FieldRow health warning statement diff", () => {
  it("renders the byte-diff view instead of the generic value boxes when both values are present", () => {
    const warning: FieldResult = {
      field: "healthWarningStatement",
      applicationValue: "GOVERNMENT WARNING: text",
      labelValue: "GOVERNMENT WARNING: TEXT",
      verdict: "REVIEW",
      reason: "Wording is exact; only letter case differs.",
      confidence: 0.9,
    };
    render(
      <ul>
        <FieldRow result={warning} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("On file (canonical)")).toBeInTheDocument();
    expect(screen.queryByText("Application")).not.toBeInTheDocument();
  });

  it("falls back to the generic value boxes when the label value is missing", () => {
    const missing: FieldResult = {
      field: "healthWarningStatement",
      applicationValue: "GOVERNMENT WARNING: text",
      labelValue: null,
      verdict: "REVIEW",
      reason: "No health warning statement found on the label — verify by eye.",
      confidence: 0.2,
    };
    render(
      <ul>
        <FieldRow result={missing} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("Application")).toBeInTheDocument();
    expect(screen.getByText("not found")).toBeInTheDocument();
    expect(screen.queryByText("On file (canonical)")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `pnpm test components/field-row.test.tsx`
Expected: FAIL — `FieldRow` doesn't render `WarningDiff` yet.

- [ ] **Step 11: Wire `WarningDiff` into `components/field-row.tsx`**

Add the import alongside the existing ones:

```tsx
import { WarningDiff } from "@/components/warning-diff";
```

Replace the value-boxes block (`<div className="mt-2 grid gap-2 pl-8 sm:grid-cols-2">...</div>`) with:

```tsx
{
  result.field === "healthWarningStatement" && result.applicationValue && result.labelValue ? (
    <div className="mt-2 pl-8">
      <WarningDiff canonical={result.applicationValue} extracted={result.labelValue} />
    </div>
  ) : (
    <div className="mt-2 grid gap-2 pl-8 sm:grid-cols-2">
      <div className="rounded-lg bg-muted px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application</div>
        <div className="mt-0.5 text-base break-words text-foreground">{result.applicationValue ?? "—"}</div>
      </div>
      <div className="rounded-lg bg-muted px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Label</div>
        <div className="mt-0.5 text-base break-words text-foreground">{result.labelValue ?? "not found"}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `pnpm test components/field-row.test.tsx`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 13: Commit**

```bash
git add lib/ttb/warning-diff.ts lib/ttb/warning-diff.test.ts components/warning-diff.tsx components/warning-diff.test.tsx components/field-row.tsx components/field-row.test.tsx
git commit -m "feat: byte-level diff view for the health warning statement"
```

---

### Task 5: UploadZone restyle

**Files:**

- Modify: `components/upload-zone.tsx`

No test changes — `components/upload-zone.test.tsx` only covers object-URL lifecycle. Restyle-only; Step 2 is the regression check.

- [ ] **Step 1: Swap emerald classes for tokens in `components/upload-zone.tsx`**

Drag-over state:

```tsx
      className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
        dragOver ? "border-proof bg-accent" : "border-border bg-muted/60"
      }`}
```

"Remove image" button:

```tsx
<button
  type="button"
  className="text-base font-medium text-ring underline underline-offset-2 hover:opacity-80"
  onClick={() => {
    choose(null);
    if (inputRef.current) inputRef.current.value = "";
  }}
>
  Remove image
</button>
```

"or choose a file" button:

```tsx
<button
  type="button"
  className="text-lg font-medium text-ring underline underline-offset-2 hover:opacity-80"
  onClick={() => inputRef.current?.click()}
>
  or choose a file
</button>
```

- [ ] **Step 2: Run the existing test to confirm no regression**

Run: `pnpm test components/upload-zone.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/upload-zone.tsx
git commit -m "theme: restyle UploadZone onto brand/link tokens"
```

---

### Task 6: ApplicationForm restyle

**Files:**

- Modify: `components/application-form.tsx`

No test changes — `components/application-form.test.tsx` covers validation/submission behavior only. Restyle-only; Step 2 is the regression check.

- [ ] **Step 1: Swap emerald classes for tokens in `components/application-form.tsx`**

```tsx
const FIELD_CLASS =
  "w-full rounded-lg border border-input bg-card px-3.5 py-3 text-lg text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus:border-ring focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";
```

```tsx
      <button
        type="submit"
        disabled={busy || !fileAttached}
        className="w-full rounded-lg bg-primary px-4 py-3 text-lg font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
      >
```

- [ ] **Step 2: Run the existing test to confirm no regression**

Run: `pnpm test components/application-form.test.tsx`
Expected: PASS (all 9 tests).

- [ ] **Step 3: Commit**

```bash
git add components/application-form.tsx
git commit -m "theme: restyle ApplicationForm onto primary/ring tokens"
```

---

### Task 7: BatchTable restyle

**Files:**

- Modify: `components/batch-table.tsx`

No test changes — `components/batch-table.test.tsx` covers sorting/expand/collapse/status text, no color assertions. Restyle-only; Step 2 is the regression check.

- [ ] **Step 1: Swap emerald/red classes for verdict tokens in `components/batch-table.tsx`**

```tsx
if (item.status === "done") {
  const pass = item.result?.overall === "PASS";
  return (
    <span
      className={`inline-block rounded-full border px-3 py-1 text-sm font-bold ${
        pass
          ? "border-verdict-match/30 bg-verdict-match-bg text-verdict-match"
          : "border-verdict-mismatch/30 bg-verdict-mismatch-bg text-verdict-mismatch"
      }`}
    >
      {item.result?.overall}
    </span>
  );
}
if (item.status === "error") {
  return (
    <span className="inline-block rounded-full border border-verdict-mismatch/30 bg-verdict-mismatch-bg px-3 py-1 text-sm font-bold text-verdict-mismatch">
      ERROR
    </span>
  );
}
```

- [ ] **Step 2: Run the existing test to confirm no regression**

Run: `pnpm test components/batch-table.test.tsx`
Expected: PASS (all tests).

- [ ] **Step 3: Commit**

```bash
git add components/batch-table.tsx
git commit -m "theme: restyle BatchTable status pills onto verdict tokens"
```

---

### Task 8: Home page restyle

**Files:**

- Modify: `app/page.tsx`

No test changes — `app/page.test.tsx` has no color-class assertions (confirmed by search). Restyle-only; Step 2 is the regression check.

- [ ] **Step 1: Swap emerald/red classes for tokens in `app/page.tsx`**

Page heading:

```tsx
<h1 className="font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl">Verify a label</h1>
```

Sparkle icon:

```tsx
<Sparkles aria-hidden className="h-5 w-5 text-proof" />
```

Sample card hover:

```tsx
className =
  "flex flex-col items-start rounded-xl border border-border bg-card px-4 py-2.5 text-left shadow-sm transition-colors hover:border-proof hover:bg-accent";
```

Sample-load error text:

```tsx
{
  sampleError ? (
    <p role="alert" className="text-sm font-medium text-verdict-mismatch">
      {sampleError}
    </p>
  ) : null;
}
```

Loading spinner:

```tsx
<Loader2 aria-hidden className="h-9 w-9 animate-spin text-primary" />
```

Error state block:

```tsx
<div className="rounded-2xl border border-verdict-mismatch/30 bg-verdict-mismatch-bg px-6 py-5 shadow-sm" role="alert">
  <p className="text-xl font-semibold text-verdict-mismatch">Something went wrong</p>
  <p className="mt-1 text-lg text-verdict-mismatch">{error}</p>
</div>
```

- [ ] **Step 2: Run the existing test to confirm no regression**

Run: `pnpm test app/page.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "theme: restyle the single-label page onto brand/verdict tokens"
```

---

### Task 9: Batch page restyle

**Files:**

- Modify: `app/batch/page.tsx`

No test changes — `app/batch/page.test.tsx` has no color-class assertions (confirmed by search). Restyle-only; Step 2 is the regression check.

- [ ] **Step 1: Swap emerald/red/amber classes for tokens in `app/batch/page.tsx`**

Page heading:

```tsx
<h1 className="font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl">Batch verification</h1>
```

CSV template icon:

```tsx
<FileSpreadsheet aria-hidden className="h-5 w-5 text-proof" />
```

CSV problems block:

```tsx
              <div className="rounded-xl border border-verdict-mismatch/30 bg-verdict-mismatch-bg p-4">
                <p className="mb-1 text-base font-semibold text-verdict-mismatch">CSV problems</p>
                <ul className="list-disc space-y-1 pl-5 text-base text-verdict-mismatch">
```

Unmatched-images notice:

```tsx
<p className="text-base text-verdict-review">Images with no CSV row (skipped): {unmatchedImages.join(", ")}</p>
```

Verify batch button:

```tsx
className =
  "rounded-lg bg-primary px-5 py-3 text-lg font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none";
```

- [ ] **Step 2: Run the existing test to confirm no regression**

Run: `pnpm test app/batch/page.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/batch/page.tsx
git commit -m "theme: restyle the batch page onto brand/verdict tokens"
```

---

### Task 10: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 3: Full unit test suite**

Run: `pnpm test`
Expected: all test files pass (the 39 pre-existing files plus the 2 new ones from Task 4).

- [ ] **Step 4: Production build**

Run: `pnpm build`
Expected: builds cleanly — confirms `next/font/google` resolves Public Sans/Roboto Mono/Merriweather at build time and the app compiles with the new Tailwind theme tokens.

- [ ] **Step 5: Boot and smoke-check both themes**

Run: `pnpm start` (background), then load `http://localhost:3000` in a browser.
Check: header renders navy with the amber-accented wordmark and the disclaimer strip; toggle to dark via `ThemeToggle` and confirm the page re-themes with no flash/console errors; load a sample (e.g. "Title-case warning") and confirm the health-warning-statement row renders the byte-diff view with highlighted tokens instead of the generic Application/Label boxes.

- [ ] **Step 6: Confirm the eval harness is unaffected**

Run: `pnpm eval`
Expected: identical pass/accuracy numbers to the pre-change baseline (no `lib/matching` changes were made).

- [ ] **Step 7: Commit (only if any fixes were needed above)**

```bash
git add -A
git commit -m "fix: address issues found in the full verification pass"
```

---

### Task 11: Dev-mode gate for the health-warning diff view

> Added after Task 5 review, before Task 10 executes for real: the always-visible byte-level
> diff view from Task 4 conflicts with the project's "usable by a non-technical 73-year-old"
> bar (docs/ARCHITECTURE.md). This task gates it behind an explicit, off-by-default toggle and
> softens its wording. Task 10's verification pass should run after this task, not before.

**Files:**

- Create: `hooks/use-dev-mode.ts`
- Test: `hooks/use-dev-mode.test.ts`
- Create: `components/dev-mode-toggle.tsx`
- Test: `components/dev-mode-toggle.test.tsx`
- Modify: `app/layout.tsx`
- Modify: `components/field-row.tsx`
- Modify: `components/field-row.test.tsx`
- Modify: `components/warning-diff.tsx`
- Modify: `components/warning-diff.test.tsx`

**Interfaces:**

- Produces: `useDevMode(): boolean`, `setDevMode(value: boolean): void` (`hooks/use-dev-mode.ts`,
  localStorage-backed under key `"devMode"`, cross-component reactive via `useSyncExternalStore`
  — localStorage's own `"storage"` event only fires in _other_ tabs, so same-tab subscribers need
  their own notification path); `<DevModeToggle />` (`components/dev-mode-toggle.tsx`).
- Consumes: `useDevMode` in `FieldRow` to gate `WarningDiff` rendering.

- [ ] **Step 1: Write the failing test for the hook**

```ts
// hooks/use-dev-mode.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useDevMode, setDevMode } from "@/hooks/use-dev-mode";

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("useDevMode", () => {
  it("defaults to false when nothing is stored", () => {
    const { result } = renderHook(() => useDevMode());
    expect(result.current).toBe(false);
  });

  it("reflects a stored true value on mount", () => {
    localStorage.setItem("devMode", "true");
    const { result } = renderHook(() => useDevMode());
    expect(result.current).toBe(true);
  });

  it("updates every subscribed hook instance when setDevMode is called", () => {
    const a = renderHook(() => useDevMode());
    const b = renderHook(() => useDevMode());
    act(() => setDevMode(true));
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(true);
    expect(localStorage.getItem("devMode")).toBe("true");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test hooks/use-dev-mode.test.ts`
Expected: FAIL — cannot resolve `@/hooks/use-dev-mode`.

- [ ] **Step 3: Write the hook implementation**

```ts
// hooks/use-dev-mode.ts
"use client";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "devMode";
type Listener = () => void;
const listeners = new Set<Listener>();

function getSnapshot(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "true";
}

function getServerSnapshot(): boolean {
  return false;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Persists the choice and notifies every mounted useDevMode() subscriber in this tab —
// localStorage's own "storage" event only fires in OTHER tabs, not the one that wrote it.
export function setDevMode(value: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(value));
  listeners.forEach((listener) => listener());
}

export function useDevMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test hooks/use-dev-mode.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing test for the toggle component**

```tsx
// components/dev-mode-toggle.test.tsx
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DevModeToggle } from "@/components/dev-mode-toggle";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("DevModeToggle", () => {
  it("defaults to off", () => {
    render(<DevModeToggle />);
    expect(screen.getByRole("switch", { name: "Dev mode" })).toHaveAttribute("aria-checked", "false");
  });

  it("clicking turns it on and persists the choice", async () => {
    render(<DevModeToggle />);
    await userEvent.click(screen.getByRole("switch", { name: "Dev mode" }));
    expect(screen.getByRole("switch", { name: "Dev mode" })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("devMode")).toBe("true");
  });

  it("clicking again turns it back off", async () => {
    render(<DevModeToggle />);
    const toggle = screen.getByRole("switch", { name: "Dev mode" });
    await userEvent.click(toggle);
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm test components/dev-mode-toggle.test.tsx`
Expected: FAIL — cannot resolve `@/components/dev-mode-toggle`.

- [ ] **Step 7: Write the toggle component**

```tsx
// components/dev-mode-toggle.tsx
"use client";
import { useDevMode, setDevMode } from "@/hooks/use-dev-mode";

export function DevModeToggle() {
  const enabled = useDevMode();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="Dev mode"
      title="Dev mode: shows the character-by-character comparison for the health warning statement"
      onClick={() => setDevMode(!enabled)}
      className={`rounded-md px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
        enabled
          ? "bg-white/20 text-primary-foreground"
          : "text-primary-foreground/60 hover:bg-white/10 hover:text-primary-foreground/90"
      }`}
    >
      Dev
    </button>
  );
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm test components/dev-mode-toggle.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 9: Wire the toggle into the header**

In `app/layout.tsx`, add the import alongside the `ThemeToggle` import:

```tsx
import { DevModeToggle } from "@/components/dev-mode-toggle";
```

Replace the toggle wrapper span in the nav (currently `<span className="ml-1 border-l border-white/20 pl-2"><ThemeToggle /></span>`) with:

```tsx
<span className="ml-1 flex items-center gap-2 border-l border-white/20 pl-2">
  <DevModeToggle />
  <ThemeToggle />
</span>
```

- [ ] **Step 10: Run the layout test to confirm no regression**

Run: `pnpm test app/layout.test.tsx`
Expected: PASS (no existing assertion targets the removed wrapper markup directly).

- [ ] **Step 11: Write the failing tests for gating `WarningDiff` in `FieldRow`**

In `components/field-row.test.tsx`, replace the existing `describe("FieldRow health warning statement diff", ...)` block with:

```tsx
describe("FieldRow health warning statement diff", () => {
  const warning: FieldResult = {
    field: "healthWarningStatement",
    applicationValue: "GOVERNMENT WARNING: text",
    labelValue: "GOVERNMENT WARNING: TEXT",
    verdict: "REVIEW",
    reason: "Wording is exact; only letter case differs.",
    confidence: 0.9,
  };

  it("shows the generic value boxes, not the diff view, when dev mode is off (default)", () => {
    render(
      <ul>
        <FieldRow result={warning} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("Application")).toBeInTheDocument();
    expect(screen.queryByText("On file (canonical)")).not.toBeInTheDocument();
  });

  it("renders the diff view instead of the generic value boxes when dev mode is on and both values are present", () => {
    localStorage.setItem("devMode", "true");
    render(
      <ul>
        <FieldRow result={warning} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("On file (canonical)")).toBeInTheDocument();
    expect(screen.queryByText("Application")).not.toBeInTheDocument();
  });

  it("falls back to the generic value boxes when dev mode is on but the label value is missing", () => {
    localStorage.setItem("devMode", "true");
    const missing: FieldResult = {
      field: "healthWarningStatement",
      applicationValue: "GOVERNMENT WARNING: text",
      labelValue: null,
      verdict: "REVIEW",
      reason: "No health warning statement found on the label — verify by eye.",
      confidence: 0.2,
    };
    render(
      <ul>
        <FieldRow result={missing} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("Application")).toBeInTheDocument();
    expect(screen.getByText("not found")).toBeInTheDocument();
    expect(screen.queryByText("On file (canonical)")).not.toBeInTheDocument();
  });
});
```

Add `beforeEach(() => localStorage.clear())` near the top of the file (alongside the existing `afterEach(cleanup)`) so dev-mode state doesn't leak between tests.

- [ ] **Step 12: Run the test to verify it fails**

Run: `pnpm test components/field-row.test.tsx`
Expected: FAIL — `FieldRow` still renders `WarningDiff` unconditionally whenever both values are present, regardless of dev mode.

- [ ] **Step 13: Gate `WarningDiff` on dev mode in `components/field-row.tsx`**

Add the import:

```tsx
import { useDevMode } from "@/hooks/use-dev-mode";
```

Inside `FieldRow`, read the flag:

```tsx
const devMode = useDevMode();
```

Change the conditional that currently reads `result.field === "healthWarningStatement" && result.applicationValue && result.labelValue` to also require `devMode &&` at the front of the condition (both branches — the `WarningDiff` branch and its `:` fallback — stay otherwise unchanged).

- [ ] **Step 14: Run the test to verify it passes**

Run: `pnpm test components/field-row.test.tsx`
Expected: PASS (all tests, including the three new ones).

- [ ] **Step 15: Update the failing wording assertions in `components/warning-diff.test.tsx`**

Replace both occurrences of `/checked byte-for-byte/i` with `/checked character-by-character/i`.

- [ ] **Step 16: Run the test to verify it fails**

Run: `pnpm test components/warning-diff.test.tsx`
Expected: FAIL — the component still renders "Checked byte-for-byte, never guessed…".

- [ ] **Step 17: Soften the wording in `components/warning-diff.tsx`**

Change the caption text from `"Checked byte-for-byte, never guessed — highlighted text is exactly where the two differ."` to `"Checked character-by-character, never guessed — highlighted text is exactly where the two differ."`.

- [ ] **Step 18: Run the test to verify it passes**

Run: `pnpm test components/warning-diff.test.tsx`
Expected: PASS (all 4 tests).

- [ ] **Step 19: Full regression check**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green — this task touches a header component and a field component used on both the single-label and batch pages.

- [ ] **Step 20: Commit**

```bash
git add hooks/use-dev-mode.ts hooks/use-dev-mode.test.ts components/dev-mode-toggle.tsx components/dev-mode-toggle.test.tsx app/layout.tsx components/field-row.tsx components/field-row.test.tsx components/warning-diff.tsx components/warning-diff.test.tsx
git commit -m "feat: gate the health-warning diff view behind a dev-mode toggle; soften its wording"
```
