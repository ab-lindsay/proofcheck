import { createHash } from "node:crypto";

// SHA-256 of each bundled demo sample (public/samples/*.png). The /api/verify route uses the mock tier
// for a request ONLY when the client says source=sample AND the uploaded bytes hash to one of these —
// so a caller cannot force the mock tier (a fabricated verdict) for arbitrary artwork merely by
// claiming source=sample with a bundled filename. `source` alone is client-controlled and untrusted.
// Regenerate after re-rendering samples: `Get-FileHash public/samples/*.png -Algorithm SHA256` (or
// `shasum -a 256 public/samples/*.png`).
//
// Every sample offered in lib/samples.ts must appear here EXCEPT those marked `real`, which are meant
// to run live extraction. A missing entry is not a loud failure — the sample silently falls through
// to OCR while its UI tag still advertises a fixed outcome — so samples.test.ts enforces the rule.
export const SAMPLE_SHA256: Record<string, string> = {
  "old-tom-clean.png": "14bc437560c2504571a821c4e0aa9521760ce9af4abd4ae189ff47c6cd113516",
  "title-case-warning.png": "fe82a7c55171d2ed60da49998c75754cffcbc7509fea3b6f0ce91af4050b7a2e",
  "ridge-creek-table-wine.png": "3b5d578ca0c18198a64e6a6db370197035f34d7fd16f5894ea9fa2a4e0af6fac",
  "harbor-point-lager.png": "d006e04e8b7a14395e4cd009d1786fa861f309e3f9f9edee63b0a2bdb0a16b52",
  "kirkbride-import-wine.png": "e252344f37cea4d59d6b5bc9a13bb05f990d50a61b065f100a70aaeeb2243d30",
  "wrong-class-type.png": "52c46fa88701fdfbe64cf80f2b16e2bd9b1a73d5bcc2f8840cd6e680d0c5e2c6",
  "wrong-net-contents.png": "c36e034b5d91279f0c07af35e325725c0a9fa61212edfba2182238240a1cb3e2",
  "missing-name-and-address.png": "31821d314c142d7a89ca57e3b99d9c052722bedbf591e8bde0f04e7a39aca462",
  // old-tom-clean-glare.png is deliberately absent: it is marked `real` so it runs the live
  // pipeline, the one bundled way to see how ProofCheck handles a label it cannot read cleanly.
};

/** True only when `bytes` are exactly the bundled sample named `filename` (trusted mock-tier gate). */
export function isGenuineSample(filename: string, bytes: Buffer): boolean {
  const expected = SAMPLE_SHA256[filename];
  if (!expected) return false;
  return createHash("sha256").update(bytes).digest("hex") === expected;
}
