import { describe, it, expect, vi } from "vitest";
import { parseHistory, filterHistory, formatHistoryTable, type HistoryEntry } from "@/eval/print-history";

const ENTRY_A: HistoryEntry = {
  timestamp: "2026-07-23T10:00:00.000Z",
  gitSha: "abc1234567",
  dirty: false,
  provider: "mock",
  set: "default",
  entries: 13,
  overallCompliant: 13,
  overallTotal: 13,
  perField: { brandName: { compliant: 13, total: 13 } },
  violationsCaught: 8,
  violationsTotal: 8,
  extractionErrors: 0,
};

const ENTRY_B: HistoryEntry = {
  ...ENTRY_A,
  timestamp: "2026-07-23T11:00:00.000Z",
  provider: "local-ocr",
  set: "real-world",
  overallCompliant: 16,
  overallTotal: 46,
  dirty: true,
};

describe("parseHistory", () => {
  it("parses one JSON object per non-empty line", () => {
    const raw = `${JSON.stringify(ENTRY_A)}\n${JSON.stringify(ENTRY_B)}\n`;
    expect(parseHistory(raw)).toEqual([ENTRY_A, ENTRY_B]);
  });

  it("ignores blank lines", () => {
    const raw = `${JSON.stringify(ENTRY_A)}\n\n\n${JSON.stringify(ENTRY_B)}\n`;
    expect(parseHistory(raw)).toEqual([ENTRY_A, ENTRY_B]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseHistory("")).toEqual([]);
  });

  it("skips a malformed line instead of throwing, and warns how many were skipped", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = `${JSON.stringify(ENTRY_A)}\n{not valid json\n${JSON.stringify(ENTRY_B)}\n`;

    expect(() => parseHistory(raw)).not.toThrow();
    expect(parseHistory(raw)).toEqual([ENTRY_A, ENTRY_B]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("skipped 1 malformed line"));

    warnSpy.mockRestore();
  });
});

describe("filterHistory", () => {
  const all = [ENTRY_A, ENTRY_B];

  it("returns everything when no filters are given", () => {
    expect(filterHistory(all, {})).toEqual(all);
  });

  it("filters by set", () => {
    expect(filterHistory(all, { set: "real-world" })).toEqual([ENTRY_B]);
  });

  it("filters by provider", () => {
    expect(filterHistory(all, { provider: "mock" })).toEqual([ENTRY_A]);
  });

  it("filters by both set and provider together", () => {
    expect(filterHistory(all, { set: "real-world", provider: "local-ocr" })).toEqual([ENTRY_B]);
    expect(filterHistory(all, { set: "real-world", provider: "mock" })).toEqual([]);
  });
});

describe("formatHistoryTable", () => {
  it("returns a placeholder message for no entries", () => {
    expect(formatHistoryTable([], 20)).toBe("No matching history entries found.");
  });

  it("includes provider, set, overall accuracy, and per-field stats", () => {
    const table = formatHistoryTable([ENTRY_A], 20);
    expect(table).toContain("mock/default");
    expect(table).toContain("overall 13/13 (100%)");
    expect(table).toContain("brandName 13/13");
  });

  it("marks a dirty working tree with a trailing asterisk on the short SHA", () => {
    const table = formatHistoryTable([ENTRY_B], 20);
    expect(table).toContain("abc1234*");
  });

  it("respects the limit by keeping only the most recent entries", () => {
    const table = formatHistoryTable([ENTRY_A, ENTRY_B], 1);
    expect(table).not.toContain("mock/default");
    expect(table).toContain("local-ocr/real-world");
  });

  it("shows the real/degraded subset split when present", () => {
    const withSubset: HistoryEntry = {
      ...ENTRY_B,
      bySubset: { real: { compliant: 4, total: 21 }, degraded: { compliant: 17, total: 25 } },
    };
    const table = formatHistoryTable([withSubset], 20);
    expect(table).toContain("real 4/21");
    expect(table).toContain("degraded 17/25");
  });

  it("omits the subset line entirely for entries without it (old history lines, or sets with no degraded fixtures)", () => {
    const table = formatHistoryTable([ENTRY_A], 20);
    expect(table).not.toContain("real ");
    expect(table).not.toContain("degraded ");
  });

  it("reads pre-2026-07-26 history lines that used overallCorrect/correct instead of overallCompliant/compliant", () => {
    // 134 of 135 committed eval/history.jsonl lines predate the verdict-vocabulary rename and use
    // these exact keys — a reader that only knows the new names silently prints undefined/NaN%.
    const legacyLine = {
      timestamp: "2026-07-23T09:00:00.000Z",
      gitSha: "def4567890",
      dirty: false,
      provider: "mock",
      set: "default",
      entries: 13,
      overallCorrect: 13,
      overallTotal: 13,
      perField: { brandName: { correct: 13, total: 13 } },
      violationsCaught: 8,
      violationsTotal: 8,
      extractionErrors: 0,
    };
    const entries = parseHistory(JSON.stringify(legacyLine) + "\n");
    const table = formatHistoryTable(entries, 20);
    expect(table).toContain("overall 13/13 (100%)");
    expect(table).toContain("brandName 13/13");
    expect(table).not.toContain("undefined");
    expect(table).not.toContain("NaN");
  });
});

describe("formatHistoryTable — run-condition markers (D6c, 2026-07-25 hardening)", () => {
  it("tags a ladder-on run so it is distinguishable from a clean run", () => {
    expect(formatHistoryTable([{ ...ENTRY_A, escalation: true }], 20)).toContain("mock/default [ladder]");
  });
  it("tags a --only subset run", () => {
    expect(formatHistoryTable([{ ...ENTRY_A, subset: true }], 20)).toContain("mock/default [subset]");
  });
  it("tags a run that is both ladder-on and a subset", () => {
    expect(formatHistoryTable([{ ...ENTRY_A, escalation: true, subset: true }], 20)).toContain(
      "mock/default [ladder, subset]",
    );
  });
  it("omits the tag entirely for a clean full run", () => {
    const table = formatHistoryTable([ENTRY_A], 20);
    expect(table).not.toContain("[ladder");
    expect(table).not.toContain("[subset");
  });
  it("renders n/a, not 100%, for a 0/0 planted-violations ratio", () => {
    const noViolations: HistoryEntry = { ...ENTRY_A, violationsCaught: 0, violationsTotal: 0 };
    expect(formatHistoryTable([noViolations], 20)).toContain("violations 0/0 (n/a)");
  });
  it("still renders a real ratio as a percentage", () => {
    expect(formatHistoryTable([ENTRY_A], 20)).toContain("violations 8/8 (100%)");
  });
});
