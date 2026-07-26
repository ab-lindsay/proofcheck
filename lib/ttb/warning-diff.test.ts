import { describe, expect, it } from "vitest";
import { diffWarningTokens } from "@/lib/ttb/warning-diff";
import { HEALTH_WARNING_TEXT } from "@/lib/ttb/warning";

describe("diffWarningTokens", () => {
  it("marks every token 'same' for an identical match", () => {
    const { canonical, extracted } = diffWarningTokens(HEALTH_WARNING_TEXT, HEALTH_WARNING_TEXT);
    expect(canonical.every((t) => t.kind === "same")).toBe(true);
    expect(extracted.every((t) => t.kind === "same")).toBe(true);
  });

  it("marks word tokens 'case-diff' or 'same' based on case differences for the real-world all-caps label scenario, spaces stay 'same'", () => {
    const { canonical, extracted } = diffWarningTokens(HEALTH_WARNING_TEXT, HEALTH_WARNING_TEXT.toUpperCase());
    const words = canonical.filter((t) => !/^\s+$/.test(t.text));
    const spaces = canonical.filter((t) => /^\s+$/.test(t.text));
    expect(words.length).toBeGreaterThan(0);
    // Tokens already in all-caps (like "GOVERNMENT", "WARNING:", "(1)", "(2)") are marked "same"
    // Tokens in mixed-case (like "According", "to", "women", etc.) are marked "case-diff"
    const caseDiffWords = words.filter((t) => t.kind === "case-diff");
    const sameWords = words.filter((t) => t.kind === "same");
    expect(caseDiffWords.length).toBeGreaterThan(0); // Some tokens should differ in case
    expect(sameWords.length).toBeGreaterThan(0); // Some tokens should already be all-caps
    expect(words.every((t) => t.kind === "case-diff" || t.kind === "same")).toBe(true); // All word tokens are either same or case-diff
    expect(spaces.every((t) => t.kind === "same")).toBe(true);
    expect(canonical.some((t) => t.kind === "diverge")).toBe(false);
    expect(extracted.some((t) => t.kind === "diverge")).toBe(false);
  });

  it("marks only the changed whitespace run as 'space-diff' when an extra space is inserted", () => {
    const extracted = HEALTH_WARNING_TEXT.replace("GOVERNMENT WARNING: (1)", "GOVERNMENT WARNING:  (1)");
    const { canonical, extracted: ext } = diffWarningTokens(HEALTH_WARNING_TEXT, extracted);
    expect(canonical.filter((t) => t.kind === "space-diff")).toHaveLength(1);
    expect(ext.filter((t) => t.kind === "space-diff")).toHaveLength(1);
    expect(canonical.some((t) => t.kind === "diverge")).toBe(false);
  });

  it("collapses a genuine wording difference into a single trailing 'diverge' token per side", () => {
    const extracted = HEALTH_WARNING_TEXT.replace(
      "Consumption of alcoholic beverages impairs",
      "Drinking alcohol impairs",
    );
    const { canonical, extracted: ext } = diffWarningTokens(HEALTH_WARNING_TEXT, extracted);
    expect(canonical.at(-1)?.kind).toBe("diverge");
    expect(ext.at(-1)?.kind).toBe("diverge");
    expect(canonical.at(-1)?.text).toContain("Consumption of alcoholic beverages impairs");
    expect(ext.at(-1)?.text).toContain("Drinking alcohol impairs");
  });

  it("marks only the canonical side as diverging when the label is simply missing trailing text", () => {
    const cut = HEALTH_WARNING_TEXT.indexOf("(2)");
    const extracted = HEALTH_WARNING_TEXT.slice(0, cut).trimEnd();
    const { canonical, extracted: ext } = diffWarningTokens(HEALTH_WARNING_TEXT, extracted);
    expect(canonical.at(-1)?.kind).toBe("diverge");
    expect(ext.some((t) => t.kind === "diverge")).toBe(false);
    expect(ext.every((t) => t.kind === "same")).toBe(true);
  });

  it("produces no diverge tokens when both strings are identical (restA and restB are empty)", () => {
    const { canonical, extracted } = diffWarningTokens("hello world", "hello world");
    expect(canonical.some((t) => t.kind === "diverge")).toBe(false);
    expect(extracted.some((t) => t.kind === "diverge")).toBe(false);
  });

  it("marks the mandatory 'GOVERNMENT WARNING:' prefix as 'diverge' when its case is wrong, not 'case-diff' — matches warning.ts's stricter NON_COMPLIANT prefix rule", () => {
    // Regression: a fully lowercase (or otherwise wrong-case-prefix) transcription is NON_COMPLIANT
    // per warning.ts (the prefix specifically must be capitals), but the diff used to mark every
    // case-only deviation "case-diff" regardless of position — amber highlights under a red verdict.
    const extracted = HEALTH_WARNING_TEXT.toLowerCase();
    const { canonical, extracted: ext } = diffWarningTokens(HEALTH_WARNING_TEXT, extracted);
    expect(canonical[0]).toMatchObject({ text: "GOVERNMENT", kind: "diverge" });
    expect(canonical[2]).toMatchObject({ text: "WARNING:", kind: "diverge" });
    expect(ext[0]).toMatchObject({ text: "government", kind: "diverge" });
    expect(ext[2]).toMatchObject({ text: "warning:", kind: "diverge" });
    // The body's case still doesn't matter to the verdict (NEEDS_CORRECTION territory) — those
    // tokens must not get swept into "diverge" along with the prefix (some are "same" already —
    // words like "to"/"the" are already lowercase in the canonical text, unaffected by lowercasing).
    const bodyWords = canonical.slice(3).filter((t) => !/^\s+$/.test(t.text));
    expect(bodyWords.length).toBeGreaterThan(0);
    expect(bodyWords.some((t) => t.kind === "case-diff")).toBe(true);
    expect(bodyWords.every((t) => t.kind !== "diverge")).toBe(true);
  });

  it("produces diverge tokens on both sides when strings differ from the start", () => {
    const { canonical, extracted } = diffWarningTokens("aaa bbb", "xxx yyy");
    expect(canonical.at(-1)?.kind).toBe("diverge");
    expect(extracted.at(-1)?.kind).toBe("diverge");
    expect(canonical.at(-1)?.text).toBe("aaa bbb");
    expect(extracted.at(-1)?.text).toBe("xxx yyy");
  });
});
