import type { LanguageModelCallEndEvent } from 'ai';
import { z } from 'zod';

/** Which SDK made the call; both talk to the same Meta endpoint. */
export type MetaSdk = 'ai-sdk' | 'openai';

/**
 * Token counts for one model call, as reported by the API.
 *
 * `outputTokens` already includes `reasoningTokens` (OpenAI-compatible semantics, confirmed
 * against the recorded Spark response — see docs/model-notes.md, P1-01). Counts are
 * `undefined` when the API did not report them; they are never guessed.
 */
export interface TokenUsage {
  readonly modelId: string;
  readonly inputTokens: number | undefined;
  readonly cachedInputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
  readonly totalTokens: number | undefined;
}

export interface UsageEntry extends TokenUsage {
  readonly sdk: MetaSdk;
  /** Provider response ID, when the API returned one. */
  readonly responseId: string | undefined;
  /** Wall-clock time of the call including SDK retries, in milliseconds. */
  readonly latencyMs: number;
  /**
   * For display and logs only. The usage ledger persists an exact decimal cost computed from
   * the units with the shared price table (`computeCostUsd`), never this float.
   * `undefined` when no estimator is configured or the model has no known price.
   */
  readonly estimatedCostUsd: number | undefined;
  /**
   * Billed audio duration in whole milliseconds, for per-audio-second models (Voice). Taken from
   * the API response, never from the local file.
   */
  readonly audioDurationMs?: number | undefined;
  /** Number of billed images, for per-image models (Muse Image, SAM). */
  readonly images?: number | undefined;
}

/**
 * Sink for per-call usage. `record` is synchronous on purpose: the AI SDK invokes
 * `onLanguageModelCallEnd` inside a try/catch that silently discards errors, so a sink that can
 * fail (a DB write) must buffer here and persist after the SDK call returns.
 */
export interface UsageRecorder {
  record(entry: UsageEntry): void;
}

/**
 * Hook for a display/log cost estimate (the ledger persists its own exact cost). Audio-priced
 * calls also pass `audioDurationMs`.
 */
export type CostEstimator = (
  usage: TokenUsage & { readonly audioDurationMs?: number },
) => number | undefined;

export interface InMemoryUsageRecorder extends UsageRecorder {
  readonly entries: readonly UsageEntry[];
  clear(): void;
}

export function createInMemoryUsageRecorder(): InMemoryUsageRecorder {
  const entries: UsageEntry[] = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
    },
    clear() {
      entries.length = 0;
    },
  };
}

export interface TokenPrice {
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

/**
 * Estimates cost from a per-model token price list. Reasoning tokens are billed at the output
 * rate and are already part of `outputTokens`, so they are not added a second time.
 */
export function createTokenPriceEstimator(
  prices: Readonly<Record<string, TokenPrice>>,
): CostEstimator {
  return (usage) => {
    const price = Object.hasOwn(prices, usage.modelId) ? prices[usage.modelId] : undefined;
    if (
      price === undefined ||
      usage.inputTokens === undefined ||
      usage.outputTokens === undefined
    ) {
      return undefined;
    }
    return (
      (usage.inputTokens * price.inputUsdPerMillion +
        usage.outputTokens * price.outputUsdPerMillion) /
      1_000_000
    );
  };
}

export function usageEntryFromAiSdkCall(
  event: Pick<LanguageModelCallEndEvent, 'modelId' | 'usage' | 'responseId' | 'performance'>,
  estimateCost: CostEstimator | undefined,
): UsageEntry {
  const tokens: TokenUsage = {
    modelId: event.modelId,
    inputTokens: event.usage.inputTokens,
    cachedInputTokens: event.usage.inputTokenDetails.cacheReadTokens,
    outputTokens: event.usage.outputTokens,
    reasoningTokens: event.usage.outputTokenDetails.reasoningTokens,
    totalTokens: event.usage.totalTokens,
  };
  return {
    ...tokens,
    sdk: 'ai-sdk',
    responseId: event.responseId,
    latencyMs: event.performance.responseTimeMs,
    estimatedCostUsd: estimateCost?.(tokens),
  };
}

const count = z.number().int().nonnegative();

// Responses API shape (`input_tokens`/`output_tokens`) and Chat Completions shape
// (`prompt_tokens`/`completion_tokens`); the openai SDK can hit either endpoint.
const responsesUsageSchema = z.object({
  input_tokens: count,
  input_tokens_details: z.object({ cached_tokens: count.optional() }).nullish(),
  output_tokens: count,
  output_tokens_details: z.object({ reasoning_tokens: count.optional() }).nullish(),
  total_tokens: count.optional(),
});
const chatUsageSchema = z.object({
  prompt_tokens: count,
  prompt_tokens_details: z.object({ cached_tokens: count.optional() }).nullish(),
  completion_tokens: count,
  completion_tokens_details: z.object({ reasoning_tokens: count.optional() }).nullish(),
  total_tokens: count.optional(),
});

const openAIResultSchema = z.object({
  id: z.string().optional(),
  model: z.string().min(1),
  usage: z.union([responsesUsageSchema, chatUsageSchema]).nullish(),
});

export class UsageCaptureError extends Error {
  override name = 'UsageCaptureError';
}

/** Builds a usage entry from an `openai` SDK result (Responses or Chat Completions). */
export function usageEntryFromOpenAIResult(
  result: unknown,
  latencyMs: number,
  estimateCost: CostEstimator | undefined,
): UsageEntry {
  const parsed = openAIResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new UsageCaptureError(
      `Unexpected usage shape in Meta API response:\n${z.prettifyError(parsed.error)}`,
    );
  }
  const { id, model, usage } = parsed.data;
  let tokens: TokenUsage;
  if (usage == null) {
    tokens = {
      modelId: model,
      inputTokens: undefined,
      cachedInputTokens: undefined,
      outputTokens: undefined,
      reasoningTokens: undefined,
      totalTokens: undefined,
    };
  } else if ('input_tokens' in usage) {
    tokens = {
      modelId: model,
      inputTokens: usage.input_tokens,
      cachedInputTokens: usage.input_tokens_details?.cached_tokens,
      outputTokens: usage.output_tokens,
      reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
      totalTokens: usage.total_tokens,
    };
  } else {
    tokens = {
      modelId: model,
      inputTokens: usage.prompt_tokens,
      cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
      outputTokens: usage.completion_tokens,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      totalTokens: usage.total_tokens,
    };
  }
  return {
    ...tokens,
    sdk: 'openai',
    responseId: id,
    latencyMs,
    estimatedCostUsd: estimateCost?.(tokens),
  };
}
