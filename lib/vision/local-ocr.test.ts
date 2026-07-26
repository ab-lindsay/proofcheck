import { afterEach, describe, expect, it, vi } from "vitest";

const mockCreateWorker = vi.fn();
const mockRecognize = vi.fn();
vi.mock("tesseract.js", () => ({
  createWorker: (...args: unknown[]) => mockCreateWorker(...args),
  PSM: { SINGLE_COLUMN: "4" },
}));

import { localOcrProvider } from "@/lib/vision/local-ocr";

const meta = { filename: "x.png", mimeType: "image/png" };

// Matches the real tesseract.js blocks -> paragraphs -> lines shape, minimally.
function blocksFor(lines: { text: string; confidence: number }[]) {
  return [
    {
      paragraphs: [
        {
          lines: lines.map((l) => ({
            text: l.text,
            confidence: l.confidence,
            bbox: { x0: 0, y0: 0, x1: 100, y1: 20 },
          })),
        },
      ],
    },
  ];
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("localOcrProvider worker singleton", () => {
  it("does not cache a rejected worker init — a later call retries and succeeds", async () => {
    mockCreateWorker
      .mockRejectedValueOnce(new Error("eng.traineddata download failed"))
      .mockResolvedValueOnce({ recognize: mockRecognize, setParameters: vi.fn().mockResolvedValue(undefined) });
    mockRecognize.mockResolvedValue({
      data: {
        text: "OLD TOM DISTILLERY\n750 mL",
        confidence: 90,
        blocks: blocksFor([
          { text: "OLD TOM DISTILLERY", confidence: 90 },
          { text: "750 mL", confidence: 90 },
        ]),
      },
    });

    // First call: worker init rejects -> must throw, and must NOT poison the singleton.
    await expect(localOcrProvider.extract(Buffer.alloc(0), meta)).rejects.toThrow(/traineddata/);
    // Second call: the tier self-heals by re-creating the worker.
    const result = await localOcrProvider.extract(Buffer.alloc(0), meta);
    expect(result.netContents.value).toBe("750 mL");
    expect(mockCreateWorker).toHaveBeenCalledTimes(2);
  });

  it("creates the worker with the English-only pack by default", async () => {
    // The worker is a module-level singleton (see local-ocr.ts) — the existing test above already
    // resolves it, so a fresh module instance is needed to observe a real createWorker() call here.
    //
    // English-only is a MEASURED default, not an oversight (2026-07-25, 46-label real-world set):
    // adding fra/spa/ita/por changed ZERO overall verdicts (23/46 in every language configuration)
    // while costing 3.3x p95 latency and pushing max past the < 5 s budget (2164 -> 6577 ms). The one
    // apparent per-field gain was a tolerant-scoring artifact — the extra packs made the extractor
    // return null on a brand name it never read correctly either way, and NEEDS_CORRECTION scores as correct.
    // See docs/superpowers/specs/2026-07-25-local-ocr-latency-and-language-packs-design.md.
    vi.resetModules();
    mockCreateWorker.mockResolvedValueOnce({
      recognize: mockRecognize,
      setParameters: vi.fn().mockResolvedValue(undefined),
    });
    mockRecognize.mockResolvedValue({
      data: {
        text: "OLD TOM DISTILLERY",
        confidence: 90,
        blocks: blocksFor([{ text: "OLD TOM DISTILLERY", confidence: 90 }]),
      },
    });
    const { localOcrProvider: freshProvider } = await import("@/lib/vision/local-ocr");
    await freshProvider.extract(Buffer.alloc(0), meta);
    // langPath points at the vendored eng.traineddata (assets/tessdata/) so a cold Vercel instance
    // never has to fetch it from the network — see the LOCAL_ENG_LANG_PATH comment in local-ocr.ts.
    expect(mockCreateWorker).toHaveBeenCalledWith("eng", 1, {
      cachePath: "/tmp",
      langPath: expect.stringContaining("tessdata"),
    });
  });

  it("honours an OCR_LANGS override so a deployment can restore packs knowingly", async () => {
    // The escape hatch, not a feature flag: 27 CFR 5.55(c) permits all-Spanish mandatory info for
    // labels bottled for Puerto Rico, and wine (27 CFR part 4) carries no English-language
    // requirement at all — so a deployment serving such a corpus can opt back in and pay the latency.
    vi.stubEnv("OCR_LANGS", "eng+spa");
    vi.resetModules();
    mockCreateWorker.mockResolvedValueOnce({
      recognize: mockRecognize,
      setParameters: vi.fn().mockResolvedValue(undefined),
    });
    mockRecognize.mockResolvedValue({
      data: {
        text: "OLD TOM DISTILLERY",
        confidence: 90,
        blocks: blocksFor([{ text: "OLD TOM DISTILLERY", confidence: 90 }]),
      },
    });
    const { localOcrProvider: freshProvider } = await import("@/lib/vision/local-ocr");
    await freshProvider.extract(Buffer.alloc(0), meta);
    expect(mockCreateWorker).toHaveBeenCalledWith("eng+spa", 1, { cachePath: "/tmp" });
  });

  it("ignores a blank OCR_LANGS override rather than creating a worker with no language", async () => {
    // An empty or whitespace-only env var must not produce createWorker("") — that would fail worker
    // init and, via the self-heal path, retry-fail on every request, disabling the keyless tier.
    vi.stubEnv("OCR_LANGS", "   ");
    vi.resetModules();
    mockCreateWorker.mockResolvedValueOnce({
      recognize: mockRecognize,
      setParameters: vi.fn().mockResolvedValue(undefined),
    });
    mockRecognize.mockResolvedValue({
      data: {
        text: "OLD TOM DISTILLERY",
        confidence: 90,
        blocks: blocksFor([{ text: "OLD TOM DISTILLERY", confidence: 90 }]),
      },
    });
    const { localOcrProvider: freshProvider } = await import("@/lib/vision/local-ocr");
    await freshProvider.extract(Buffer.alloc(0), meta);
    expect(mockCreateWorker).toHaveBeenCalledWith("eng", 1, {
      cachePath: "/tmp",
      langPath: expect.stringContaining("tessdata"),
    });
  });

  it("requests block-level output so per-line bbox/confidence is available", async () => {
    vi.resetModules();
    mockCreateWorker.mockResolvedValueOnce({
      recognize: mockRecognize,
      setParameters: vi.fn().mockResolvedValue(undefined),
    });
    mockRecognize.mockResolvedValue({
      data: {
        text: "OLD TOM DISTILLERY",
        confidence: 90,
        blocks: blocksFor([{ text: "OLD TOM DISTILLERY", confidence: 90 }]),
      },
    });
    const { localOcrProvider: freshProvider } = await import("@/lib/vision/local-ocr");
    await freshProvider.extract(Buffer.alloc(0), meta);
    expect(mockRecognize).toHaveBeenCalledWith(expect.anything(), {}, { blocks: true });
  });

  it("clamps a non-finite per-line confidence instead of letting it poison the extracted field", async () => {
    vi.resetModules();
    mockCreateWorker.mockResolvedValueOnce({
      recognize: mockRecognize,
      setParameters: vi.fn().mockResolvedValue(undefined),
    });
    mockRecognize.mockResolvedValue({
      data: {
        text: "OLD TOM DISTILLERY",
        confidence: 90,
        blocks: blocksFor([{ text: "OLD TOM DISTILLERY", confidence: Number.NaN }]),
      },
    });
    const { localOcrProvider: freshProvider } = await import("@/lib/vision/local-ocr");
    const result = await freshProvider.extract(Buffer.alloc(0), meta);
    expect(Number.isFinite(result.brandName.confidence)).toBe(true);
    expect(result.brandName.confidence).toBe(0);
  });

  it("gracefully returns not-found fields (not a crash) when blocks is null", async () => {
    vi.resetModules();
    mockCreateWorker.mockResolvedValueOnce({
      recognize: mockRecognize,
      setParameters: vi.fn().mockResolvedValue(undefined),
    });
    mockRecognize.mockResolvedValue({ data: { text: "", confidence: 0, blocks: null } });
    const { localOcrProvider: freshProvider } = await import("@/lib/vision/local-ocr");
    const result = await freshProvider.extract(Buffer.alloc(0), meta);
    expect(result.brandName.present).toBe(false);
    expect(result.brandName.confidence).toBe(0);
  });
});
