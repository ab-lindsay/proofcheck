# UI Theming + Per-Field Regulation References — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add light/dark/system theming (hand-rolled, zero-dep) and an always-visible legal-regulation reference on every field result, without changing any verdict logic.

**Architecture:** A pre-paint inline script + a client `ThemeToggle` drive a `.dark` class on `<html>`; components move off hardcoded palette classes onto the semantic tokens already in `globals.css`. Citations come from a pure `lib/ttb/citations.ts` looked up at render time from `(field, beverageType)`; `beverageType` is echoed by the `/api/verify` response so both single and batch views have it. `lib/matching` and the eval harness are untouched.

**Tech Stack:** Next.js 16 (App Router), React 19, Tailwind v4 + shadcn tokens, TypeScript, Vitest + Testing Library, lucide-react icons.

## Global Constraints

- **No new runtime dependencies.** Theme system is hand-rolled. (If unsatisfactory, `next-themes` is the agreed fallback — a separate change.)
- **No verdict/matching changes.** `lib/matching/*` output and all its tests stay byte-identical. Eval harness untouched.
- **CSP unchanged.** The inline theme script is allowed by the existing `script-src 'self' 'unsafe-inline'` (`lib/security-headers.ts`). Do not modify CSP.
- **Persona/accessibility bar:** big targets, high contrast, plain-English copy; verdict colors must stay legible in BOTH themes.
- **Citations are TTB/eCFR-verified (2026-07-22).** Use exactly the section numbers/URLs in Task 1. Do not invent citations; a field with no dedicated TTB section returns `null`.
- **External links:** `target="_blank" rel="noopener noreferrer"`.
- **Vocabulary:** verdicts `MATCH | MISMATCH | REVIEW`; overall `PASS | FAIL`; tiers `mock | local-ocr | cloud`.

### Token migration reference (applied per-file in Tasks 4–9)

Context-dependent — each file task lists its exact substitutions, but the canonical map is:

| Hardcoded                                          | Token                                           |
| -------------------------------------------------- | ----------------------------------------------- |
| `bg-stone-50` (page body)                          | `bg-background`                                 |
| `bg-stone-50` (inset panel)                        | `bg-muted`                                      |
| `bg-white`, `bg-white/60`                          | `bg-card`, `bg-card/60`                         |
| `bg-white/85` (sticky header)                      | `bg-card/85`                                    |
| `bg-slate-900` (badge)                             | `bg-primary` (+ text `text-primary-foreground`) |
| `bg-stone-100` (hover/pill)                        | `bg-muted`                                      |
| `text-slate-900`, `-800`, `-700`                   | `text-foreground`                               |
| `text-slate-600`, `-500`, `-400`, `text-stone-400` | `text-muted-foreground`                         |
| `border-stone-200`, `border-stone-100`             | `border-border`                                 |
| `border-stone-300` (inputs)                        | `border-input`                                  |
| `divide-stone-100`                                 | `divide-border`                                 |

Verdict colors are NOT tokens — they get explicit `dark:` variants (Tasks 5–7).

---

### Task 1: Citations data module

**Files:**

- Create: `lib/ttb/citations.ts`
- Test: `lib/ttb/citations.test.ts`

**Interfaces:**

- Produces: `interface Citation { basis: string; cfr: string; url: string }` and
  `citationFor(field: keyof ExtractedLabel, beverageType: BeverageType): Citation | null`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/ttb/citations.test.ts
import { describe, expect, it } from "vitest";
import { citationFor } from "@/lib/ttb/citations";
import { BeverageTypeSchema, type ExtractedLabel } from "@/lib/schema";

const FIELDS: (keyof ExtractedLabel)[] = [
  "brandName",
  "classType",
  "alcoholContent",
  "netContents",
  "nameAndAddress",
  "countryOfOrigin",
  "healthWarningStatement",
];
const TYPES = BeverageTypeSchema.options;

