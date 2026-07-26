import { z } from "zod";
import type { VisionProvider } from "@/lib/vision/types";
import { ExtractedLabelSchema } from "@/lib/schema";
import { EXTRACTION_PROMPT, extractWithModel } from "@/lib/vision/model-extraction";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen2.5vl:3b";
const DEFAULT_NUM_CTX = 8192;
const DEFAULT_TIMEOUT_MS = 60_000;

// Computed once at module load. Enforces JSON *structure* at generation time via Ollama's
// grammar-constrained sampling; Zod still validates at the boundary in extractWithModel
// (architecture rule "validate at the boundary" — cited by name: the two invariant lists number
// their entries differently) — grammars can't express numeric ranges, so post-hoc validation
// stays authoritative.
const EXTRACTION_FORMAT = z.toJSONSchema(ExtractedLabelSchema);

// A malformed override (e.g. OLLAMA_TIMEOUT_MS=abc → NaN) would otherwise reach setTimeout as NaN
// (fires immediately → every request insta-aborts) or serialize as null in the request body.
// Fall back to the default on anything but a positive integer.
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const localLlmProvider: VisionProvider = {
  name: "local-llm",
  async extract(image, _meta) {
    const baseUrl = (process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const model = process.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
    const numCtx = envInt("OLLAMA_NUM_CTX", DEFAULT_NUM_CTX);
    const timeoutMs = envInt("OLLAMA_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

    return extractWithModel(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            stream: false,
            format: EXTRACTION_FORMAT,
            // temperature 0 → deterministic extraction (this tier feeds the eval harness);
            // num_ctx raised so a label's visual tokens + prompt + JSON output are not silently
            // truncated (Ollama's default is 2048 — too small for a vision request).
            options: { num_ctx: numCtx, temperature: 0 },
            messages: [
              {
                role: "user",
                content: EXTRACTION_PROMPT,
                images: [image.toString("base64")], // native API: bare base64, no data: prefix
              },
            ],
          }),
        });
        if (!res.ok) {
          // Non-2xx (e.g. 404 "model not found" when qwen2.5vl:3b isn't pulled) throws here so it
          // propagates as an error, never gets JSON.parse'd as if it were an extraction. Fail closed.
          throw new Error(`Ollama ${res.status} ${res.statusText}: ${await res.text()}`);
        }
        const json = (await res.json()) as { message?: { content?: string } };
        return json.message?.content ?? "";
      } finally {
        clearTimeout(timer);
      }
    });
  },
};
