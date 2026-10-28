import { generateText } from 'ai';
import { z } from 'zod';
import type { MetaClients } from './clients.ts';
import { imageDimensions, type ImageDimensions } from './images.ts';
import { metaProviderOptions, type MetaReasoningEffort } from './options.ts';
import { parseSamImageOutput, SamOutputError, type SamInstance } from './sam-output.ts';
import type { UsageEntry } from './usage.ts';

/**
 * Text-prompt segmentation with SAM 3.1 through the AI SDK (Responses API, non-streaming).
 * See docs/model-notes.md, P1-05: the AI SDK passes the special-token text through unchanged,
 * SAM is billed per image (`usage.images_processed`), and token counts are reported as 0.
 */

export interface SamSegmentRequest {
  /** From the service definition; never hardcoded in reusable code. */
  readonly modelId: string;
  /**
   * One short noun phrase ("window", "license plate"). SAM has no multi-concept syntax: lists
   * return zero matches, so several object types mean several calls.
   */
  readonly phrase: string;
  /** Encoded image (JPEG, PNG, or WebP). Orientation must already be applied to the pixels. */
  readonly image: Uint8Array;
  /**
   * Sent like every Responses call (`metaProviderOptions`). SAM accepts and echoes it; no effect
   * on segmentation is documented or observed.
   */
  readonly reasoningEffort: MetaReasoningEffort;
  /** Ask for per-instance confidence (`metadata.include_confidence`). Default `true`. */
  readonly includeConfidence?: boolean;
  readonly abortSignal?: AbortSignal;
}

/** One segmented instance. `label` is the request phrase: SAM segments, it does not classify. */
export interface SamSegment extends SamInstance {
  readonly label: string;
}

export interface SamSegmentResult {
  readonly phrase: string;
  /** Size and format read from the input image header; boxes are in these pixels. */
  readonly image: ImageDimensions;
  readonly segments: readonly SamSegment[];
  /** The model's `output_text`, verbatim (for logs and fixtures). */
  readonly rawText: string;
  readonly responseId: string | undefined;
  /** The entry recorded through the usage recorder (`images` = billed images). */
  readonly usage: UsageEntry;
}

export class SamRequestError extends Error {
  override name = 'SamRequestError';
}

export class SamResponseError extends Error {
  override name = 'SamResponseError';
}

/** Characters that would turn a phrase into a list (zero matches) or into box/point prompts. */
const FORBIDDEN_PHRASE_CHARS = /[\n\r,;+<>|]/;
const MAX_PHRASE_LENGTH = 80;

const MEDIA_TYPES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

const samUsageSchema = z.object({ images_processed: z.number().int().nonnegative() });

/** Validates the phrase before any credit is spent; returns it trimmed. */
export function assertSamPhrase(phrase: string): string {
  const trimmed = phrase.trim();
  if (trimmed === '') throw new SamRequestError('SAM needs a non-empty noun phrase');
  if (trimmed.length > MAX_PHRASE_LENGTH) {
    throw new SamRequestError(`SAM phrase is longer than ${MAX_PHRASE_LENGTH} characters`);
  }
  if (FORBIDDEN_PHRASE_CHARS.test(trimmed)) {
    throw new SamRequestError(
      `SAM takes one noun phrase per request; "${trimmed}" contains a list or token character`,
    );
  }
  return trimmed;
}

/**
 * Segments every instance of one noun phrase in one image. Records usage (1 billed image per
 * call, as reported by the API) before parsing, so a call whose output is rejected is still
 * metered. Throws `SamRequestError` for invalid input (no call made), `SamResponseError` for an
 * incomplete or unmeasured response, and `SamOutputError` for malformed special-token output.
 */
export async function segmentImage(
  clients: MetaClients,
  request: SamSegmentRequest,
): Promise<SamSegmentResult> {
  const phrase = assertSamPhrase(request.phrase);
  const image = imageDimensions(request.image);
  const { maxRetries, timeout } = clients.aiSdkCallOptions();
  const base = metaProviderOptions({ reasoningEffort: request.reasoningEffort });

  const startedAt = performance.now();
  // `onLanguageModelCallEnd` is deliberately not passed: it would record a token entry with
  // zero tokens and no image count. Usage is recorded below from `usage.images_processed`.
  const result = await generateText({
    model: clients.languageModel(request.modelId),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: phrase },
          {
            type: 'file',
            mediaType: MEDIA_TYPES[image.format],
            data: { type: 'data', data: request.image },
          },
        ],
      },
    ],
    providerOptions: {
      openai: {
        ...base.openai,
        // Metadata values are strings on this API. `one_bit` is the only encoding we decode.
        metadata: {
          mask_encoding: 'one_bit',
          include_confidence: (request.includeConfidence ?? true) ? 'true' : 'false',
        },
      },
    },
    maxRetries,
    timeout,
    ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
  });
  const latencyMs = performance.now() - startedAt;

  const billed = samUsageSchema.safeParse(result.usage.raw);
  const usage = clients.recordUsage({
    sdk: 'ai-sdk',
    modelId: result.response.modelId,
    inputTokens: result.usage.inputTokens,
    cachedInputTokens: result.usage.inputTokenDetails.cacheReadTokens,
    outputTokens: result.usage.outputTokens,
    reasoningTokens: result.usage.outputTokenDetails.reasoningTokens,
    totalTokens: result.usage.totalTokens,
    responseId: result.response.id,
    latencyMs,
    images: billed.success ? billed.data.images_processed : undefined,
  });
  if (!billed.success) {
    throw new SamResponseError('SAM response has no usage.images_processed; the call is unmetered');
  }
  if (result.finishReason !== 'stop') {
    throw new SamResponseError(
      `SAM response did not complete (finish reason ${result.finishReason})`,
    );
  }

  const output = parseSamImageOutput(result.text);
  const size = output.sourceSize;
  if (size !== undefined && (size.width !== image.width || size.height !== image.height)) {
    throw new SamOutputError(
      `SAM reports a ${size.width}x${size.height} source, but the image is ${image.width}x${image.height}`,
    );
  }

  return {
    phrase,
    image,
    segments: output.instances.map((instance) => ({ ...instance, label: phrase })),
    rawText: result.text,
    responseId: result.response.id,
    usage,
  };
}