describe("citationFor", () => {
  it("every non-null citation is a well-formed 27 CFR reference with an ecfr.gov title-27 link", () => {
    for (const t of TYPES) {
      for (const f of FIELDS) {
        const c = citationFor(f, t);
        if (c === null) continue;
        expect(c.cfr, `${t}/${f}`).toMatch(/^27 CFR §\d+\.\d+$/);
        expect(c.url, `${t}/${f}`).toMatch(/^https:\/\/www\.ecfr\.gov\/current\/title-27\//);
        expect(c.basis.length, `${t}/${f}`).toBeGreaterThan(10);
      }
    }
  });
  it("the health warning cites 27 CFR §16.21 for every beverage type", () => {
    for (const t of TYPES) expect(citationFor("healthWarningStatement", t)?.cfr).toBe("27 CFR §16.21");
  });
  it("spot-checks key sections", () => {
    expect(citationFor("alcoholContent", "distilled-spirits")?.cfr).toBe("27 CFR §5.65");
    expect(citationFor("classType", "wine")?.cfr).toBe("27 CFR §4.34");
    expect(citationFor("brandName", "malt-beverage")?.cfr).toBe("27 CFR §7.64");
  });
  it("wine country of origin has no dedicated TTB section (CBP-governed) → null", () => {
    expect(citationFor("countryOfOrigin", "wine")).toBeNull();
  });
  it("returns null for an unknown field", () => {
    expect(citationFor("bogus" as keyof ExtractedLabel, "wine")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/ttb/citations.test.ts`
Expected: FAIL — cannot resolve `@/lib/ttb/citations`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/ttb/citations.ts
import type { BeverageType, ExtractedLabel } from "@/lib/schema";

export interface Citation {
  basis: string; // plain-English: why this field must be on the label
  cfr: string; // e.g. "27 CFR §5.65"
  url: string; // deep link to the section on eCFR
}

type Field = keyof ExtractedLabel;

// eCFR section URL builder (verified 2026-07-22 against ecfr.gov / TTB / Cornell LII).
const sec = (part: number, subpart: string, section: string) =>
  `https://www.ecfr.gov/current/title-27/chapter-I/subchapter-A/part-${part}/subpart-${subpart}/section-${section}`;

// Health warning is identical across all beverage types (Alcoholic Beverage Health Warning Statement Act).
const WARNING: Citation = {
  basis: "Every alcohol beverage at 0.5% ABV or more must bear the Government Warning statement.",
  cfr: "27 CFR §16.21",
  url: sec(16, "C", "16.21"),
};

const CITATIONS: Record<BeverageType, Partial<Record<Field, Citation>>> = {
  "distilled-spirits": {
    brandName: {
      basis: "A distilled spirits label must bear a brand name.",
      cfr: "27 CFR §5.64",
      url: sec(5, "E", "5.64"),
    },
    classType: {
      basis: "Spirits must bear a class, type, or other designation defined by the standards of identity (subpart I).",
      cfr: "27 CFR §5.63",
      url: sec(5, "E", "5.63"),
    },
    alcoholContent: {
      basis: "Spirits must state alcohol content as a percentage of alcohol by volume.",
      cfr: "27 CFR §5.65",
      url: sec(5, "E", "5.65"),
    },
    netContents: {
      basis: "Spirits must state the net contents of the container.",
      cfr: "27 CFR §5.70",
      url: sec(5, "E", "5.70"),
    },
    nameAndAddress: {
      basis: "Spirits must show the name and address of the bottler, distiller, or importer.",
      cfr: "27 CFR §5.66",
      url: sec(5, "E", "5.66"),
    },
    countryOfOrigin: {
      basis: "Imported distilled spirits must state the country of origin.",
      cfr: "27 CFR §5.69",
      url: sec(5, "E", "5.69"),
    },
    healthWarningStatement: WARNING,
  },
  wine: {
    brandName: { basis: "A wine label must bear a brand name.", cfr: "27 CFR §4.33", url: sec(4, "D", "4.33") },
    classType: {
      basis: "Wine must bear a class and type (or other permitted) designation.",
      cfr: "27 CFR §4.34",
      url: sec(4, "D", "4.34"),
    },
    alcoholContent: {
      basis: "Wine must state its alcoholic content where required for its class/type.",
      cfr: "27 CFR §4.36",
      url: sec(4, "D", "4.36"),
    },
    netContents: {
      basis: "Wine must state the net contents of the container.",
      cfr: "27 CFR §4.37",
      url: sec(4, "D", "4.37"),
    },
    nameAndAddress: {
      basis: "Wine must show the name and address of the bottler, packer, or importer.",
      cfr: "27 CFR §4.35",
      url: sec(4, "D", "4.35"),
    },
    // countryOfOrigin intentionally omitted: for imported wine, country-of-origin marking is governed by
    // U.S. Customs & Border Protection (19 CFR part 134), not a dedicated TTB part-4 section → null.
    healthWarningStatement: WARNING,
  },
  "malt-beverage": {
    brandName: {
      basis: "A malt beverage label must bear a brand name.",
      cfr: "27 CFR §7.64",
      url: sec(7, "E", "7.64"),
    },
    classType: {
      basis: "Malt beverages must bear a class, type, or other designation.",
      cfr: "27 CFR §7.63",
      url: sec(7, "E", "7.63"),
    },
    alcoholContent: {
      basis: "Malt beverage alcohol content must be stated where required.",
      cfr: "27 CFR §7.65",
      url: sec(7, "E", "7.65"),
    },
    netContents: {
      basis: "Malt beverages must state the net contents of the container.",
      cfr: "27 CFR §7.70",
      url: sec(7, "E", "7.70"),
    },
    nameAndAddress: {
      basis: "Malt beverages must show the name and address of the bottler or importer.",
      cfr: "27 CFR §7.66",
      url: sec(7, "E", "7.66"),
    },
    countryOfOrigin: {
      basis: "Imported malt beverages must state the country of origin.",
      cfr: "27 CFR §7.69",
      url: sec(7, "E", "7.69"),
    },
    healthWarningStatement: WARNING,
  },
};

export function citationFor(field: Field, beverageType: BeverageType): Citation | null {
  return CITATIONS[beverageType]?.[field] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/ttb/citations.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify the citation links resolve (QA, not a code change)**

Open 3–4 of the `url` values in a browser (e.g. §5.65, §4.34, §7.64, §16.21) and confirm each loads the named section on ecfr.gov. If any 404s, fix that entry's `sec(...)` arguments and re-run Step 4. (eCFR opens fine in a browser; only automated fetching is blocked.)

- [ ] **Step 6: Commit**

```bash
git add lib/ttb/citations.ts lib/ttb/citations.test.ts
git commit -m "Add TTB regulation citations lookup (field × beverage type)"
```

---

### Task 2: Echo beverageType in the verify response

**Files:**

- Modify: `app/api/verify/route.ts` (the success `NextResponse.json({...})` around line 131)
- Modify: `hooks/use-verify.ts:5` (the `VerifyResponse` type)
- Test: `app/api/verify/route.test.ts`

**Interfaces:**

- Consumes: `parsed.data.beverageType` (already validated `ApplicationData`).
- Produces: response JSON now includes `beverageType: BeverageType`; `VerifyResponse` gains `beverageType: BeverageType`.

- [ ] **Step 1: Add the failing test**

Add to `app/api/verify/route.test.ts` inside `describe("POST /api/verify", ...)`:

```ts
it("echoes the beverageType in the response (for per-field regulation citations)", async () => {
  const res = await POST(request({ source: "sample", bytes: OLD_TOM }));
  const body = await res.json();
  expect(body.beverageType).toBe("distilled-spirits");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test app/api/verify/route.test.ts`
Expected: FAIL — `body.beverageType` is `undefined`.

- [ ] **Step 3: Implement — add beverageType to the response**

In `app/api/verify/route.ts`, change the success return (currently):

```ts
return NextResponse.json({ ...result, processingMs: Date.now() - started, tier, provider: provider.name });
```

to:

```ts
return NextResponse.json({
  ...result,
  processingMs: Date.now() - started,
  tier,
  provider: provider.name,
  beverageType: parsed.data.beverageType,
});
```

In `hooks/use-verify.ts`, change the import and type:

```ts
import type { ApplicationData, BeverageType, VerificationResult } from "@/lib/schema";

export type VerifyResponse = VerificationResult & { tier: string; provider: string; beverageType: BeverageType };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test app/api/verify hooks/use-verify.test.ts`
Expected: PASS (all route + hook tests green).

- [ ] **Step 5: Commit**

```bash
git add app/api/verify/route.ts hooks/use-verify.ts app/api/verify/route.test.ts
git commit -m "Echo beverageType in verify response for field citations"
```

---

### Task 3: ThemeToggle component + no-flash init script

**Files:**

- Create: `components/theme-toggle.tsx`
- Test: `components/theme-toggle.test.tsx`

**Interfaces:**

- Produces: `THEME_INIT_SCRIPT: string` (inline no-flash script body), `applyTheme(theme: Theme): void`, and `<ThemeToggle />`. `type Theme = "light" | "dark" | "system"`.

- [ ] **Step 1: Write the failing test**

```tsx
// components/theme-toggle.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle, applyTheme } from "@/components/theme-toggle";

// jsdom has no matchMedia — stub it (default: system prefers light).
beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }));
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("applyTheme", () => {
  it("adds the dark class for 'dark' and removes it for 'light'", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

describe("ThemeToggle", () => {
  it("selecting Dark persists the choice and darkens the document", async () => {
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
  it("selecting Light persists and lightens", async () => {
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(localStorage.getItem("theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test components/theme-toggle.test.tsx`
Expected: FAIL — cannot resolve `@/components/theme-toggle`.

- [ ] **Step 3: Write the implementation**

```tsx
// components/theme-toggle.tsx
"use client";
import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

export type Theme = "light" | "dark" | "system";

// Runs before hydration (inlined in <head>) to set the class pre-paint — prevents a flash of the wrong theme.
export const THEME_INIT_SCRIPT =
  '(function(){try{var t=localStorage.getItem("theme")||"system";var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();';

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

const OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "system", label: "System", Icon: Monitor },
  { value: "dark", label: "Dark", Icon: Moon },
];

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  // Read the stored choice on mount (client-only, avoids SSR/hydration mismatch).
  useEffect(() => {
    const stored = localStorage.getItem("theme") as Theme | null;
    if (stored === "light" || stored === "dark" || stored === "system") setTheme(stored);
  }, []);

  // Apply + persist on change; while on "system", track OS changes live.
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem("theme", theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
            theme === value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          <Icon aria-hidden className="h-5 w-5" />
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test components/theme-toggle.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add components/theme-toggle.tsx components/theme-toggle.test.tsx
git commit -m "Add hand-rolled ThemeToggle + no-flash init script"
```

---

### Task 4: Wire theme into the layout + migrate layout tokens

**Files:**

- Modify: `app/layout.tsx`

**Interfaces:**

- Consumes: `THEME_INIT_SCRIPT`, `ThemeToggle` from Task 3.

- [ ] **Step 1: Add the no-flash script, the toggle, and migrate tokens**

Edit `app/layout.tsx`:

1. Add imports at top:

```ts
import { ThemeToggle, THEME_INIT_SCRIPT } from "@/components/theme-toggle";
```

2. Add `suppressHydrationWarning` to `<html>` (the init script mutates its class before React), and inject the script in `<head>`:

```tsx
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full bg-background text-foreground">
```

3. Header: `bg-white/85` → `bg-card/85`; `border-stone-200/80` → `border-border`.
4. Brand text: `text-slate-900` → `text-foreground`; `text-slate-500` → `text-muted-foreground`. Keep `bg-emerald-600 text-white` for the logo mark (brand accent).
5. Nav links: `text-slate-700 hover:bg-stone-100 hover:text-slate-900` → `text-muted-foreground hover:bg-muted hover:text-foreground`.
6. Add the toggle at the end of the `<nav>` (after the Batch link), inside the nav's flex row:

```tsx
<span className="ml-1 border-l border-border pl-2">
  <ThemeToggle />
</span>
```

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/layout.tsx
git commit -m "Wire theme toggle + no-flash script into layout; migrate layout to tokens"
```

---

### Task 5: FieldRow — token migration + regulation citation

**Files:**

- Modify: `components/field-row.tsx`
- Test: `components/field-row.test.tsx` (create)

**Interfaces:**

- Consumes: `citationFor` (Task 1), `BeverageType` (schema).
- Produces: `FieldRow` now takes `{ result: FieldResult; beverageType: BeverageType }`.

- [ ] **Step 1: Write the failing test**

```tsx
// components/field-row.test.tsx
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FieldRow } from "@/components/field-row";
import type { FieldResult } from "@/lib/schema";

afterEach(cleanup);

const base: FieldResult = {
  field: "alcoholContent",
  applicationValue: "45% Alc./Vol.",
  labelValue: "45% Alc./Vol.",
  verdict: "MATCH",
  reason: "Matches the application exactly.",
};

describe("FieldRow regulation citation", () => {
  it("renders the basis and a new-tab eCFR link for a cited field", () => {
    render(
      <ul>
        <FieldRow result={base} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText(/Basis:/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /27 CFR §5\.65/ });
    expect(link).toHaveAttribute("href", expect.stringContaining("ecfr.gov"));
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
  it("renders no citation block when the field has none for that beverage type", () => {
    const country: FieldResult = { ...base, field: "countryOfOrigin", reason: "…" };
    render(
      <ul>
        <FieldRow result={country} beverageType="wine" />
      </ul>,
    );
    expect(screen.queryByText(/Basis:/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test components/field-row.test.tsx`
Expected: FAIL — `FieldRow` doesn't accept `beverageType` / renders no "Basis:".

- [ ] **Step 3: Rewrite `components/field-row.tsx`**

```tsx
import { AlertTriangle, CheckCircle2, Scale, XCircle } from "lucide-react";
import type { BeverageType, ExtractedLabel, FieldResult } from "@/lib/schema";
import { FIELD_LABELS } from "@/lib/schema";
import { citationFor } from "@/lib/ttb/citations";

const STYLE = {
  MATCH: {
    icon: CheckCircle2,
    dot: "text-emerald-600 dark:text-emerald-400",
    pill: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300",
    text: "Match",
  },
  MISMATCH: {
    icon: XCircle,
    dot: "text-red-600 dark:text-red-400",
    pill: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300",
    text: "Mismatch",
  },
  REVIEW: {
    icon: AlertTriangle,
    dot: "text-amber-600 dark:text-amber-400",
    pill: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300",
    text: "Needs review",
  },
} as const;

export function FieldRow({ result, beverageType }: { result: FieldResult; beverageType: BeverageType }) {
  const style = STYLE[result.verdict];
  const Icon = style.icon;
  const label = FIELD_LABELS[result.field as keyof typeof FIELD_LABELS] ?? result.field;
  const citation = citationFor(result.field as keyof ExtractedLabel, beverageType);
  return (
    <li className="py-4">
      <div className="flex items-center gap-2">
        <Icon aria-hidden className={`h-6 w-6 shrink-0 ${style.dot}`} />
        <span className="text-lg font-semibold text-foreground">{label}</span>
        <span
          className={`ml-auto rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${style.pill}`}
        >
          {style.text}
        </span>
      </div>
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
      <p className="mt-2 pl-8 text-base text-muted-foreground">{result.reason}</p>
      {citation ? (
        <p className="mt-1.5 pl-8 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-semibold text-foreground">
            <Scale aria-hidden className="h-4 w-4" /> Basis:
          </span>{" "}
          {citation.basis}{" "}
          <a
            href={citation.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-primary underline underline-offset-2 hover:no-underline"
          >
            {citation.cfr} ↗
          </a>
        </p>
      ) : null}
    </li>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test components/field-row.test.tsx`
Expected: PASS (2 tests). (Type errors in `verdict-card.tsx` about the missing `beverageType` prop are expected until Task 6 — do not fix them here.)

- [ ] **Step 5: Commit**

```bash
git add components/field-row.tsx components/field-row.test.tsx
git commit -m "FieldRow: migrate to tokens + show per-field regulation citation"
```

---

### Task 6: VerdictCard — token migration + thread beverageType

**Files:**

- Modify: `components/verdict-card.tsx`

**Interfaces:**

- Consumes: `VerifyResponse.beverageType` (Task 2); `FieldRow` requires `beverageType` (Task 5).

- [ ] **Step 1: Rewrite `components/verdict-card.tsx`**

```tsx
import { CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import type { VerifyResponse } from "@/hooks/use-verify";
import { FieldRow } from "@/components/field-row";

export function VerdictCard({ result }: { result: VerifyResponse }) {
  const pass = result.overall === "PASS";
  const reviews = result.fields.filter((f) => f.verdict === "REVIEW").length;
  const Icon = pass ? CheckCircle2 : XCircle;
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div
        role="status"
        className={`flex items-center gap-4 px-6 py-5 text-white ${
          pass
            ? "bg-gradient-to-r from-emerald-600 to-emerald-500 dark:from-emerald-700 dark:to-emerald-600"
            : "bg-gradient-to-r from-red-600 to-rose-600 dark:from-red-700 dark:to-rose-700"
        }`}
      >
        <Icon aria-hidden className="h-11 w-11 shrink-0" />
        <div>
          <div className="text-4xl font-extrabold tracking-wide">{result.overall}</div>
          <p className="mt-0.5 text-base font-medium text-white/90">
            {pass ? "No mismatches found." : "One or more fields don’t match the application."}
          </p>
        </div>
      </div>

      <div className="px-5 py-5 sm:px-6">
        {pass && reviews > 0 ? (
          <div
            role="status"
            className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-lg font-semibold text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
          >
            <AlertTriangle aria-hidden className="h-6 w-6 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>
              {reviews} item{reviews === 1 ? " needs" : "s need"} your review before approving
            </span>
          </div>
        ) : null}

        <ul className="divide-y divide-border">
          {result.fields.map((f) => (
            <FieldRow key={f.field} result={f} beverageType={result.beverageType} />
          ))}
        </ul>

        {result.warnings.length > 0 ? (
          <div className="mt-5 rounded-xl border border-border bg-muted p-4 text-base text-muted-foreground">
            <p className="mb-1 font-semibold text-foreground">Notes</p>
            <ul className="list-disc space-y-1 pl-5">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="mt-5 border-t border-border pt-3 text-right text-sm text-muted-foreground">
          Checked in {(result.processingMs / 1000).toFixed(1)} s · tier: {result.tier}
          {result.tier === "cloud" ? ` (${result.provider})` : ""}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run the component tests + typecheck**

Run: `pnpm test components/ && pnpm typecheck`
Expected: PASS; typecheck clean (the `beverageType` prop is now supplied).

- [ ] **Step 3: Commit**

```bash
git add components/verdict-card.tsx
git commit -m "VerdictCard: migrate to tokens + pass beverageType to FieldRow"
```

---

### Task 7: BatchTable — token migration + verdict dark variants

**Files:**

- Modify: `components/batch-table.tsx`

- [ ] **Step 1: Apply substitutions**

In `components/batch-table.tsx` make these exact replacements:

- `StatusPill` done-pass: `border-emerald-200 bg-emerald-50 text-emerald-700` → append ` dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300`.
- `StatusPill` done-fail + error: `border-red-200 bg-red-50 text-red-700` → append ` dark:border-red-900 dark:bg-red-950/50 dark:text-red-300`.
- `StatusPill` queued/running: `border-stone-200 bg-stone-100 text-slate-500` → `border-border bg-muted text-muted-foreground`.
- Section wrapper: `border-stone-200 bg-white` → `border-border bg-card`.
- Header row + divider: `border-stone-100` → `border-border`; heading `text-slate-900` → `text-foreground`; label `text-slate-600` → `text-muted-foreground`.
- Table head row: `border-stone-200 text-slate-500` → `border-border text-muted-foreground`.
- Body rows: `border-stone-100` → `border-border`; filename cell `text-slate-700` → `text-foreground`.
- Details toggle button: `text-emerald-700 hover:text-emerald-800` → `text-primary hover:text-primary/80`.
- Empty/error cell: `text-slate-500` → `text-muted-foreground`.

- [ ] **Step 2: Typecheck + lint + tests**

Run: `pnpm typecheck && pnpm lint && pnpm test components/`
Expected: clean / PASS.

- [ ] **Step 3: Commit**

```bash
git add components/batch-table.tsx
git commit -m "BatchTable: migrate to tokens + dark verdict variants"
```

---

### Task 8: Single-label page — token migration

**Files:**

- Modify: `app/page.tsx`

- [ ] **Step 1: Apply substitutions**

In `app/page.tsx`:

- `Step` section: `border-stone-200 bg-white` → `border-border bg-card`; divider `border-stone-100` → `border-border`; badge `bg-slate-900 text-white` → `bg-primary text-primary-foreground`; heading `text-slate-900` → `text-foreground`.
- H1 `text-slate-900` → `text-foreground`; intro `text-slate-600` → `text-muted-foreground`.
- Sample hint: `text-slate-600` → `text-muted-foreground`; `text-emerald-600` (Sparkles) unchanged (brand accent) but add `dark:text-emerald-400`.
- Sample buttons: `border-stone-300 bg-white hover:border-emerald-400 hover:bg-emerald-50` → `border-border bg-card hover:border-emerald-400 hover:bg-emerald-50 dark:hover:border-emerald-500 dark:hover:bg-emerald-950/40`; `text-slate-800` → `text-foreground`; `text-slate-500` → `text-muted-foreground`.
- Result heading `text-slate-900` → `text-foreground`.
- Loading card: `border-stone-200 bg-white` → `border-border bg-card`; spinner `text-emerald-600` → `text-emerald-600 dark:text-emerald-400`; text `text-slate-600` → `text-muted-foreground`.
- Error card: `border-red-200 bg-red-50` → `border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/50`; `text-red-800`/`text-red-700` → append ` dark:text-red-300`/` dark:text-red-300`.
- Empty state: `border-stone-300 bg-white/60` → `border-border bg-card/60`; `text-stone-400` → `text-muted-foreground`; `text-slate-500` → `text-muted-foreground`; `text-slate-700` → `text-foreground`.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "Single-label page: migrate to theme tokens"
```

---

### Task 9: Batch page + ApplicationForm + UploadZone — token migration

**Files:**

- Modify: `app/batch/page.tsx`, `components/application-form.tsx`, `components/upload-zone.tsx`

- [ ] **Step 1: `app/batch/page.tsx` substitutions**

- `FILE_INPUT_CLASS`: `border-stone-300 bg-white text-slate-600` → `border-input bg-card text-muted-foreground`; `file:border-stone-200 file:bg-stone-100 file:text-slate-700 hover:file:bg-stone-200` → `file:border-border file:bg-muted file:text-foreground hover:file:bg-muted/70`.
- H1 `text-slate-900` → `text-foreground`; intro `text-slate-600` → `text-muted-foreground`.
- Section wrappers: `border-stone-200 bg-white` → `border-border bg-card`.
- Template button: `border-stone-300 bg-white text-slate-700 hover:bg-stone-100` → `border-border bg-card text-foreground hover:bg-muted`; icon `text-emerald-600` → append ` dark:text-emerald-400`.
- Labels `text-slate-800` → `text-foreground`; helper text `text-slate-600`/`text-slate-500` → `text-muted-foreground`.
- Any remaining `border-stone-*`, `bg-white`, `bg-stone-*`, `text-slate-*` per the token map above.

- [ ] **Step 2: `components/application-form.tsx` substitutions**

Apply the token map: `text-slate-900/800/700` → `text-foreground`; `text-slate-600/500` → `text-muted-foreground`; input borders `border-stone-300` → `border-input`; `bg-white` → `bg-card` (or `bg-background` for inputs to match shadcn); focus rings to `focus-visible:ring-ring`; error text keep red but add `dark:text-red-400`. (Open the file and replace every hardcoded slate/stone/white occurrence — there are ~15.)

- [ ] **Step 3: `components/upload-zone.tsx` substitutions**

Apply the token map: dropzone border `border-stone-300` → `border-border`; hover/active states using `emerald`/`stone` → keep emerald accent (+ `dark:` variant) and map stone→muted; text `text-slate-*` → `text-foreground`/`text-muted-foreground`; `bg-white`/`bg-stone-50` → `bg-card`/`bg-muted`. (There are ~14 occurrences.)

- [ ] **Step 4: Typecheck + lint + full unit suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: clean; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/batch/page.tsx components/application-form.tsx components/upload-zone.tsx
git commit -m "Batch page, form, and upload zone: migrate to theme tokens"
```

---

### Task 10: Production browser verification (both themes, no-flash, CSP, citation link)

**Files:** none (verification only).

- [ ] **Step 1: Build and start the production server**

Run:

```bash
pnpm build && (pnpm start -p 3131 &) && sleep 3
```

Expected: build succeeds; server responds.

- [ ] **Step 2: Verify headers + both themes render with no CSP violations**

Using the Playwright MCP (or a browser):

1. `curl -sI http://localhost:3131/` — confirm the `Content-Security-Policy` header is present and unchanged.
2. Navigate to `http://localhost:3131/`, check console — **zero errors/CSP violations**.
3. Click the **Dark** theme button; confirm the page switches to dark and `<html class="dark">`.
4. Reload — confirm it stays dark with **no flash** of light (the init script ran).
5. Load the "Old Tom Distillery" sample, click **Verify label**, and confirm each field row shows a "⚖ Basis:" line with a `27 CFR §…` link; console still clean in dark mode.
6. Click **System**; confirm it follows the OS preference.

- [ ] **Step 3: Stop the server**

Run: `fuser -k 3131/tcp` (or kill the background job).

- [ ] **Step 4: Final commit (if any doc/verification notes)**

No code changes expected. If Step 2 surfaced a fix, commit it with a descriptive message and re-run the relevant task's tests.

---

## Self-Review

**Spec coverage:**

- Theme provider (no-flash script + toggle + system live-update) → Tasks 3, 4. ✓
- Token migration across layout + all components/pages → Tasks 4–9. ✓
- Verdict-color dark variants → Tasks 5, 6, 7. ✓
- Three-way segmented header control → Task 3 (component) + Task 4 (placement). ✓
- Citations pure module keyed by (field, beverageType), verified → Task 1. ✓
- Render-time lookup, matching untouched → Tasks 5, 6 (citation read in FieldRow; `lib/matching` never imported/changed). ✓
- beverageType available at render (single + batch) → Task 2 (echo in response; VerdictCard reads `result.beverageType`, so batch works with no extra wiring). ✓
- Always-visible inline "⚖ Basis + 27 CFR §x.y ↗" with new-tab link → Task 5. ✓
- Tests: citations unit, field-row render, theme toggle, prod browser check → Tasks 1, 5, 3, 10. ✓
- Backlog (history / richer labels / Romance OCR) → out of scope, in the spec. ✓

**Placeholder scan:** No TBD/TODO; all code shown in full for logic files; migration files list exact class substitutions. Citation data is real and verified (Task 1).

**Type consistency:** `citationFor(field, beverageType)` signature matches its use in FieldRow; `VerifyResponse.beverageType` (Task 2) matches `result.beverageType` read in VerdictCard (Task 6); `FieldRow` prop `{ result, beverageType }` (Task 5) matches the call site in VerdictCard (Task 6); `Theme`, `THEME_INIT_SCRIPT`, `applyTheme`, `ThemeToggle` (Task 3) match their use in the layout (Task 4).

**Ambiguity:** Verdict colors kept as explicit Tailwind palette + `dark:` variants (not tokens) — deliberate, stated in Global Constraints.
