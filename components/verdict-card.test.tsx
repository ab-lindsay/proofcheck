import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { VerdictCard } from "@/components/verdict-card";
import type { VerifyResponse } from "@/hooks/use-verify";
import type { ExtractionTrace } from "@/lib/vision/escalation/types";
import { setDevMode } from "@/hooks/use-dev-mode";

const result: VerifyResponse = {
  overall: "REJECTED",
  fields: [
    {
      field: "brandName",
      applicationValue: "X",
      labelValue: "X",
      verdict: "COMPLIANT",
      reason: "Matches the application exactly.",
      confidence: 0.95,
    },
    {
      field: "healthWarningStatement",
      applicationValue: "GOVERNMENT WARNING: ...",
      labelValue: "Government Warning: ...",
      verdict: "NON_COMPLIANT",
      reason: '"GOVERNMENT WARNING" must appear in capital letters — the label shows "Government Warning:".',
      confidence: 0.78,
    },
  ],
  warnings: ["Bold formatting cannot be verified from extracted text — check visually."],
  processingMs: 812,
  tier: "mock",
  provider: "mock",
  beverageType: "distilled-spirits",
};

describe("VerdictCard", () => {
  it("shows the REJECTED banner, plain-English reason, warnings, and timing", () => {
    render(<VerdictCard result={result} />);
    expect(screen.getByText("REJECTED")).toBeInTheDocument();
    expect(screen.getByText(/capital letters/)).toBeInTheDocument();
    expect(screen.getByText(/check visually/i)).toBeInTheDocument();
    expect(screen.getByText(/0\.8\s?s/)).toBeInTheDocument();
    expect(screen.getByText("Health warning statement")).toBeInTheDocument();
  });
  it('shows "< 0.1 s" instead of a misleading "0.0 s" for near-instant (mock-tier) results', () => {
    render(<VerdictCard result={{ ...result, processingMs: 4 }} />);
    expect(screen.getByText("Checked in < 0.1 s")).toBeInTheDocument();
    expect(screen.queryByText(/checked in 0\.0 s/i)).not.toBeInTheDocument();
  });

  it("threads beverageType into per-field citations: distilled-spirits alcohol content links §5.65", () => {
    const spirits: VerifyResponse = {
      ...result,
      overall: "APPROVED",
      beverageType: "distilled-spirits",
      fields: [
        {
          field: "alcoholContent",
          applicationValue: "45% Alc./Vol.",
          labelValue: "45% Alc./Vol.",
          verdict: "COMPLIANT",
          reason: "ok",
          confidence: 0.95,
        },
      ],
    };
    render(<VerdictCard result={spirits} />);
    const link = screen.getByRole("link", { name: /27 CFR §5\.65/ });
    expect(link).toHaveAttribute("href", expect.stringContaining("ecfr.gov"));
  });
  it("keys citations off the threaded beverageType: the same field cites a different section for wine (§4.34)", () => {
    // Proves the citation is looked up from result.beverageType, not hardcoded — a wrong-type/field-swap
    // wiring bug would otherwise pass silently.
    const wine: VerifyResponse = {
      ...result,
      overall: "APPROVED",
      beverageType: "wine",
      fields: [
        {
          field: "classType",
          applicationValue: "Red Table Wine",
          labelValue: "Red Table Wine",
          verdict: "COMPLIANT",
          reason: "ok",
          confidence: 0.95,
        },
      ],
    };
    render(<VerdictCard result={wine} />);
    expect(screen.getByRole("link", { name: /27 CFR §4\.34/ })).toBeInTheDocument();
  });
  it("qualifies an APPROVED that contains NEEDS_CORRECTION rows (missing warning must never look approved)", () => {
    const withReview: VerifyResponse = {
      ...result,
      overall: "APPROVED",
      fields: [
        {
          field: "healthWarningStatement",
          applicationValue: "GOVERNMENT WARNING: ...",
          labelValue: null,
          verdict: "NEEDS_CORRECTION",
          reason: "No health warning statement found on the label — verify by eye.",
          confidence: 0.35,
        },
      ],
    };
    render(<VerdictCard result={withReview} />);
    expect(screen.getByText("APPROVED")).toBeInTheDocument();
    expect(screen.getByText(/1 item needs your review/i)).toBeInTheDocument();
  });
  it("renders a clean APPROVED (no NEEDS_CORRECTION rows) with no amber review bar", () => {
    const clean: VerifyResponse = {
      ...result,
      overall: "APPROVED",
      fields: [
        {
          field: "brandName",
          applicationValue: "X",
          labelValue: "X",
          verdict: "COMPLIANT",
          reason: "Matches the application exactly.",
          confidence: 0.95,
        },
      ],
    };
    render(<VerdictCard result={clean} />);
    expect(screen.getByText("APPROVED")).toBeInTheDocument();
    expect(screen.queryByText(/item.*needs? your review/i)).not.toBeInTheDocument();
  });
  it("pluralizes the review count for multiple NEEDS_CORRECTION rows: '2 items need'", () => {
    const twoReviews: VerifyResponse = {
      ...result,
      overall: "APPROVED",
      fields: [
        {
          field: "healthWarningStatement",
          applicationValue: "GOVERNMENT WARNING: ...",
          labelValue: null,
          verdict: "NEEDS_CORRECTION",
          reason: "No health warning statement found on the label — verify by eye.",
          confidence: 0.35,
        },
        {
          field: "netContents",
          applicationValue: "750 mL",
          labelValue: null,
          verdict: "NEEDS_CORRECTION",
          reason: "Net contents could not be read from the label — verify by eye.",
          confidence: 0.42,
        },
      ],
    };
    render(<VerdictCard result={twoReviews} />);
    expect(screen.getByText(/2 items need your review/i)).toBeInTheDocument();
  });
});

