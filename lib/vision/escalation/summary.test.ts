import { describe, expect, it } from "vitest";
import type { ExtractionTrace } from "@/lib/vision/escalation/types";
import { repairSummary } from "@/lib/vision/escalation/summary";

const trace = (over: Partial<ExtractionTrace> = {}): ExtractionTrace => ({
  tier: "gemini",
  baselineWeakFields: [],
  attempts: [],
  extraCalls: 0,
  totalMs: 100,
  stoppedBecause: "clean",
  ...over,
});

describe("repairSummary", () => {
  it("returns null when there is no trace", () => {
    expect(repairSummary(undefined)).toBeNull();
  });

  it("returns null when nothing was repaired", () => {
    expect(repairSummary(trace())).toBeNull();
  });

  it("returns null when a repair was attempted but improved nothing", () => {
    expect(
      repairSummary(
        trace({
          extraCalls: 1,
          attempts: [
            {
              transform: "crop",
              targetFields: ["brandName"],
              durationMs: 10,
              outcome: "no-change",
              improvedFields: [],
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("names the improved field in plain English", () => {
    expect(
      repairSummary(
        trace({
          extraCalls: 1,
          attempts: [
            {
              transform: "crop",
              targetFields: ["healthWarningStatement"],
              durationMs: 10,
              outcome: "improved",
              improvedFields: ["healthWarningStatement"],
            },
          ],
        }),
      ),
    ).toBe("Took a closer look at the health warning statement to read it more clearly.");
  });

  it("joins several improved fields, lower-cased, without duplicates", () => {
    expect(
      repairSummary(
        trace({
          extraCalls: 2,
          attempts: [
            { transform: "crop", targetFields: [], durationMs: 10, outcome: "improved", improvedFields: ["brandName"] },
            {
              transform: "enhance",
              targetFields: [],
              durationMs: 10,
              outcome: "improved",
              improvedFields: ["brandName", "netContents"],
            },
          ],
        }),
      ),
    ).toBe("Took a closer look at the brand name and net contents to read them more clearly.");
  });
});
