import { describe, expect, it } from 'vitest';
import {
  createInMemoryUsageRecorder,
  createTokenPriceEstimator,
  UsageCaptureError,
  usageEntryFromOpenAIResult,
  type TokenUsage,
} from './usage.ts';

const estimate = createTokenPriceEstimator({
  'muse-spark-1.3': { inputUsdPerMillion: 1.25, outputUsdPerMillion: 4.25 },
});

function tokens(overrides: Partial<TokenUsage>): TokenUsage {
  return {
    modelId: 'muse-spark-1.3',
    inputTokens: 20,
    cachedInputTokens: 0,
    outputTokens: 540,
    reasoningTokens: 515,
    totalTokens: 560,
    ...overrides,
  };
}

describe('createTokenPriceEstimator', () => {
  it('bills output (which already contains reasoning) at the output rate', () => {
    // 20 * 1.25 / 1M + 540 * 4.25 / 1M
    expect(estimate(tokens({}))).toBeCloseTo(0.00232, 8);
  });

  it('returns undefined for unknown models or missing counts', () => {
    expect(estimate(tokens({ modelId: 'unknown-model' }))).toBeUndefined();
    expect(estimate(tokens({ modelId: 'toString' }))).toBeUndefined();
    expect(estimate(tokens({ outputTokens: undefined }))).toBeUndefined();
  });
});

describe('usageEntryFromOpenAIResult', () => {
  it('reads Responses API usage', () => {
    const entry = usageEntryFromOpenAIResult(
      {
        id: 'resp_1',
        model: 'muse-spark-1.3',
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens: 540,
          output_tokens_details: { reasoning_tokens: 515 },
          total_tokens: 560,
        },
      },
      12.5,
      estimate,
    );
    expect(entry).toEqual({
      sdk: 'openai',
      modelId: 'muse-spark-1.3',
      responseId: 'resp_1',
      inputTokens: 20,
      cachedInputTokens: 4,
      outputTokens: 540,
      reasoningTokens: 515,
      totalTokens: 560,
      latencyMs: 12.5,
      estimatedCostUsd: expect.closeTo(0.00232, 8) as unknown,
    });
  });

  it('reads Chat Completions usage', () => {
    const entry = usageEntryFromOpenAIResult(
      {
        id: 'chatcmpl_1',
        model: 'muse-spark-1.3',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 12 },
          total_tokens: 40,
        },
      },
      1,
      undefined,
    );
    expect(entry).toMatchObject({
      inputTokens: 10,
      outputTokens: 30,
      reasoningTokens: 12,
      cachedInputTokens: undefined,
      estimatedCostUsd: undefined,
    });
  });

  it('records a call without usage as unknown counts, not zero', () => {
    const entry = usageEntryFromOpenAIResult({ model: 'muse-spark-1.3' }, 1, estimate);
    expect(entry.inputTokens).toBeUndefined();
    expect(entry.outputTokens).toBeUndefined();
    expect(entry.estimatedCostUsd).toBeUndefined();
  });

  it('rejects a malformed usage payload', () => {
    expect(() =>
      usageEntryFromOpenAIResult(
        { model: 'muse-spark-1.3', usage: { input_tokens: -1, output_tokens: 2 } },
        1,
        estimate,
      ),
    ).toThrow(UsageCaptureError);
    expect(() => usageEntryFromOpenAIResult({ usage: {} }, 1, estimate)).toThrow(UsageCaptureError);
  });
});

describe('createInMemoryUsageRecorder', () => {
  it('keeps entries until cleared', () => {
    const recorder = createInMemoryUsageRecorder();
    const entry = usageEntryFromOpenAIResult({ model: 'm' }, 1, undefined);
    recorder.record(entry);
    expect(recorder.entries).toEqual([entry]);
    recorder.clear();
    expect(recorder.entries).toEqual([]);
  });
});