describe("VerdictCard tier/provider footer (dev-mode only)", () => {
  afterEach(() => setDevMode(false));

  it("hides tier/provider from the default (non-dev-mode) view — it's internal jargon", () => {
    const cloud: VerifyResponse = { ...result, tier: "cloud", provider: "anthropic" };
    render(<VerdictCard result={cloud} />);
    expect(screen.queryByText(/tier:/i)).not.toBeInTheDocument();
  });

  it("shows the provider name alongside the tier when the cloud tier is used, in dev mode", () => {
    setDevMode(true);
    const cloud: VerifyResponse = { ...result, tier: "cloud", provider: "anthropic" };
    render(<VerdictCard result={cloud} />);
    expect(screen.getByText(/tier: cloud \(anthropic\)/i)).toBeInTheDocument();
  });
});

const REPAIRED_TRACE: ExtractionTrace = {
  tier: "gemini",
  baselineWeakFields: ["healthWarningStatement"],
  extraCalls: 1,
  totalMs: 1800,
  stoppedBecause: "clean",
  attempts: [
    {
      transform: "crop",
      targetFields: ["healthWarningStatement"],
      durationMs: 700,
      outcome: "improved",
      improvedFields: ["healthWarningStatement"],
    },
  ],
};

describe("VerdictCard — escalation", () => {
  afterEach(() => setDevMode(false));

  it("shows the plain-English repair line when a field was repaired", () => {
    render(<VerdictCard result={{ ...result, extraction: REPAIRED_TRACE }} />);
    expect(screen.getByText(/Took a closer look at the health warning statement/)).toBeInTheDocument();
  });

  it("shows no repair line when nothing was repaired", () => {
    render(<VerdictCard result={result} />);
    expect(screen.queryByText(/Took a closer look/)).not.toBeInTheDocument();
  });

  it("hides the technical trail unless dev mode is on", () => {
    render(<VerdictCard result={{ ...result, extraction: REPAIRED_TRACE }} />);
    expect(screen.queryByText("Escalation ladder")).not.toBeInTheDocument();
  });

  it("reveals the technical trail in dev mode", () => {
    setDevMode(true);
    render(<VerdictCard result={{ ...result, extraction: REPAIRED_TRACE }} />);
    expect(screen.getByText("Escalation ladder")).toBeInTheDocument();
  });
});

// Field-scoped accessible names ("Mark the Brand name explanation as helpful") so a screen-reader
// user tabbing a card with several rows can tell the pairs apart; these tests operate across rows,
// so they match the shape, not one field's label.
const HELPFUL = /^Mark the .+ explanation as helpful$/;
const NOT_HELPFUL = /^Mark the .+ explanation as not helpful$/;

describe("VerdictCard per-field feedback", () => {
  it("toggles a field's feedback off when the same direction is pressed twice", () => {
    const { container } = render(<VerdictCard result={result} />);
    const helpful = within(container).getAllByRole("button", { name: HELPFUL })[0];
    expect(helpful).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(helpful);
    expect(helpful).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(helpful);
    expect(helpful).toHaveAttribute("aria-pressed", "false");
  });

  it("switches direction without leaving both directions pressed", () => {
    const { container } = render(<VerdictCard result={result} />);
    const scope = within(container);
    const helpful = scope.getAllByRole("button", { name: HELPFUL })[0];
    const notHelpful = scope.getAllByRole("button", { name: NOT_HELPFUL })[0];
    fireEvent.click(helpful);
    fireEvent.click(notHelpful);
    expect(helpful).toHaveAttribute("aria-pressed", "false");
    expect(notHelpful).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps feedback scoped to the field it was given on", () => {
    const { container } = render(<VerdictCard result={result} />);
    const helpfuls = within(container).getAllByRole("button", { name: HELPFUL });
    expect(helpfuls).toHaveLength(result.fields.length);
    fireEvent.click(helpfuls[0]);
    expect(helpfuls[0]).toHaveAttribute("aria-pressed", "true");
    expect(helpfuls[1]).toHaveAttribute("aria-pressed", "false");
  });
});

describe("VerdictCard label image viewer", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows no viewer trigger when no image is passed", () => {
    render(<VerdictCard result={result} />);
    expect(screen.queryByRole("button", { name: "View label image" })).not.toBeInTheDocument();
  });

  it("shows the viewer trigger when an image is passed", () => {
    const image = new File([new Uint8Array([1, 2, 3])], "label.png", { type: "image/png" });
    render(<VerdictCard result={result} image={image} />);
    expect(screen.getByRole("button", { name: "View label image" })).toBeInTheDocument();
  });
});
