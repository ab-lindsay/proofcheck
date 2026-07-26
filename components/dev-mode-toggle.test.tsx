// components/dev-mode-toggle.test.tsx
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DevModeToggle } from "@/components/dev-mode-toggle";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("DevModeToggle", () => {
  it("defaults to off", () => {
    render(<DevModeToggle />);
    expect(screen.getByRole("switch", { name: "Dev mode" })).toHaveAttribute("aria-checked", "false");
  });

  it("clicking while off opens the confirmation dialog without enabling yet", () => {
    render(<DevModeToggle />);
    fireEvent.click(screen.getByRole("switch", { name: "Dev mode" }));
    expect(screen.getByText("Enable dev mode?")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Dev mode" })).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("devMode")).toBeNull();
  });

  it("confirming the dialog turns it on and persists the choice", () => {
    render(<DevModeToggle />);
    fireEvent.click(screen.getByRole("switch", { name: "Dev mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(screen.getByRole("switch", { name: "Dev mode" })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("devMode")).toBe("true");
  });

  it("cancelling the dialog leaves it off", () => {
    render(<DevModeToggle />);
    fireEvent.click(screen.getByRole("switch", { name: "Dev mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("switch", { name: "Dev mode" })).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("devMode")).toBeNull();
  });

  it("clicking while on turns it off immediately, no confirmation needed", () => {
    localStorage.setItem("devMode", "true");
    render(<DevModeToggle />);
    fireEvent.click(screen.getByRole("switch", { name: "Dev mode" }));
    expect(screen.getByRole("switch", { name: "Dev mode" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("Enable dev mode?")).not.toBeInTheDocument();
  });
});
