import type { ExtractedLabel } from "@/lib/schema";

export interface ImageMeta {
  filename?: string;
  mimeType: string;
}

export interface BedrockExtractOptions {
  modelOverride?: string;
}

export interface VisionProvider {
  readonly name: string;
  extract(image: Buffer, meta: ImageMeta, options?: BedrockExtractOptions): Promise<ExtractedLabel>;
}
