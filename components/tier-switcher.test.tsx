import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TierSwitcher } from "@/components/tier-switcher";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("devMode", "true");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(cloudAvailable: boolean) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cloudAvailable }) }));
}

describe("TierSwitcher", () => {
  it("renders nothing when dev mode is off", () => {
    localStorage.setItem("devMode", "false");
    stubFetch(true);
    const { container } = render(<TierSwitcher />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders all four tier options when dev mode is on", () => {
    stubFetch(true);
    render(<TierSwitcher />);
    expect(screen.getByRole("radio", { name: "Auto" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Local OCR" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Local LLM" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Cloud" })).toBeInTheDocument();
  });

  // Idempotence: turning dev mode on must not change any verdict, so the default tier has to mean
  // "route exactly as the app does with dev mode off" (bundled samples -> their mock fixtures).
  it("defaults to Auto selected, so enabling dev mode changes no verdict", () => {
    stubFetch(true);
    render(<TierSwitcher />);
    expect(screen.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-checked", "false");
  });

  it("enables Cloud once the server reports it's available", async () => {
    stubFetch(true);
    render(<TierSwitcher />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Cloud" })).not.toHaveAttribute("aria-disabled"));
  });

  it("disables Cloud when the server reports no cloud key is configured", async () => {
    stubFetch(false);
    render(<TierSwitcher />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-disabled", "true"));
  });

  it("disables Cloud when the availability fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<TierSwitcher />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-disabled", "true"));
  });

  it("self-corrects a stored Cloud selection to Auto when the server reports no key configured", async () => {
    // Cloud is no longer the default, so reaching here means it was explicitly chosen (or stored
    // from a session where a key existed). Leaving it selected would 400 every verify; Auto is the
    // safe landing spot because it is exactly what the app does outside dev mode.
    localStorage.setItem("devTier", "cloud");
    stubFetch(false);
    render(<TierSwitcher />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("devTier")).toBe("auto");
  });

  it("self-corrects a stored Cloud selection to Auto when the availability fetch fails", async () => {
    localStorage.setItem("devTier", "cloud");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<TierSwitcher />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-checked", "false");
  });

  it("stays on Cloud once the server confirms it's available (no regression)", async () => {
    localStorage.setItem("devTier", "cloud");
    stubFetch(true);
    render(<TierSwitcher />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Cloud" })).not.toHaveAttribute("aria-disabled"));
    expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-checked", "true");
  });

  it("does not override an explicit non-Cloud selection when Cloud later proves unavailable", async () => {
    stubFetch(false);
    render(<TierSwitcher />);
    // User picks Local LLM before the availability fetch resolves.
    fireEvent.click(screen.getByRole("radio", { name: "Local LLM" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-disabled", "true"));
    expect(screen.getByRole("radio", { name: "Local LLM" })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("devTier")).toBe("local-llm");
  });

  it("selecting Local OCR persists the choice", () => {
    stubFetch(true);
    render(<TierSwitcher />);
    fireEvent.click(screen.getByRole("radio", { name: "Local OCR" }));
    expect(screen.getByRole("radio", { name: "Local OCR" })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("devTier")).toBe("local-ocr");
  });

  it("clicking Cloud while disabled does not select it", async () => {
    stubFetch(false);
    render(<TierSwitcher />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(screen.getByRole("radio", { name: "Cloud" }));
    expect(screen.getByRole("radio", { name: "Cloud" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
  });

  it("selecting Auto persists the choice, returning to normal routing", () => {
    stubFetch(true);
    render(<TierSwitcher />);
    fireEvent.click(screen.getByRole("radio", { name: "Local OCR" }));
    expect(localStorage.getItem("devTier")).toBe("local-ocr");
    fireEvent.click(screen.getByRole("radio", { name: "Auto" }));
    expect(screen.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("devTier")).toBe("auto");
  });
});
