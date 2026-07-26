import type { VisionProvider } from "@/lib/vision/types";
import { isMockSample, mockProvider } from "@/lib/vision/mock";
import { localOcrProvider } from "@/lib/vision/local-ocr";
import { localLlmProvider } from "@/lib/vision/local-llm/ollama";
import { bedrockProvider } from "@/lib/vision/cloud/bedrock";

const PROVIDERS: Record<string, VisionProvider> = {
  mock: mockProvider,
  "local-ocr": localOcrProvider,
  "local-llm": localLlmProvider,
  bedrock: bedrockProvider,
};

export function providerByName(name: string): VisionProvider {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown VISION_PROVIDER "${name}" (expected mock | local-ocr | local-llm | bedrock)`);
  return provider;
}

/**
 * The single source of truth for "which cloud provider, if any, is configured" — same priority
 * order selectProvider has always used. Exported so the /api/verify route can offer an explicit
 * "cloud" tier choice (the dev-mode tier switcher) and report cloud availability (GET /api/verify)
 * without duplicating this env-var check.
 */
export function selectCloudProvider(): VisionProvider | null {
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return bedrockProvider;
  return null;
}

/**
 * Keyless by default. Bundled sample filenames use mock even when a cloud key is set, so the demo
 * stays deterministic (deliberate deviation recorded in spec §3). Otherwise: key present -> that
 * cloud provider; no key -> local-ocr.
 *
 * ONE THING OVERRIDES THAT: an explicit `VISION_PROVIDER`, checked first below. Forcing a real tier
 * therefore also re-extracts bundled samples for real, so the gallery's curated "passes"/"fails"
 * outcomes stop matching their fixtures. That is intended for eval/CI, but it makes
 * `VISION_PROVIDER` a poor choice for a local dev env file — prefer letting key priority decide, or
 * use dev mode's tier switcher, which overrides per-request without touching sample routing.
 *
 * SECURITY (resolved): tier selection here trusts `filename`, so it must only ever see one the
 * caller has PROVEN is a bundled sample. Both routes enforce that with the byte-hash gate — they
 * pass a sample name only when the client says source=sample AND the uploaded bytes SHA-256-match
 * the pinned digest (`isGenuineSample`, lib/vision/sample-hashes.ts) — so a spoofed filename on
 * arbitrary artwork can no longer reach the mock tier and collect fixture data.
 */
export function selectProvider(filename?: string): VisionProvider {
  const forced = process.env.VISION_PROVIDER;
  if (forced) {
    // The mock tier returns fabricated fixture data keyed off the (client-controlled) filename. It is a
    // demo/CI/eval affordance only — never let it be forced in a production deploy, where it would turn
    // any upload named after a fixture into a bogus APPROVED. Fail closed instead.
    if (forced === "mock" && process.env.NODE_ENV === "production") {
      throw new Error(
        "VISION_PROVIDER=mock is not allowed in production — the mock tier returns fabricated fixture data.",
      );
    }
    return providerByName(forced);
  }
  if (filename && isMockSample(filename)) return mockProvider;
  return selectCloudProvider() ?? localOcrProvider;
}
