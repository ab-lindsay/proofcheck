import type { ApplicationData } from "@/lib/schema";

export interface Sample {
  name: string;
  label: string;
  tag: string;
  app: ApplicationData;
  real?: boolean;
  /** Demonstrates a specific problem (wrong field, bad photo) rather than a clean label. Named after
   *  the defect it shows, not a brand — confusing in the default gallery for a first-time user (a
   *  usability test confirmed it), so the single-label page hides these unless Dev mode is on. */
  advanced?: boolean;
}

// Bundled demo samples (served from /public/samples), spanning all three beverage types. Selecting one
// loads the image, prefills the matching application data, and flags the request as a sample — so it
// verifies deterministically via the mock tier (no cloud key, no OCR variance). A user's own upload
// never uses this path.
//
// Entries with `real: true` are the exception on purpose: they are NOT flagged as samples, so they
// run the live extraction pipeline (local OCR keyless; the cloud tier when a key is set) — the one
// bundled way to see how ProofCheck handles a label it can't read cleanly.
//
// NOTE: claiming source=sample is not sufficient — /api/verify only serves the mock tier when the
// uploaded bytes also hash to a known sample (lib/vision/sample-hashes.ts). Every entry below that is
// not marked `real` therefore needs a hash, or it silently falls through to live OCR while its tag
// still advertises a fixed outcome. samples.test.ts enforces both halves of that rule.
export const SAMPLES: Sample[] = [
  {
    name: "old-tom-clean.png",
    label: "Old Tom Distillery",
    tag: "Spirits · passes",
    app: {
      beverageType: "distilled-spirits",
      brandName: "OLD TOM DISTILLERY",
      classType: "Kentucky Straight Bourbon Whiskey",
      alcoholContent: "45% Alc./Vol. (90 Proof)",
      netContents: "750 mL",
      nameAndAddress: "Old Tom Distillery Co., Bardstown, KY",
      countryOfOrigin: "",
    },
  },
  {
    name: "ridge-creek-table-wine.png",
    label: "Ridge Creek",
    tag: "Table wine · passes",
    app: {
      beverageType: "wine",
      brandName: "RIDGE CREEK",
      classType: "Red Table Wine",
      alcoholContent: "",
      netContents: "750 mL",
      nameAndAddress: "",
      countryOfOrigin: "",
    },
  },
  {
    name: "harbor-point-lager.png",
    label: "Harbor Point",
    tag: "Beer · passes",
    app: {
      beverageType: "malt-beverage",
      brandName: "HARBOR POINT",
      classType: "Lager",
      alcoholContent: "",
      netContents: "12 FL OZ",
      nameAndAddress: "",
      countryOfOrigin: "",
    },
  },
  {
    name: "kirkbride-import-wine.png",
    label: "Kirkbride Cellars",
    tag: "Imported wine · passes",
    app: {
      beverageType: "wine",
      brandName: "KIRKBRIDE CELLARS",
      classType: "White Wine",
      alcoholContent: "13.5% Alc./Vol.",
      netContents: "750 mL",
      nameAndAddress: "",
      countryOfOrigin: "France",
      isImport: true,
    },
  },
  {
    name: "title-case-warning.png",
    label: "Title-case warning",
    tag: "Spirits · fails",
    advanced: true,
    app: {
      beverageType: "distilled-spirits",
      brandName: "OLD TOM DISTILLERY",
      classType: "Kentucky Straight Bourbon Whiskey",
      alcoholContent: "45% Alc./Vol. (90 Proof)",
      netContents: "750 mL",
      nameAndAddress: "",
      countryOfOrigin: "",
    },
  },
  {
    name: "wrong-class-type.png",
    label: "Wrong class/type",
    tag: "Spirits · fails",
    advanced: true,
    app: {
      beverageType: "distilled-spirits",
      brandName: "CASCADE VALLEY",
      classType: "Straight Bourbon Whiskey",
      alcoholContent: "40% Alc./Vol. (80 Proof)",
      netContents: "750 mL",
      nameAndAddress: "Cascade Valley Distillery, Portland, OR",
      countryOfOrigin: "",
    },
  },
  {
    name: "wrong-net-contents.png",
    label: "Wrong net contents",
    tag: "Spirits · fails",
    advanced: true,
    app: {
      beverageType: "distilled-spirits",
      brandName: "PACIFIC SHORE",
      classType: "Vodka",
      alcoholContent: "40% Alc./Vol. (80 Proof)",
      netContents: "750 mL",
      nameAndAddress: "Pacific Shore Spirits Co., Seattle, WA",
      countryOfOrigin: "",
    },
  },
  {
    name: "missing-name-and-address.png",
    label: "Missing name/address",
    tag: "Spirits · review",
    advanced: true,
    app: {
      beverageType: "distilled-spirits",
      brandName: "SUMMIT PEAK",
      classType: "Single Malt Whiskey",
      alcoholContent: "46% Alc./Vol. (92 Proof)",
      netContents: "750 mL",
      nameAndAddress: "Summit Peak Distillery, Denver, CO",
      countryOfOrigin: "",
    },
  },
  {
    name: "old-tom-clean-glare.png",
    label: "Bad photo (glare)",
    tag: "Spirits · real extraction",
    real: true,
    advanced: true,
    app: {
      beverageType: "distilled-spirits",
      brandName: "OLD TOM DISTILLERY",
      classType: "Kentucky Straight Bourbon Whiskey",
      alcoholContent: "45% Alc./Vol. (90 Proof)",
      netContents: "750 mL",
      nameAndAddress: "Old Tom Distillery Co., Bardstown, KY",
      countryOfOrigin: "",
    },
  },
];

/**
 * The samples that verify deterministically through the mock tier — i.e. those with an entry in
 * `SAMPLE_SHA256`. Duplicated here (rather than imported) because sample-hashes.ts pulls in
 * `node:crypto` and these names are needed by client components. `samples.test.ts` fails if the two
 * lists drift apart.
 *
 * These are what the batch page's sample loader uses: anything without a hash would fall through to
 * live OCR, which is slow and non-deterministic — the opposite of what a one-click demo needs.
 */
export const DETERMINISTIC_SAMPLES = [
  "old-tom-clean.png",
  "ridge-creek-table-wine.png",
  "harbor-point-lager.png",
  "kirkbride-import-wine.png",
  "title-case-warning.png",
  "wrong-class-type.png",
  "wrong-net-contents.png",
  "missing-name-and-address.png",
] as const;

/** Sample rows for the batch demo, in the order they should appear. */
export const BATCH_SAMPLES: Sample[] = DETERMINISTIC_SAMPLES.map((name) => {
  const sample = SAMPLES.find((s) => s.name === name);
  if (!sample) throw new Error(`DETERMINISTIC_SAMPLES names a sample missing from SAMPLES: ${name}`);
  return sample;
});
