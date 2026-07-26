import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ModelPicker } from "@/components/model-picker";

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

describe("ModelPicker", () => {
  it("renders nothing when dev mode is off", () => {
    localStorage.setItem("devMode", "false");
    const { container } = render(<ModelPicker />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders both model options when dev mode is on", () => {
    stubFetch(true);
    render(<ModelPicker />);
    expect(screen.getByRole("radio", { name: "Haiku 4.5" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Opus 4.5" })).toBeInTheDocument();
  });

  it("defaults to Haiku selected", () => {
    stubFetch(true);
    render(<ModelPicker />);
    expect(screen.getByRole("radio", { name: "Haiku 4.5" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Opus 4.5" })).toHaveAttribute("aria-checked", "false");
  });

  // Fail closed (mirrors tier-switcher.test.tsx): a model choice must never look live when it can't
  // possibly take effect — route.ts only honors devBedrockModel when the selected provider is bedrock.
  it("disables both options until the server confirms a cloud key is configured", async () => {
    stubFetch(false);
    render(<ModelPicker />);
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Haiku 4.5" })).toHaveAttribute("aria-disabled", "true"),
    );
    expect(screen.getByRole("radio", { name: "Opus 4.5" })).toHaveAttribute("aria-disabled", "true");
  });

  it("disables both options when the availability fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<ModelPicker />);
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Haiku 4.5" })).toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("enables both options once the server reports a cloud key is configured", async () => {
    stubFetch(true);
    render(<ModelPicker />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Haiku 4.5" })).not.toHaveAttribute("aria-disabled"));
    expect(screen.getByRole("radio", { name: "Opus 4.5" })).not.toHaveAttribute("aria-disabled");
  });

  it("clicking a model while disabled does not select it or touch storage", async () => {
    stubFetch(false);
    render(<ModelPicker />);
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Opus 4.5" })).toHaveAttribute("aria-disabled", "true"),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Opus 4.5" }));
    expect(screen.getByRole("radio", { name: "Opus 4.5" })).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("devBedrockModel")).toBeNull();
  });

  it("selecting Opus persists the choice once enabled", async () => {
    stubFetch(true);
    render(<ModelPicker />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Opus 4.5" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(screen.getByRole("radio", { name: "Opus 4.5" }));
    expect(screen.getByRole("radio", { name: "Opus 4.5" })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("devBedrockModel")).toBe("opus");
  });

  it("selecting Haiku persists the choice once enabled", async () => {
    localStorage.setItem("devBedrockModel", "opus");
    stubFetch(true);
    render(<ModelPicker />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Haiku 4.5" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(screen.getByRole("radio", { name: "Haiku 4.5" }));
    expect(screen.getByRole("radio", { name: "Haiku 4.5" })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("devBedrockModel")).toBe("haiku");
  });

  it("Opus button has warning styling when selected", async () => {
    stubFetch(true);
    render(<ModelPicker />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Opus 4.5" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(screen.getByRole("radio", { name: "Opus 4.5" }));
    const opusBtn = screen.getByRole("radio", { name: "Opus 4.5" });
    expect(opusBtn.className).toContain("bg-amber");
  });
});
