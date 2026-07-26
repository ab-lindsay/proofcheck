import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SAMPLE_SHA256, isGenuineSample } from "@/lib/vision/sample-hashes";

const GENUINE_OLD_TOM = readFileSync("public/samples/old-tom-clean.png");

describe("isGenuineSample", () => {
  it("returns true for the genuine bytes of a known sample", () => {
    expect(isGenuineSample("old-tom-clean.png", GENUINE_OLD_TOM)).toBe(true);
  });

  it("returns false when the filename is known but the bytes are wrong", () => {
    const wrongBytes = Buffer.from("not the real png bytes");
    expect(isGenuineSample("old-tom-clean.png", wrongBytes)).toBe(false);
  });

  it("returns false when the bytes are genuine but for a different sample's filename", () => {
    // Right bytes, wrong name — the hash won't match the entry for this filename.
    expect(isGenuineSample("title-case-warning.png", GENUINE_OLD_TOM)).toBe(false);
  });

  it("returns false for an unknown filename regardless of bytes", () => {
    expect(isGenuineSample("unknown-file.png", GENUINE_OLD_TOM)).toBe(false);
  });

  it("returns false for an empty buffer against a known filename", () => {
    expect(isGenuineSample("old-tom-clean.png", Buffer.alloc(0))).toBe(false);
  });

  it("returns false for prototype-inherited property names used as filenames", () => {
    // SAMPLE_SHA256[filename] resolves inherited keys ("toString", "constructor", …) to functions,
    // not hash strings, so the hex digest can never strictly equal them — still false, not a throw.
    expect(isGenuineSample("toString", GENUINE_OLD_TOM)).toBe(false);
    expect(isGenuineSample("constructor", GENUINE_OLD_TOM)).toBe(false);
  });

  it("every bundled sample file's bytes match its recorded hash", () => {
    for (const filename of Object.keys(SAMPLE_SHA256)) {
      const bytes = readFileSync(`public/samples/${filename}`);
      expect(isGenuineSample(filename, bytes), `sample ${filename}`).toBe(true);
    }
  });
});
