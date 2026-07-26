import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SAMPLE_SHA256 } from "@/lib/vision/sample-hashes";
import { isMockSample } from "@/lib/vision/mock";
import { BATCH_SAMPLES, DETERMINISTIC_SAMPLES, SAMPLES } from "@/lib/samples";

describe("sample catalogue", () => {
  it("ships an image for every sample", () => {
    for (const sample of SAMPLES) {
      expect(existsSync(`public/samples/${sample.name}`), `missing public/samples/${sample.name}`).toBe(true);
    }
  });

  it("has no duplicate sample names", () => {
    const names = SAMPLES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("every non-`real` sample is genuinely deterministic", () => {
  // The invariant that was violated before: three samples were offered with tags promising a fixed
  // outcome ("Spirits · fails") but had no hash, so /api/verify quietly ran live OCR on them instead
  // of the mock tier — slower, non-deterministic, and not what the tag claimed.
  it("gives every sample not marked `real` a hash", () => {
    const unhashed = SAMPLES.filter((s) => !s.real && !SAMPLE_SHA256[s.name]).map((s) => s.name);
    expect(unhashed, "these samples claim source=sample but would fall through to live OCR").toEqual([]);
  });

  it("does not hash samples marked `real`, which must run live extraction", () => {
    const wronglyHashed = SAMPLES.filter((s) => s.real && SAMPLE_SHA256[s.name]).map((s) => s.name);
    expect(wronglyHashed).toEqual([]);
  });

  it("hashes match the bytes actually shipped in public/samples", () => {
    for (const [name, expected] of Object.entries(SAMPLE_SHA256)) {
      const actual = createHash("sha256")
        .update(readFileSync(`public/samples/${name}`))
        .digest("hex");
      expect(actual, `stale hash for ${name} — re-run the hash and update sample-hashes.ts`).toBe(expected);
    }
  });
});

describe("DETERMINISTIC_SAMPLES", () => {
  // The list is duplicated in lib/samples.ts because sample-hashes.ts imports node:crypto and cannot
  // be pulled into a client component. This is the guard that keeps the copy honest.
  it("matches the hash gate exactly", () => {
    expect([...DETERMINISTIC_SAMPLES].sort()).toEqual(Object.keys(SAMPLE_SHA256).sort());
  });

  it("names only samples that exist in the catalogue", () => {
    for (const name of DETERMINISTIC_SAMPLES) {
      expect(
        SAMPLES.some((s) => s.name === name),
        `${name} is not in SAMPLES`,
      ).toBe(true);
    }
  });

  it("names only samples the mock tier can actually extract", () => {
    for (const name of DETERMINISTIC_SAMPLES) {
      expect(isMockSample(name), `${name} has no MOCK_FIXTURES entry`).toBe(true);
    }
  });

  it("excludes samples flagged `real`, which deliberately run live extraction", () => {
    for (const name of DETERMINISTIC_SAMPLES) {
      expect(SAMPLES.find((s) => s.name === name)?.real).toBeUndefined();
    }
  });
});

describe("BATCH_SAMPLES", () => {
  it("resolves every deterministic name to a full sample", () => {
    expect(BATCH_SAMPLES).toHaveLength(DETERMINISTIC_SAMPLES.length);
    expect(BATCH_SAMPLES.map((s) => s.name)).toEqual([...DETERMINISTIC_SAMPLES]);
  });

  it("includes at least one sample that fails, so the demo shows a real mismatch", () => {
    expect(BATCH_SAMPLES.some((s) => s.tag.includes("fails"))).toBe(true);
  });

  it("covers more than one beverage type", () => {
    const types = new Set(BATCH_SAMPLES.map((s) => s.app.beverageType));
    expect(types.size).toBeGreaterThan(1);
  });
});
