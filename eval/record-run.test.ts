import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordRun, type RunRecord } from "@/eval/record-run";

const SAMPLE_RECORD: RunRecord = {
  summary: {
    provider: "mock",
    set: "default",
    entries: 13,
    overallCompliant: 13,
    overallTotal: 13,
    perField: { brandName: { compliant: 13, total: 13 } },
    violationsCaught: 8,
    violationsTotal: 8,
    extractionErrors: 0,
  },
  details: [
    {
      file: "old-tom-clean.png",
      field: "brandName",
      actual: "COMPLIANT",
      expectedOneOf: ["COMPLIANT"],
      ok: true,
      extractedValue: "OLD TOM DISTILLERY",
      appValue: "OLD TOM DISTILLERY",
    },
  ],
};

describe("recordRun", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("appends a well-formed line to the history file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");

    await recordRun(SAMPLE_RECORD, { historyPath, resultsDir });

    const raw = await readFile(historyPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.provider).toBe("mock");
    expect(parsed.set).toBe("default");
    expect(parsed.overallCompliant).toBe(13);
    expect(parsed.perField.brandName).toEqual({ compliant: 13, total: 13 });
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("appends a second line rather than overwriting on a second call", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");

    await recordRun(SAMPLE_RECORD, { historyPath, resultsDir });
    await recordRun(SAMPLE_RECORD, { historyPath, resultsDir });

    const raw = await readFile(historyPath, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  it("overwrites (not appends) the per-(set, provider) detail file on a second call", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");

    await recordRun(SAMPLE_RECORD, { historyPath, resultsDir });
    const secondRecord: RunRecord = {
      ...SAMPLE_RECORD,
      details: [{ ...SAMPLE_RECORD.details[0], actual: "NON_COMPLIANT", ok: false }],
    };
    await recordRun(secondRecord, { historyPath, resultsDir });

    const detailPath = path.join(resultsDir, "default-mock.json");
    const parsed = JSON.parse(await readFile(detailPath, "utf8"));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].actual).toBe("NON_COMPLIANT");
  });

  it("round-trips the optional real/degraded subset split", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");
    const record: RunRecord = {
      ...SAMPLE_RECORD,
      summary: {
        ...SAMPLE_RECORD.summary,
        bySubset: { real: { compliant: 4, total: 21 }, degraded: { compliant: 17, total: 25 } },
      },
    };

    await recordRun(record, { historyPath, resultsDir });

    const parsed = JSON.parse((await readFile(historyPath, "utf8")).trim());
    expect(parsed.bySubset).toEqual({ real: { compliant: 4, total: 21 }, degraded: { compliant: 17, total: 25 } });
  });

  it("omits bySubset from the recorded line when the run has no degraded fixtures", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");

    await recordRun(SAMPLE_RECORD, { historyPath, resultsDir });

    const parsed = JSON.parse((await readFile(historyPath, "utf8")).trim());
    expect(parsed.bySubset).toBeUndefined();
  });

  it("degrades to null gitSha/dirty instead of throwing when git commands fail", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");

    // os.tmpdir() itself is never a git repo, so running from there makes `git rev-parse HEAD` fail.
    const cwdBefore = process.cwd();
    process.chdir(tmpdir());
    try {
      await recordRun(SAMPLE_RECORD, { historyPath, resultsDir });
    } finally {
      process.chdir(cwdBefore);
    }

    const raw = await readFile(historyPath, "utf8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed.gitSha).toBeNull();
    expect(parsed.dirty).toBeNull();
  });

  it("records whether escalation was enabled and how many extra calls it spent", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");

    await recordRun(
      { ...SAMPLE_RECORD, summary: { ...SAMPLE_RECORD.summary, escalation: true, extraCalls: 3 } },
      { historyPath, resultsDir },
    );

    const line = JSON.parse((await readFile(historyPath, "utf8")).trim());
    expect(line.escalation).toBe(true);
    expect(line.extraCalls).toBe(3);
  });

  it("records fields needing correction separately from the compliance count", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");

    await recordRun(
      { ...SAMPLE_RECORD, summary: { ...SAMPLE_RECORD.summary, needsCorrection: 4 } },
      { historyPath, resultsDir },
    );

    const line = JSON.parse((await readFile(historyPath, "utf8")).trim());
    expect(line.needsCorrection).toBe(4);
    // Older history lines predate this split and simply omit the field — a run that never sets it
    // (the batch set's summary, or any pre-Task-8 history) must not synthesize a false zero.
    expect(SAMPLE_RECORD.summary.needsCorrection).toBeUndefined();
  });

  it("suffixes the detail file for a --only subset run so it can't clobber the full detail file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");

    // Full run writes the canonical file; a subset run must NOT overwrite it.
    await recordRun({ ...SAMPLE_RECORD, summary: { ...SAMPLE_RECORD.summary } }, { historyPath, resultsDir });
    await recordRun(
      { ...SAMPLE_RECORD, summary: { ...SAMPLE_RECORD.summary, subset: true } },
      { historyPath, resultsDir },
    );

    await expect(readFile(path.join(resultsDir, "default-mock.json"), "utf8")).resolves.toBeTruthy();
    await expect(readFile(path.join(resultsDir, "default-mock-subset.json"), "utf8")).resolves.toBeTruthy();
  });

  it("suffixes the detail file for a --no-escalate run so paired conditions don't overwrite each other", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "proofcheck-history-"));
    const historyPath = path.join(dir, "history.jsonl");
    const resultsDir = path.join(dir, "results");

    await recordRun(
      { ...SAMPLE_RECORD, summary: { ...SAMPLE_RECORD.summary, escalation: false, extraCalls: 0 } },
      { historyPath, resultsDir },
    );
    await recordRun(
      { ...SAMPLE_RECORD, summary: { ...SAMPLE_RECORD.summary, escalation: true, extraCalls: 2 } },
      { historyPath, resultsDir },
    );

    // Both files must exist side by side — the paired per-label comparison reads them together.
    await expect(readFile(path.join(resultsDir, "default-mock-no-escalate.json"), "utf8")).resolves.toBeTruthy();
    await expect(readFile(path.join(resultsDir, "default-mock.json"), "utf8")).resolves.toBeTruthy();
  });
});
