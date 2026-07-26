import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CharacterDiff } from "@/components/character-diff";
import { HEALTH_WARNING_TEXT } from "@/lib/ttb/warning";

describe("CharacterDiff", () => {
  it("renders both labeled lines", () => {
    render(<CharacterDiff canonical={HEALTH_WARNING_TEXT} extracted={HEALTH_WARNING_TEXT} />);
    expect(screen.getByText("On file (canonical)")).toBeInTheDocument();
    expect(screen.getByText("Extracted from label")).toBeInTheDocument();
  });

  it("renders no <mark> highlights for an exact match", () => {
    const { container } = render(<CharacterDiff canonical={HEALTH_WARNING_TEXT} extracted={HEALTH_WARNING_TEXT} />);
    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });

  it("STILL says it checked character-by-character when every character matches", () => {
    // Regression: the caption used to render only when a difference was found, so on a passing label
    // dev mode showed two identical blocks of text with nothing identifying them as a
    // character-by-character comparison — the feature looked broken exactly when it succeeded.
    // Confirming "I compared every character and they are identical" is the assurance a reviewer
    // most wants on an APPROVED.
    render(<CharacterDiff canonical={HEALTH_WARNING_TEXT} extracted={HEALTH_WARNING_TEXT} />);
    const caption = screen.getByText(/checked character-by-character/i);
    expect(caption).toBeInTheDocument();
    expect(caption.textContent).toMatch(/every character matches/i);
  });

  it("highlights case-only differences in review color", () => {
    const { container } = render(
      <CharacterDiff canonical={HEALTH_WARNING_TEXT} extracted={HEALTH_WARNING_TEXT.toUpperCase()} />,
    );
    expect(container.querySelectorAll("mark.text-verdict-needs-correction").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("mark.text-verdict-non-compliant")).toHaveLength(0);
    expect(screen.getByText(/checked character-by-character/i)).toBeInTheDocument();
  });

  it("highlights the mandatory prefix in mismatch color, not review color, when its case is wrong", () => {
    // Regression: warning.ts treats a wrong-case "GOVERNMENT WARNING:" prefix as NON_COMPLIANT, but
    // the diff previously highlighted it amber (review color) like any other case-only deviation —
    // contradicting the red NON_COMPLIANT pill shown above it.
    const extracted = HEALTH_WARNING_TEXT.toLowerCase();
    const { container } = render(<CharacterDiff canonical={HEALTH_WARNING_TEXT} extracted={extracted} />);
    const marks = [...container.querySelectorAll("mark")];
    const prefixMark = marks.find((m) => m.textContent === "GOVERNMENT");
    expect(prefixMark).toBeDefined();
    expect(prefixMark!.className).toContain("text-verdict-non-compliant");
    // The body still gets review color — only the prefix's case is decisive.
    expect(container.querySelectorAll("mark.text-verdict-needs-correction").length).toBeGreaterThan(0);
  });

  it("highlights a genuine wording difference in mismatch color", () => {
    const extracted = HEALTH_WARNING_TEXT.replace(
      "Consumption of alcoholic beverages impairs",
      "Drinking alcohol impairs",
    );
    const { container } = render(<CharacterDiff canonical={HEALTH_WARNING_TEXT} extracted={extracted} />);
    expect(container.querySelectorAll("mark.text-verdict-non-compliant").length).toBeGreaterThan(0);
  });
});
