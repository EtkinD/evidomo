import { generateImage, type GenerateImageResult } from 'ai';
import { z } from 'zod';
import type { MetaClients } from './clients.ts';
import type { UsageEntry } from './usage.ts';

/** Output formats Meta accepts for Muse Image (`webp` is the API default). */
export type MetaImageOutputFormat = 'webp' | 'png' | 'jpeg';

/** `WxH`. Meta treats it as an aspect ratio only; the returned pixel size is the model's own. */
export type MetaImageSize = `${number}x${number}`;

export interface MetaImageRequest {
  /** From the service definition; never hardcoded in reusable code. */
  readonly modelId: string;
  readonly prompt: string;
  /** Omit for the API default. */
  readonly size?: MetaImageSize;
  /** Omit for the API default (`webp`). */
  readonly outputFormat?: MetaImageOutputFormat;
  readonly abortSignal?: AbortSignal;
}

export interface MetaImageEditRequest extends MetaImageRequest {
  /** Encoded input images (JPEG, PNG, or WebP). Muse Image edits take no mask. */
  readonly images: readonly Uint8Array[];
}

export type ImageContainer = 'png' | 'jpeg' | 'webp';

export interface ImageDimensions {
  readonly format: ImageContainer;
  readonly width: number;
  readonly height: number;
}

export interface MetaImage extends ImageDimensions {
  readonly bytes: Uint8Array;
}

export interface MetaImageResult {
  readonly images: readonly MetaImage[];
  /** The entry that was recorded through the usage recorder. */
  readonly usage: UsageEntry;
  /** `output_format` as echoed by the API, when present. */
  readonly outputFormat: string | undefined;
  readonly warnings: GenerateImageResult['warnings'];
}

export class ImageDecodeError extends Error {
  override name = 'ImageDecodeError';
}

function u16be(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
}
function u16le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
}
function u24le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
}
function u32be(b: Uint8Array, i: number): number {
  return (
    (((b[i] ?? 0) << 24) >>> 0) +
    (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0))
  );
}
function ascii(b: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...b.subarray(start, start + length));
}

function jpegDimensions(b: Uint8Array): ImageDimensions | undefined {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    // SOF0..SOF15 except DHT (C4), JPG (C8), and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { format: 'jpeg', height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + u16be(b, i + 2);
  }
  return undefined;
}

function webpDimensions(b: Uint8Array): ImageDimensions | undefined {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X' && b.length >= 30) {
    return { format: 'webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { format: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const b1 = b[21] ?? 0;
    const b2 = b[22] ?? 0;
    const b3 = b[23] ?? 0;
    const b4 = b[24] ?? 0;
    return {
      format: 'webp',
      width: 1 + (b1 | ((b2 & 0x3f) << 8)),
      height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
    };
  }
  return undefined;
}

/**
 * Container format and pixel size read from the encoded header (PNG, JPEG, WebP). Model output
 * is untrusted: anything else, or a header without a size, throws `ImageDecodeError`.
 */
export function imageDimensions(bytes: Uint8Array): ImageDimensions {
  let result: ImageDimensions | undefined;
  if (bytes.length >= 24 && u32be(bytes, 0) === 0x89504e47 && ascii(bytes, 12, 4) === 'IHDR') {
    result = { format: 'png', width: u32be(bytes, 16), height: u32be(bytes, 20) };
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    result = jpegDimensions(bytes);
  } else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    result = webpDimensions(bytes);
  }
  if (result === undefined || result.width <= 0 || result.height <= 0) {
    throw new ImageDecodeError('Image is not a PNG, JPEG, or WebP with a readable size');
  }
  return result;
}

// Only `outputFormat` is read; the rest of the provider metadata is informational.
const providerMetadataSchema = z.object({
  openai: z.object({ images: z.array(z.object({ outputFormat: z.string().optional() })) }),
});

async function runImageCall(
  clients: MetaClients,
  request: MetaImageRequest,
  prompt: Parameters<typeof generateImage>[0]['prompt'],
): Promise<MetaImageResult> {
  const { maxRetries, timeout } = clients.aiSdkCallOptions();
  // generateImage has no timeout option; like the AI SDK's own `timeout`, this bounds the whole
  // call including retries.
  const timeoutSignal = AbortSignal.timeout(timeout);
  const abortSignal =
    request.abortSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([timeoutSignal, request.abortSignal]);

  const startedAt = performance.now();
  const result = await generateImage({
    model: clients.imageModel(request.modelId),
    prompt,
    n: 1,
    ...(request.size === undefined ? {} : { size: request.size }),
    // `@ai-sdk/openai`'s image model reads only the `openai` key, whatever the provider name.
    ...(request.outputFormat === undefined
      ? {}
      : { providerOptions: { openai: { outputFormat: request.outputFormat } } }),
    maxRetries,
    abortSignal,
  });
  const latencyMs = performance.now() - startedAt;

  const images = result.images.map((file) => {
    const bytes = file.uint8Array;
    return { ...imageDimensions(bytes), bytes };
  });

  const usage = clients.recordUsage({
    sdk: 'ai-sdk',
    modelId: result.responses.at(-1)?.modelId ?? request.modelId,
    inputTokens: result.usage.inputTokens,
    cachedInputTokens: undefined,
    outputTokens: result.usage.outputTokens,
    reasoningTokens: undefined,
    totalTokens: result.usage.totalTokens,
    responseId: undefined,
    latencyMs,
    images: images.length,
  });

  const metadata = providerMetadataSchema.safeParse(result.providerMetadata);
  const outputFormat = metadata.success ? metadata.data.openai.images[0]?.outputFormat : undefined;

  return { images, usage, outputFormat, warnings: result.warnings };
}

/** Text-to-image through the AI SDK (`POST /v1/images/generations`). */
export function generateMetaImage(
  clients: MetaClients,
  request: MetaImageRequest,
): Promise<MetaImageResult> {
  return runImageCall(clients, request, request.prompt);
}

/**
 * One declared-operation edit through the AI SDK (`POST /v1/images/edits`, multipart `image`).
 * Meta does not guarantee pixel preservation or the input's dimensions (docs/model-notes.md,
 * P1-06); the integrity check compares the result against the original.
 */
export function editMetaImage(
  clients: MetaClients,
  request: MetaImageEditRequest,
): Promise<MetaImageResult> {
  if (request.images.length === 0) {
    return Promise.reject(new TypeError('editMetaImage needs at least one input image'));
  }
  return runImageCall(clients, request, { text: request.prompt, images: [...request.images] });
}
