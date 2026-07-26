import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ExtractionTrace } from "@/lib/vision/escalation/types";
import { ExtractionTrail } from "@/components/extraction-trail";

const trace: ExtractionTrace = {
  tier: "gemini",
  baselineWeakFields: ["healthWarningStatement"],
  extraCalls: 2,
  totalMs: 2400,
  stoppedBecause: "cap",
  attempts: [
    {
      transform: "crop",
      targetFields: ["healthWarningStatement"],
      durationMs: 900,
      outcome: "improved",
      improvedFields: ["healthWarningStatement"],
    },
    {
      transform: "enhance",
      targetFields: ["brandName"],
      durationMs: 800,
      outcome: "failed",
      improvedFields: [],
      error: "call-failed",
    },
  ],
};

describe("ExtractionTrail", () => {
  it("lists each attempt with its transform and outcome", () => {
    render(<ExtractionTrail trace={trace} />);
    expect(screen.getByText("crop")).toBeInTheDocument();
    expect(screen.getByText("improved")).toBeInTheDocument();
    expect(screen.getByText("enhance")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("shows why the ladder stopped and how many extra calls it spent", () => {
    render(<ExtractionTrail trace={trace} />);
    expect(screen.getByText(/hit the attempt cap/)).toBeInTheDocument();
    expect(screen.getByText(/2 extra extraction calls/)).toBeInTheDocument();
  });

  it("surfaces the repair error CATEGORY (never a raw provider message — invariant 5)", () => {
    render(<ExtractionTrail trace={trace} />);
    expect(screen.getByText(/call-failed/)).toBeInTheDocument();
  });

  it("renders nothing when no repair was attempted", () => {
    const { container } = render(
      <ExtractionTrail trace={{ ...trace, attempts: [], extraCalls: 0, stoppedBecause: "clean" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
