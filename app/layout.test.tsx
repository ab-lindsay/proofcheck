// app/layout.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import RootLayout, { metadata, viewport } from "@/app/layout";

// next/font/google requires network access to fetch font files at build time, which isn't
// available (and shouldn't be needed) in a unit test. Stub it with the same shape the real
// loader returns (an object exposing `.variable`) so `layout.tsx`'s `${geistSans.variable}`
// interpolation still works.
vi.mock("next/font/google", () => ({
  Public_Sans: () => ({ variable: "--font-public-sans" }),
  Roboto_Mono: () => ({ variable: "--font-roboto-mono" }),
  Merriweather: () => ({ variable: "--font-merriweather" }),
}));

// RootLayout mounts ThemeToggle, whose mount effect calls matchMedia (see
// components/theme-toggle.test.tsx for the same stub) — jsdom has no matchMedia implementation.
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

  // React's dev-mode DOM nesting validator logs "In HTML, <html> cannot be a child of <div>"
  // via console.error the first time it sees RootLayout's <html> land inside RTL's container div
  // (see the file-level comment above). That nesting is an accepted, known consequence of testing
  // a root layout directly, not a real defect, so it's filtered out here — anything else still
  // reaches the real console.error so unrelated failures stay visible. The format-string args are
  // matched too (not just the message text) so only this exact <html>-inside-<div> warning is
  // swallowed; any other DOM-nesting warning (e.g. a real future regression) still reaches the
  // real console.error.
  const realError = console.error.bind(console);
  vi.spyOn(console, "error").mockImplementation((message, ...rest) => {
    if (
      typeof message === "string" &&
      message.includes("cannot be a child of") &&
      rest[0] === "<html>" &&
      rest[1] === "div"
    ) {
      return;
    }
    realError(message, ...rest);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// RootLayout renders a full <html>/<body> shell, which is what Next.js App Router mounts it as
// in production. Testing Library's `render` always mounts into a container appended under the
// real `document.body`, so rendering RootLayout directly nests a second <html>/<body> pair inside
// the live document. That's invalid markup (React's dev-mode DOM nesting validator will warn about
// it), but jsdom's DOM implementation doesn't reject the append, and dom-testing-library's queries
// walk the full descendant tree regardless of tag semantics — so `screen` queries still find every
// element correctly. There's no existing precedent in this repo for testing a layout/shell
// component, so this accepts the harmless nesting rather than reaching for a heavier fix (e.g.
// hand-rolling a portal or duck-typing the tree) for a one-off root layout with no real branching
// logic to isolate.
describe("RootLayout", () => {
  it("renders the header brand", () => {
    render(<RootLayout>content</RootLayout>);
    expect(screen.getByText("ProofCheck")).toBeInTheDocument();
    expect(screen.getByText("TTB label verification")).toBeInTheDocument();
    const brandLink = screen.getByRole("link", { name: /ProofCheck/ });
    expect(brandLink).toHaveAttribute("href", "/");
  });

  it("renders the Single label and Batch nav links", () => {
    render(<RootLayout>content</RootLayout>);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Single label" })).toHaveAttribute("href", "/");
    expect(within(nav).getByRole("link", { name: "Batch" })).toHaveAttribute("href", "/batch");
  });

  it("renders a skip-to-content link targeting #main-content", () => {
    render(<RootLayout>content</RootLayout>);
    const skipLink = screen.getByRole("link", { name: "Skip to main content" });
    expect(skipLink).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("mounts ThemeToggle", () => {
    render(<RootLayout>content</RootLayout>);
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeInTheDocument();
  });

  it("mounts TierSwitcher when dev mode is already on", () => {
    localStorage.setItem("devMode", "true");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cloudAvailable: true }) }));
    render(<RootLayout>content</RootLayout>);
    expect(screen.getByRole("radiogroup", { name: "Extraction tier" })).toBeInTheDocument();
  });

  it("renders children inside <main>", () => {
    render(
      <RootLayout>
        <p>page body</p>
      </RootLayout>,
    );
    expect(within(screen.getByRole("main")).getByText("page body")).toBeInTheDocument();
  });

  it("exports metadata with a title and description", () => {
    expect(metadata.title).toBe("ProofCheck — TTB label verification");
    expect(metadata.description).toBe("Checks alcohol label artwork against its application data.");
  });

  it("exports viewport theme-color entries for both color schemes", () => {
    expect(viewport.themeColor).toEqual([
      { media: "(prefers-color-scheme: light)", color: "#faf8f3" },
      { media: "(prefers-color-scheme: dark)", color: "#15130f" },
    ]);
  });

  it("renders the independence disclaimer", () => {
    render(<RootLayout>content</RootLayout>);
    expect(
      screen.getByText(/Independent compliance tool — not affiliated with the U\.S\. Department of the Treasury/),
    ).toBeInTheDocument();
  });
});
