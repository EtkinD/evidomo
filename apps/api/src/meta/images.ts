import { generateImage, type GenerateImageResult } from 'ai';
import { z } from 'zod';
import { assertStandardModelId, type MetaClients } from './clients.ts';
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
 *
 * **Synthetic inputs only** (tests, sample generation). This path cannot turn off Muse Image's
 * built-in tools (image search, web search, shell), so customer photos must go through
 * {@link editMetaImageToolsOff} (P1-08).
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

/** Every Muse Image built-in tool off (P1-08). Meta enables all three unless told otherwise. */
export const MUSE_IMAGE_TOOLS_OFF = {
  enable_image_search: false,
  enable_web_search: false,
  enable_shell: false,
} as const;

export const IMAGE_EDITS_PATH = '/images/edits';
export const IMAGE_GENERATIONS_PATH = '/images/generations';

/** The response did not have the documented `Images Response` shape. */
export class MetaImageResponseError extends Error {
  override name = 'MetaImageResponseError';
}

/**
 * A 2xx response without an image. Meta returns this for failed or safety-filtered images and
 * does not bill them; the `openai` SDK does not retry it (unlike `generateImage`).
 */
export class MetaImageEmptyError extends Error {
  override name = 'MetaImageEmptyError';
}

export interface MetaImageToolsOffEditRequest {
  /** From the service definition; never hardcoded in reusable code. */
  readonly modelId: string;
  readonly prompt: string;
  /** One encoded input image; sent as a data URL in Meta's JSON edit body. */
  readonly image: {
    readonly bytes: Uint8Array;
    readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  };
  /** `WxH`, read by Meta as an aspect ratio only. */
  readonly size: MetaImageSize;
  readonly outputFormat: MetaImageOutputFormat;
  readonly abortSignal?: AbortSignal;
}

export type MetaImageToolsOffEditResult = Omit<MetaImageResult, 'warnings'>;

const count = z.int().nonnegative();

// Meta's documented `Images Response`. Other fields are tolerated (and ignored), so a new field
// does not fail a step; the P1-08 test pins the field list on re-recording instead.
const imagesResponseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })),
  output_format: z.string().optional(),
  usage: z
    .object({ input_tokens: count, output_tokens: count, total_tokens: count.optional() })
    .optional(),
});

// Read before full validation so that billed images are recorded even when the rest of the
// response is malformed. Unknown counts stay `undefined`, which the usage ledger refuses loudly.
const billedImagesSchema = z.object({ data: z.array(z.unknown()) });

/**
 * One edit of a customer photo with every built-in tool disabled: `POST /v1/images/edits` with
 * Meta's JSON body (`images[].image_url`) through the `openai` SDK, the only transport that
 * validates `tool_enablement` (docs/model-notes.md, P1-08). Retries and the per-attempt timeout
 * are the `openai` client's.
 *
 * Records one usage entry (`images` = returned images, the billed unit) before validating the
 * images, so a billed answer is metered even when it is unusable. Throws `MetaImageEmptyError`
 * for a 2xx response without an image, `MetaImageResponseError` for another shape, and
 * `ImageDecodeError` for bytes that are not an image.
 */
export async function editMetaImageToolsOff(
  clients: MetaClients,
  request: MetaImageToolsOffEditRequest,
): Promise<MetaImageToolsOffEditResult> {
  assertStandardModelId(request.modelId);
  const body = {
    model: request.modelId,
    prompt: request.prompt,
    images: [
      {
        image_url: `data:${request.image.mediaType};base64,${Buffer.from(request.image.bytes).toString('base64')}`,
      },
    ],
    n: 1,
    size: request.size,
    output_format: request.outputFormat,
    response_format: 'b64_json',
    tool_enablement: MUSE_IMAGE_TOOLS_OFF,
  };
  return postImageRequestToolsOff(clients, IMAGE_EDITS_PATH, body, request);
}

export type MetaImageToolsOffGenerateRequest = Omit<MetaImageToolsOffEditRequest, 'image'>;

/**
 * Text-to-image with every built-in tool disabled: `POST /v1/images/generations` through the
 * `openai` SDK. The generations JSON body parses `tool_enablement` booleans as strictly as the
 * JSON edit body (a non-boolean is a 400 naming the field, P4B-01 probe); the AI SDK's
 * {@link generateMetaImage} cannot send the field. Usage and errors as for
 * {@link editMetaImageToolsOff}.
 */
export async function generateMetaImageToolsOff(
  clients: MetaClients,
  request: MetaImageToolsOffGenerateRequest,
): Promise<MetaImageToolsOffEditResult> {
  assertStandardModelId(request.modelId);
  const body = {
    model: request.modelId,
    prompt: request.prompt,
    n: 1,
    size: request.size,
    output_format: request.outputFormat,
    response_format: 'b64_json',
    tool_enablement: MUSE_IMAGE_TOOLS_OFF,
  };
  return postImageRequestToolsOff(clients, IMAGE_GENERATIONS_PATH, body, request);
}

async function postImageRequestToolsOff(
  clients: MetaClients,
  apiPath: typeof IMAGE_EDITS_PATH | typeof IMAGE_GENERATIONS_PATH,
  body: Record<string, unknown>,
  request: Pick<MetaImageToolsOffEditRequest, 'modelId' | 'abortSignal'>,
): Promise<MetaImageToolsOffEditResult> {
  const startedAt = performance.now();
  const raw = await clients.openai.post<unknown>(apiPath, {
    body,
    ...(request.abortSignal === undefined ? {} : { signal: request.abortSignal }),
  });
  const latencyMs = performance.now() - startedAt;

  const billed = billedImagesSchema.safeParse(raw);
  const parsed = imagesResponseSchema.safeParse(raw);
  const usage = clients.recordUsage({
    sdk: 'openai',
    // The response has no `model` field (P1-06), so `captureOpenAIUsage` cannot be used.
    modelId: request.modelId,
    inputTokens: parsed.success ? parsed.data.usage?.input_tokens : undefined,
    cachedInputTokens: undefined,
    outputTokens: parsed.success ? parsed.data.usage?.output_tokens : undefined,
    reasoningTokens: undefined,
    totalTokens: parsed.success ? parsed.data.usage?.total_tokens : undefined,
    responseId: undefined,
    latencyMs,
    images: billed.success ? billed.data.data.length : undefined,
  });
  if (!parsed.success) {
    throw new MetaImageResponseError(
      `Unexpected Images Response shape:\n${z.prettifyError(parsed.error)}`,
    );
  }
  if (parsed.data.data.length === 0) {
    throw new MetaImageEmptyError('The image request returned no image');
  }

  const images = parsed.data.data.map((item) => {
    const bytes = new Uint8Array(Buffer.from(item.b64_json, 'base64'));
    return { ...imageDimensions(bytes), bytes };
  });
  return { images, usage, outputFormat: parsed.data.output_format };
}
