import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { EscalationToggle } from "@/components/escalation-toggle";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("devMode", "true");
});
afterEach(cleanup);

describe("EscalationToggle", () => {
  it("renders nothing when dev mode is off", () => {
    localStorage.setItem("devMode", "false");
    const { container } = render(<EscalationToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  // The ladder is a measured cost with no measured benefit, so OFF must be the resting state — both
  // here and on the server. A default-on toggle would quietly reintroduce the latency it was
  // disabled for.
  it("defaults to off", () => {
    render(<EscalationToggle />);
    const sw = screen.getByRole("switch", { name: "Re-read weak fields" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveTextContent(/off/i);
  });

  // "Escalation ladder" is internal vocabulary; the header must say what the control does.
  it("labels itself in plain English, not internal jargon", () => {
    render(<EscalationToggle />);
    expect(screen.getByText("Re-read weak fields")).toBeInTheDocument();
    expect(screen.queryByText(/ladder/i)).not.toBeInTheDocument();
  });

  it("turns on and persists, then back off", () => {
    render(<EscalationToggle />);
    const sw = screen.getByRole("switch", { name: "Re-read weak fields" });
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("devEscalation")).toBe("true");
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("devEscalation")).toBe("false");
  });

  it("reflects a stored on-value on mount", () => {
    localStorage.setItem("devEscalation", "true");
    render(<EscalationToggle />);
    expect(screen.getByRole("switch", { name: "Re-read weak fields" })).toHaveAttribute("aria-checked", "true");
  });
});
