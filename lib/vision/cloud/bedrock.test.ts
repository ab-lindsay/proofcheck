import { afterEach, describe, expect, it, vi } from "vitest";
import { bedrockProvider } from "@/lib/vision/cloud/bedrock";
import { EXTRACTION_PROMPT } from "@/lib/vision/model-extraction";
import { MOCK_FIXTURES } from "@/lib/vision/mock";

const IMAGE = Buffer.from("fake-image-bytes");
const META = { filename: "upload.png", mimeType: "image/png" };
const VALID_CONTENT = JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]);

function okResponse(text: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ output: { message: { content: [{ text }] } } }),
    text: async () => "",
  };
}

// Mimics real fetch's abort behavior (undici rejects the in-flight request when its AbortSignal
// fires) without ever resolving on its own, so the only way the returned promise settles is via
// the timeout wiring under test actually calling controller.abort().
function hangingFetch() {
  return vi.fn((_url: string, init: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
      });
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("bedrockProvider", () => {
  it("fails fast with a clear error when AWS_BEARER_TOKEN_BEDROCK is unset, without calling fetch", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(bedrockProvider.extract(IMAGE, META)).rejects.toThrow(/AWS_BEARER_TOKEN_BEDROCK is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the Converse request contract to the correct URL", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONTENT));
    vi.stubGlobal("fetch", fetchMock);

    await bedrockProvider.extract(IMAGE, META);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://bedrock-runtime.us-east-2.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse",
    );
    expect(init.headers["Authorization"]).toBe("Bearer test-token");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    const content = body.messages[0].content;
    expect(content[0]).toEqual({ text: EXTRACTION_PROMPT });
    expect(content[1].image.format).toBe("png");
    // Regression guard for the byte-encoding correction: base64 STRING, not a number array.
    expect(content[1].image.source.bytes).toBe(IMAGE.toString("base64"));
    expect(typeof content[1].image.source.bytes).toBe("string");
    expect(body.inferenceConfig.maxTokens).toBe(2000);
  });

  it("parses a valid response into an ExtractedLabel", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(VALID_CONTENT)));
    const r = await bedrockProvider.extract(IMAGE, META);
    expect(r.brandName.value).toBe("OLD TOM DISTILLERY");
    expect(r.brandName.present).toBe(true);
  });

  it("fails closed on a non-OK response", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({}),
      text: async () => "AccessDeniedException: not authorized",
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(bedrockProvider.extract(IMAGE, META)).rejects.toThrow(/Bedrock 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses BEDROCK_REGION and BEDROCK_MODEL overrides when set", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    vi.stubEnv("BEDROCK_REGION", "eu-west-1");
    vi.stubEnv("BEDROCK_MODEL", "amazon.nova-pro-v1:0");
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONTENT));
    vi.stubGlobal("fetch", fetchMock);
    await bedrockProvider.extract(IMAGE, META);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://bedrock-runtime.eu-west-1.amazonaws.com/model/amazon.nova-pro-v1%3A0/converse",
    );
  });

  it("ignores AWS_REGION (platform-populated on Vercel/Lambda, not user-controlled)", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    // Simulates Vercel's Lambda runtime auto-populating AWS_REGION even though nobody set it —
    // the adapter must not pick this up, or a deploy would silently target the wrong region.
    vi.stubEnv("AWS_REGION", "ap-southeast-1");
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONTENT));
    vi.stubGlobal("fetch", fetchMock);
    await bedrockProvider.extract(IMAGE, META);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://bedrock-runtime.us-east-2.amazonaws.com/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse",
    );
  });

  it("aborts the in-flight fetch once BEDROCK_TIMEOUT_MS elapses", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    vi.stubEnv("BEDROCK_TIMEOUT_MS", "50");
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const pending = bedrockProvider.extract(IMAGE, META);
    let settled = false;
    pending.then(
      () => (settled = true),
      () => (settled = true),
    );

    // Just shy of the configured deadline: the hung fetch has not been aborted yet.
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);

    // The deadline itself: the timer fires, aborts the signal, and the hung fetch rejects.
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(pending).rejects.toThrow(/aborted/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("uses modelOverride when provided instead of BEDROCK_MODEL env", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    vi.stubEnv("BEDROCK_MODEL", "original-model");
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONTENT));
    vi.stubGlobal("fetch", fetchMock);

    await bedrockProvider.extract(IMAGE, META, { modelOverride: "custom-model-id" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("custom-model-id");
    expect(fetchMock.mock.calls[0][0]).not.toContain("original-model");
  });

  it("falls back to the default timeout when BEDROCK_TIMEOUT_MS is malformed", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
    vi.stubEnv("BEDROCK_TIMEOUT_MS", "not-a-number");
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const pending = bedrockProvider.extract(IMAGE, META);
    let settled = false;
    pending.then(
      () => (settled = true),
      () => (settled = true),
    );

    // A malformed value must not silently become 0/NaN — Node treats an invalid setTimeout delay
    // as ~1ms, so a broken fallback would abort almost immediately instead of holding for the full
    // default window. This mirrors bedrock.ts's DEFAULT_TIMEOUT_MS (30_000); keep in sync if that
    // constant changes.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);

    // At the default deadline: the fallback timeout fires, aborts the signal, and fetch rejects.
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(pending).rejects.toThrow(/aborted/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 20_000);
});
