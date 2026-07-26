import { describe, expect, it } from "vitest";
import { formatRatioPct } from "@/eval/format";

describe("formatRatioPct", () => {
  it("renders a percentage when total > 0", () => {
    expect(formatRatioPct(8, 8)).toBe("100%");
    expect(formatRatioPct(3, 4)).toBe("75%");
  });
  it("renders n/a for a 0/0 ratio instead of a misleading 100% (D6c, 2026-07-25)", () => {
    // A run where nothing was planted (or nothing extracted) must not read as a perfect
    // security result — "violations 0/0 (100%)" is the wrong default for a compliance tool.
    expect(formatRatioPct(0, 0)).toBe("n/a");
  });
});
