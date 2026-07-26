// components/theme-toggle.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ThemeToggle, applyTheme, THEME_INIT_SCRIPT } from "@/components/theme-toggle";

// jsdom has no matchMedia — stub it with a controllable, spy-backed implementation so tests can
// (a) drive "matches" (the simulated OS preference) and (b) capture/invoke the "change" listener
// the component registers, instead of asserting only that some function was called.
let mediaMatches = false;
let addEventListenerSpy: ReturnType<typeof vi.fn>;
let removeEventListenerSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mediaMatches = false;
  addEventListenerSpy = vi.fn();
  removeEventListenerSpy = vi.fn();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return mediaMatches;
    },
    media: query,
    addEventListener: addEventListenerSpy,
    removeEventListener: removeEventListenerSpy,
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

// The pre-paint no-flash guarantee lives in THEME_INIT_SCRIPT (inlined in <head>), a hand-written mirror
// of applyTheme's decision (stored choice → dark bool; "system" → OS preference). Cover the shared
// "system" resolution through applyTheme, and static-check that the inlined script still encodes the same
// contract — without executing a code string (no new Function/eval in the suite).
describe("system-preference resolution (pre-paint no-flash path)", () => {
  it("applyTheme('system') follows the live OS preference in both directions", () => {
    mediaMatches = true; // OS prefers dark
    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    mediaMatches = false; // OS prefers light
    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
  it("THEME_INIT_SCRIPT encodes the same contract (reads stored theme + OS, toggles the dark class)", () => {
    expect(THEME_INIT_SCRIPT).toContain('localStorage.getItem("theme")');
    expect(THEME_INIT_SCRIPT).toContain("prefers-color-scheme: dark");
    expect(THEME_INIT_SCRIPT).toContain('classList.toggle("dark"');
  });
});

describe("ThemeToggle", () => {
  it("selecting Dark persists the choice and darkens the document", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
  it("selecting Light persists and lightens", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(localStorage.getItem("theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("does not flash to the OS preference or clobber a stored choice on mount", () => {
    // Stored preference is "dark" while the simulated OS preference is light (mediaMatches stays
    // false). If the apply effect ever ran with the pre-hydration "system" default, it would flip
    // the class to light (based on OS) and overwrite localStorage with "system" before the real
    // stored value lands — this asserts that never happens.
    localStorage.setItem("theme", "dark");
    document.documentElement.classList.add("dark"); // what THEME_INIT_SCRIPT would have set pre-paint
    render(<ThemeToggle />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
  });
});

describe("ThemeToggle — system theme tracks OS changes live", () => {
  it("selecting System persists the choice and registers a matchMedia change listener", () => {
    localStorage.setItem("theme", "light");
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(localStorage.getItem("theme")).toBe("system");
    expect(addEventListenerSpy).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("reacts to a live OS preference change while on System", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    const [, handler] = addEventListenerSpy.mock.calls.find(([event]) => event === "change")!;
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    mediaMatches = true; // OS switches to dark
    handler({ matches: true });

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("removes the matchMedia listener when switching away from System", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    const [, handler] = addEventListenerSpy.mock.calls.find(([event]) => event === "change")!;

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));

    expect(removeEventListenerSpy).toHaveBeenCalledWith("change", handler);
  });

  it("removes the matchMedia listener on unmount", () => {
    const { unmount } = render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    const [, handler] = addEventListenerSpy.mock.calls.find(([event]) => event === "change")!;

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith("change", handler);
  });
});
