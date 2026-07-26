import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { confidenceExplanation, FieldDetails } from "./field-details";
import { CONFIDENCE_HIGH_THRESHOLD, CONFIDENCE_NEEDS_CORRECTION_THRESHOLD } from "@/lib/matching/verify";
import type { FieldResult } from "@/lib/schema";

afterEach(cleanup);

describe("confidenceExplanation", () => {
  // Boundaries are read from the same constants field-row's visible tier uses. Hard-coding numbers
  // here would let the two drift apart again — the original bug was a tooltip reading "Partial
  // match" beside a label reading "Confidence: High (94%)".
  it("describes a clear read at and above the High threshold", () => {
    expect(confidenceExplanation(CONFIDENCE_HIGH_THRESHOLD)).toMatch(/^Read clearly\./);
    expect(confidenceExplanation(1.0)).toMatch(/^Read clearly\./);
  });

  it("describes an uncertain read between the Review and High thresholds", () => {
    expect(confidenceExplanation(CONFIDENCE_NEEDS_CORRECTION_THRESHOLD)).toMatch(/^Read with some uncertainty\./);
    expect(confidenceExplanation(CONFIDENCE_HIGH_THRESHOLD - 0.01)).toMatch(/^Read with some uncertainty\./);
  });

  it("describes a low-confidence read below the Review threshold", () => {
    expect(confidenceExplanation(CONFIDENCE_NEEDS_CORRECTION_THRESHOLD - 0.01)).toMatch(/^Read with low confidence/);
    expect(confidenceExplanation(0)).toMatch(/^Read with low confidence/);
  });

  // The regression this pins: confidence is the extractor's self-reported READING confidence, which
  // verify.ts treats as untrusted. Earlier copy turned it into verdict language ("Exact match — all
  // characters verified") that rendered inside NON_COMPLIANT rows, and invented a character count that
  // nothing in the codebase counts.
  it("never states match facts or character counts at any confidence", () => {
    for (const c of [0, 0.25, 0.49, 0.5, 0.79, 0.8, 0.94, 0.95, 0.99, 1.0]) {
      const text = confidenceExplanation(c);
      expect(text).not.toMatch(/exact match|partial match|all characters verified|character\(s\)/i);
      expect(text).toMatch(/not whether it matches/);
    }
  });

  // The low band renders beside NON_COMPLIANT rows too, where confidence changed nothing — the copy
  // must not claim the score caused a flag (and "review" is not in the verdict vocabulary anyway).
  it("low confidence copy never claims the field was flagged because of the score", () => {
    expect(confidenceExplanation(0.2)).not.toMatch(/flagged for review/i);
  });
});

const field: FieldResult = {
  field: "brandName",
  applicationValue: "OLD TOM DISTILLERY",
  labelValue: "OLD TOM DISTILLERY",
  verdict: "COMPLIANT",
  confidence: 1.0,
  reason: "Matches the application exactly.",
};

// The accessible name carries the field it belongs to: a verdict card renders one pair of these
// buttons per field row, and identically-named buttons are indistinguishable to a screen-reader
// user tabbing through the card.
const HELPFUL = "Mark the Brand name explanation as helpful";
const NOT_HELPFUL = "Mark the Brand name explanation as not helpful";

describe("FieldDetails", () => {
  it("renders both feedback controls as real buttons with a visible prompt", () => {
    render(<FieldDetails field={field} />);
    expect(screen.getByText("Was this explanation helpful?")).toBeInTheDocument();
    for (const name of [HELPFUL, NOT_HELPFUL]) {
      const button = screen.getByRole("button", { name });
      // A native <button> is what makes these keyboard-operable; jsdom does not synthesise
      // Enter/Space into clicks, so asserting the element type is the meaningful check here.
      expect(button.tagName).toBe("BUTTON");
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("calls onFeedback with the field name and direction", () => {
    const onFeedback = vi.fn();
    render(<FieldDetails field={field} onFeedback={onFeedback} />);
    fireEvent.click(screen.getByRole("button", { name: HELPFUL }));
    expect(onFeedback).toHaveBeenCalledWith("brandName", "up");
    fireEvent.click(screen.getByRole("button", { name: NOT_HELPFUL }));
    expect(onFeedback).toHaveBeenCalledWith("brandName", "down");
  });

  it("reflects the current feedback state in aria-pressed", () => {
    render(<FieldDetails field={field} feedbackState="up" />);
    expect(screen.getByRole("button", { name: HELPFUL })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: NOT_HELPFUL })).toHaveAttribute("aria-pressed", "false");
  });

  it("does not style feedback controls in verdict colours", () => {
    // These buttons collect an opinion; they never change the verdict (invariant 1). Styling the
    // pressed state with COMPLIANT/NON_COMPLIANT tokens put a green tick inside a red row, where it read as
    // a control that overrides the result.
    render(<FieldDetails field={field} feedbackState="up" />);
    expect(screen.getByRole("button", { name: HELPFUL }).className).not.toMatch(
      /verdict-compliant|verdict-non-compliant/,
    );
  });

  it("is inert when no handler is supplied", () => {
    render(<FieldDetails field={field} />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: HELPFUL }))).not.toThrow();
  });
});
