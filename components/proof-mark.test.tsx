import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ProofMark } from "@/components/proof-mark";

afterEach(cleanup);

describe("ProofMark", () => {
  it("renders an SVG with aria-hidden and focusable=false", () => {
    const { container } = render(<ProofMark />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
  });

  it("uses paper variant colors by default", () => {
    const { container } = render(<ProofMark />);
    const rects = container.querySelectorAll("rect");
    expect(rects[0]).toHaveAttribute("fill", "#faf8f3");
  });

  it("uses navy variant colors when variant=navy", () => {
    const { container } = render(<ProofMark variant="navy" />);
    const rects = container.querySelectorAll("rect");
    expect(rects[0]).toHaveAttribute("fill", "#142c46");
  });

  it("applies the className prop", () => {
    const { container } = render(<ProofMark className="h-8 w-8" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveClass("h-8", "w-8");
  });

  it("has a 40x40 viewBox", () => {
    const { container } = render(<ProofMark />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("viewBox", "0 0 40 40");
  });
});
