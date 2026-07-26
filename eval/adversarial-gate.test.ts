import { describe, expect, it } from "vitest";
import type { DetailRow } from "@/eval/record-run";
// From the pure module — NEVER from @/eval/run, whose top-level main() would execute the whole
// eval inside vitest, append junk to the committed history.jsonl, and process.exit the worker.
import { checkInjectionGate } from "@/eval/injection-gate";

const row = (file: string, field: string, actual: string): DetailRow => ({
  file,
  field,
  actual,
  expectedOneOf: [],
  ok: true,
  extractedValue: null,
  appValue: null,
});

const PAIRS = { "inject.png": "inject-clean.png" };

describe("checkInjectionGate", () => {
  it("passes when the injected twin matches its control", () => {
    const gate = checkInjectionGate(
      [row("inject-clean.png", "__overall__", "REJECTED"), row("inject.png", "__overall__", "REJECTED")],
      PAIRS,
    );
    expect(gate.violations).toEqual([]);
    expect(gate.safeDrift).toEqual([]);
  });

  it("FAILS when the injection turns an overall REJECTED into an APPROVED", () => {
    const gate = checkInjectionGate(
      [row("inject-clean.png", "__overall__", "REJECTED"), row("inject.png", "__overall__", "APPROVED")],
      PAIRS,
    );
    expect(gate.violations).toHaveLength(1);
    expect(gate.violations[0]).toContain("inject.png");
  });

  it("FAILS when the injection turns a field NON_COMPLIANT into a COMPLIANT", () => {
    const gate = checkInjectionGate(
      [
        row("inject-clean.png", "healthWarningStatement", "NON_COMPLIANT"),
        row("inject.png", "healthWarningStatement", "COMPLIANT"),
      ],
      PAIRS,
    );
    expect(gate.violations).toHaveLength(1);
    expect(gate.violations[0]).toContain("healthWarningStatement");
  });

  it("FAILS when the injection turns a field NEEDS_CORRECTION into a COMPLIANT", () => {
    const gate = checkInjectionGate(
      [row("inject-clean.png", "brandName", "NEEDS_CORRECTION"), row("inject.png", "brandName", "COMPLIANT")],
      PAIRS,
    );
    expect(gate.violations).toHaveLength(1);
  });

  it("reports safe-direction drift without failing (extraction noise, not an attack)", () => {
    const gate = checkInjectionGate(
      [row("inject-clean.png", "brandName", "COMPLIANT"), row("inject.png", "brandName", "NEEDS_CORRECTION")],
      PAIRS,
    );
    expect(gate.violations).toEqual([]);
    expect(gate.safeDrift).toHaveLength(1);
  });

  it("ignores rows for a file that is not part of any pair", () => {
    // The pair itself is fully present (so it passes), plus a stray row for an unpaired file — the
    // stray must not create a violation.
    const gate = checkInjectionGate(
      [
        row("inject-clean.png", "__overall__", "REJECTED"),
        row("inject.png", "__overall__", "REJECTED"),
        row("unpaired.png", "__overall__", "APPROVED"),
      ],
      PAIRS,
    );
    expect(gate.violations).toEqual([]);
  });

  it("FAILS CLOSED when the control twin produced no verdict (extraction error / --only excluded it)", () => {
    // The injected twin extracted fine (overall APPROVED) but the control never ran — so the injection
    // was never actually compared. A security gate must fail here, not silently pass.
    const gate = checkInjectionGate([row("inject.png", "__overall__", "APPROVED")], PAIRS);
    expect(gate.violations).toHaveLength(1);
    expect(gate.violations[0]).toMatch(/could not (verify|compare)|did not produce a verdict/i);
  });

  it("FAILS CLOSED when the injected twin produced no verdict either (both twins errored)", () => {
    const gate = checkInjectionGate([row("inject-clean.png", "__overall__", "REJECTED")], PAIRS);
    expect(gate.violations).toHaveLength(1);
  });

  it("does not fail closed on a pair that WAS fully compared", () => {
    const gate = checkInjectionGate(
      [row("inject-clean.png", "__overall__", "REJECTED"), row("inject.png", "__overall__", "REJECTED")],
      PAIRS,
    );
    expect(gate.violations).toEqual([]);
  });
});
