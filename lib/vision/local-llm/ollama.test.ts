import { afterEach, describe, expect, it, vi } from "vitest";
import { localLlmProvider } from "@/lib/vision/local-llm/ollama";
import { MOCK_FIXTURES } from "@/lib/vision/mock";

const IMAGE = Buffer.from("fake-image-bytes");
const META = { filename: "upload.png", mimeType: "image/png" };
const VALID_CONTENT = JSON.stringify(MOCK_FIXTURES["old-tom-clean.png"]);

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ message: { content } }),
    text: async () => "",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// A fetch mock that never resolves on its own — it only settles once the request's AbortSignal
// fires, mirroring how a real hung `fetch` behaves once aborted. Lets the timeout tests prove the
// abort actually propagates, not just that a signal object was attached to the request init.
function hangingFetch() {
  return vi.fn().mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  );
}

describe("localLlmProvider", () => {
  it("posts the extraction request contract to /api/chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONTENT));
    vi.stubGlobal("fetch", fetchMock);

    await localLlmProvider.extract(IMAGE, META);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/chat");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.model).toBe("qwen2.5vl:3b");
    expect(body.stream).toBe(false);
    // structured outputs: the full ExtractedLabel JSON schema rides in `format`
    expect(Object.keys(body.format.properties)).toEqual(
      expect.arrayContaining([
        "brandName",
        "classType",
        "alcoholContent",
        "netContents",
        "nameAndAddress",
        "countryOfOrigin",
        "healthWarningStatement",
      ]),
    );
    // num_ctx present and raised — the regression guard for silent image-token truncation
    expect(body.options.num_ctx).toBe(8192);
    expect(body.options.temperature).toBe(0);
    // native API: bare base64 in images[], no data: URI prefix
    expect(body.messages[0].images[0]).toBe(IMAGE.toString("base64"));
    expect(body.messages[0].content).toMatch(/GOVERNMENT WARNING/);
  });

  it("parses a valid response into an ExtractedLabel", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(VALID_CONTENT)));
    const r = await localLlmProvider.extract(IMAGE, META);
    expect(r.brandName.value).toBe("OLD TOM DISTILLERY");
    expect(r.brandName.present).toBe(true);
  });

  it("fails closed on a non-OK response (model not pulled)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({}),
      text: async () => 'model "qwen2.5vl:3b" not found',
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(localLlmProvider.extract(IMAGE, META)).rejects.toThrow(/Ollama 404/);
    // transport errors propagate unwrapped on the first attempt — extractWithModel only
    // retries JSON/schema failures, so exactly one fetch:
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default num_ctx when the env override is malformed", async () => {
    vi.stubEnv("OLLAMA_NUM_CTX", "abc");
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONTENT));
    vi.stubGlobal("fetch", fetchMock);
    await localLlmProvider.extract(IMAGE, META);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options.num_ctx).toBe(8192);
  });

  it("aborts a hung fetch once OLLAMA_TIMEOUT_MS elapses", async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const pending = localLlmProvider.extract(IMAGE, META);
    // Attach the rejection handler synchronously, before advancing the clock, so the promise is
    // never briefly unhandled once the timer fires.
    const assertion = expect(pending).rejects.toThrow(/abort/i);

    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  }, 20_000);

  it("falls back to the default OLLAMA_TIMEOUT_MS (60000ms) when the env override is malformed", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OLLAMA_TIMEOUT_MS", "not-a-number");
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const pending = localLlmProvider.extract(IMAGE, META);
    const assertion = expect(pending).rejects.toThrow(/abort/i);

    // One tick before the documented default: still pending — proves the malformed override
    // didn't collapse the timeout to something shorter (e.g. NaN firing immediately).
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);

    // Crossing the documented 60_000ms default fires the abort.
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await assertion;
  }, 20_000);

  it("tolerates a trailing slash in OLLAMA_BASE_URL", async () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://gpu-box:11434/");
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_CONTENT));
    vi.stubGlobal("fetch", fetchMock);
    await localLlmProvider.extract(IMAGE, META);
    expect(fetchMock.mock.calls[0][0]).toBe("http://gpu-box:11434/api/chat");
  });
});
