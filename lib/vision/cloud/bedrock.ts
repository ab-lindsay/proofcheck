import type { VisionProvider } from "@/lib/vision/types";
import { EXTRACTION_PROMPT, extractWithModel } from "@/lib/vision/model-extraction";

const DEFAULT_REGION = "us-east-2";
// Chosen empirically, not by default vendor reputation: on this project's real-world eval set
// (eval/expected-real-world.json), Claude Haiku 4.5 beat the previous default (Llama 4 Maverick)
// on real-photo accuracy (67% vs 33%) and overall (76% vs 72-80%) while staying within the 5s p95
// latency budget (4431ms). Claude Opus 4.5 scored even higher (89% overall, 81% real photos) but
// blew the latency budget (7586ms p95) — not viable as a default. See the "Model choice" section
// of docs/superpowers/specs/2026-07-24-bedrock-nova-cloud-tier-design.md for the full comparison.
const DEFAULT_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const DEFAULT_TIMEOUT_MS = 30_000;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const bedrockProvider: VisionProvider = {
  name: "bedrock",
  async extract(image, meta, options?: { modelOverride?: string }) {
    // Fail fast and clearly on a missing token, rather than sending `Authorization: Bearer
    // undefined` and letting Bedrock reject it with a confusing "Invalid API Key format" error
    // that looks like a credential problem on the AWS side. There's nothing to retry here (the
    // token won't appear on a second attempt), so this checks before extractWithModel's retry loop.
    const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (!token) {
      throw new Error(
        "AWS_BEARER_TOKEN_BEDROCK is not set — the bedrock tier requires this env var (see .env.example).",
      );
    }

    // BEDROCK_REGION, not AWS_REGION: on Vercel (this project's deploy target), AWS_REGION is
    // auto-populated by the underlying Lambda runtime even when never set explicitly — reading it
    // here would silently override the documented default with whatever region Vercel's function
    // happens to run in, and there's no way to tell "the user set this on purpose" from "the
    // platform populated it" once it's just an env var. A tier-specific name (matching
    // BEDROCK_MODEL/BEDROCK_TIMEOUT_MS) sidesteps the ambiguity entirely.
    const region = process.env.BEDROCK_REGION ?? DEFAULT_REGION;
    const model = options?.modelOverride ?? process.env.BEDROCK_MODEL ?? DEFAULT_MODEL;
    const timeoutMs = envInt("BEDROCK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    const format = meta.mimeType.split("/")[1] ?? "png";

    return extractWithModel(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(
          `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            signal: controller.signal,
            body: JSON.stringify({
              messages: [
                {
                  role: "user",
                  content: [
                    { text: EXTRACTION_PROMPT },
                    // source.bytes is a base64 STRING over raw HTTP (the AWS SDK accepts a Uint8Array
                    // from your code and base64-encodes it for you onto the wire; building the JSON
                    // body directly means doing that encoding step ourselves).
                    { image: { format, source: { bytes: image.toString("base64") } } },
                  ],
                },
              ],
              // Nova's Converse schema has no JSON-mode field (unlike OpenAI/Ollama's response_format);
              // EXTRACTION_PROMPT's own "Return ONLY a JSON object" instruction plus extractWithModel's
              // fence-stripping + one-retry parse loop (extractWithModel) carry reliability instead.
              inferenceConfig: { maxTokens: 2000 },
            }),
          },
        );
        if (!res.ok) {
          const body = await res.text().catch(() => "<unreadable>");
          throw new Error(`Bedrock ${res.status} ${res.statusText}: ${body}`);
        }
        const json = (await res.json()) as {
          output?: { message?: { content?: { text?: string }[] } };
        };
        return json.output?.message?.content?.[0]?.text ?? "";
      } finally {
        clearTimeout(timer);
      }
    });
  },
};
