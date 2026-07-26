import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FieldRow } from "@/components/field-row";
import type { FieldResult } from "@/lib/schema";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const base: FieldResult = {
  field: "alcoholContent",
  applicationValue: "45% Alc./Vol.",
  labelValue: "45% Alc./Vol.",
  verdict: "COMPLIANT",
  reason: "Matches the application exactly.",
  confidence: 0.95,
};

describe("FieldRow regulation citation", () => {
  it("renders the basis and a new-tab eCFR link for a cited field", () => {
    render(
      <ul>
        <FieldRow result={base} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText(/Basis:/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /27 CFR §5\.65/ });
    expect(link).toHaveAttribute("href", expect.stringContaining("ecfr.gov"));
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
  it("renders the CBP citation for wine country of origin", () => {
    const country: FieldResult = { ...base, field: "countryOfOrigin", reason: "…" };
    render(
      <ul>
        <FieldRow result={country} beverageType="wine" />
      </ul>,
    );
    expect(screen.getByText(/Basis:/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /19 CFR §134\.11/ });
    expect(link).toHaveAttribute("href", expect.stringContaining("ecfr.gov"));
    expect(link).toHaveAttribute("target", "_blank");
  });
});

describe("FieldRow verdict icon and style", () => {
  it("renders the COMPLIANT pill and verdict-compliant icon", () => {
    const { container } = render(
      <ul>
        <FieldRow result={base} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("Compliant")).toBeInTheDocument();
    expect(container.querySelector("svg.text-verdict-compliant")).toBeInTheDocument();
  });
  it("renders the NON_COMPLIANT pill and verdict-non-compliant icon", () => {
    const mismatch: FieldResult = {
      ...base,
      verdict: "NON_COMPLIANT",
      labelValue: "40% Alc./Vol.",
      reason: "Does not match the application.",
    };
    const { container } = render(
      <ul>
        <FieldRow result={mismatch} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("Non-compliant")).toBeInTheDocument();
    expect(container.querySelector("svg.text-verdict-non-compliant")).toBeInTheDocument();
  });
  it("renders the NEEDS_CORRECTION pill and verdict-needs-correction icon", () => {
    const review: FieldResult = {
      ...base,
      verdict: "NEEDS_CORRECTION",
      labelValue: null,
      reason: "Alcohol content could not be read from the label — verify by eye.",
    };
    const { container } = render(
      <ul>
        <FieldRow result={review} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("Needs correction")).toBeInTheDocument();
    expect(container.querySelector("svg.text-verdict-needs-correction")).toBeInTheDocument();
  });
});

describe("FieldRow value placeholders", () => {
  it("renders a null applicationValue as —", () => {
    const empty: FieldResult = { ...base, applicationValue: null };
    render(
      <ul>
        <FieldRow result={empty} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });
  it('renders a null labelValue as "not found"', () => {
    const notFound: FieldResult = { ...base, labelValue: null };
    render(
      <ul>
        <FieldRow result={notFound} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("not found")).toBeInTheDocument();
  });
});

describe("FieldRow confidence display", () => {
  it("renders the High tier and percentage at >= 0.8", () => {
    render(
      <ul>
        <FieldRow result={{ ...base, confidence: 0.94 }} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("Confidence: High (94%)")).toBeInTheDocument();
  });
  it("renders the Medium tier and percentage at 0.5-0.8", () => {
    render(
      <ul>
        <FieldRow result={{ ...base, confidence: 0.58 }} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("Confidence: Medium (58%)")).toBeInTheDocument();
  });
  it("renders the Low tier and percentage below 0.5", () => {
    render(
      <ul>
        <FieldRow result={{ ...base, confidence: 0.12 }} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("Confidence: Low (12%)")).toBeInTheDocument();
  });
  it("treats exactly 0.5 as Medium, matching verify.ts's strict-less-than downgrade boundary", () => {
    render(
      <ul>
        <FieldRow result={{ ...base, confidence: 0.5 }} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("Confidence: Medium (50%)")).toBeInTheDocument();
  });
  it("treats exactly 0.8 as High", () => {
    render(
      <ul>
        <FieldRow result={{ ...base, confidence: 0.8 }} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("Confidence: High (80%)")).toBeInTheDocument();
  });
  it("shows the confidence explanation as always-visible text, not a hover-only title attribute", () => {
    // A title tooltip never surfaces on a touch device — the primary device for this app's target
    // user (73-year-old, non-technical) — so the explanation must render as plain text on the page.
    const { container } = render(
      <ul>
        <FieldRow result={{ ...base, confidence: 0.94 }} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText(/Read clearly\./)).toBeInTheDocument();
    expect(container.querySelector("[title]")).toBeNull();
  });
});

describe("FieldRow health warning statement diff", () => {
  const warning: FieldResult = {
    field: "healthWarningStatement",
    applicationValue: "GOVERNMENT WARNING: text",
    labelValue: "GOVERNMENT WARNING: TEXT",
    verdict: "NEEDS_CORRECTION",
    reason: "Wording is exact; only letter case differs.",
    confidence: 0.9,
  };

  it("shows the generic value boxes, not the diff view, when dev mode is off (default)", () => {
    render(
      <ul>
        <FieldRow result={warning} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("Application")).toBeInTheDocument();
    expect(screen.queryByText("On file (canonical)")).not.toBeInTheDocument();
  });

  it("renders the diff view instead of the generic value boxes when dev mode is on and both values are present", () => {
    localStorage.setItem("devMode", "true");
    render(
      <ul>
        <FieldRow result={warning} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("On file (canonical)")).toBeInTheDocument();
    expect(screen.queryByText("Application")).not.toBeInTheDocument();
  });

  it("falls back to the generic value boxes when dev mode is on but the label value is missing", () => {
    localStorage.setItem("devMode", "true");
    const missing: FieldResult = {
      field: "healthWarningStatement",
      applicationValue: "GOVERNMENT WARNING: text",
      labelValue: null,
      verdict: "NEEDS_CORRECTION",
      reason: "No health warning statement found on the label — verify by eye.",
      confidence: 0.2,
    };
    render(
      <ul>
        <FieldRow result={missing} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("Application")).toBeInTheDocument();
    expect(screen.getByText("not found")).toBeInTheDocument();
    expect(screen.queryByText("On file (canonical)")).not.toBeInTheDocument();
  });
});

describe("FieldRow character diff across all text fields", () => {
  // Pins the regression an inequality guard on this condition re-introduced one level up from
  // character-diff.tsx: the character-level assurance is wanted most on a byte-exact health warning
  // statement — i.e. precisely when the two values ARE equal — and hiding it there made the feature
  // look broken exactly when it succeeded.
  it("still renders the diff when the two values are byte-identical", () => {
    localStorage.setItem("devMode", "true");
    const exact: FieldResult = {
      field: "healthWarningStatement",
      applicationValue: "GOVERNMENT WARNING: text",
      labelValue: "GOVERNMENT WARNING: text",
      verdict: "COMPLIANT",
      reason: "Matches the mandatory text exactly.",
      confidence: 1,
    };
    render(
      <ul>
        <FieldRow result={exact} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText("On file (canonical)")).toBeInTheDocument();
    expect(screen.getByText(/every character matches the mandatory text/)).toBeInTheDocument();
  });

  // The health warning statement is judged byte-exact; every other text field goes through
  // fuzzyVerdict, where case and punctuation differences normalize away and can be a COMPLIANT. Painting
  // those with the warning check's NEEDS_CORRECTION/NON_COMPLIANT colours put amber "needs review" highlights
  // inside a green COMPLIANT row.
  it("uses neutral wording and no verdict colours for a fuzzily-matched field", () => {
    localStorage.setItem("devMode", "true");
    const classType: FieldResult = {
      field: "classType",
      applicationValue: "Kentucky Straight Bourbon Whiskey",
      labelValue: "KENTUCKY STRAIGHT BOURBON WHISKEY",
      verdict: "COMPLIANT",
      reason: "Matches the application; only letter case differs.",
      confidence: 0.9,
    };
    const { container } = render(
      <ul>
        <FieldRow result={classType} beverageType="distilled-spirits" />
      </ul>,
    );
    expect(screen.getByText(/does not always mean a mismatch/)).toBeInTheDocument();
    expect(screen.queryByText("On file (canonical)")).not.toBeInTheDocument();
    expect(container.querySelector("mark.text-verdict-needs-correction")).toBeNull();
    expect(container.querySelector("mark.text-verdict-non-compliant")).toBeNull();
  });
});
