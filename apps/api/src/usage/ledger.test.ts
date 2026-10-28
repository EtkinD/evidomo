import { parsePriceTable } from '@evidomo/shared';
import { describe, expect, it } from 'vitest';
import type { TokenUsage } from '../meta/usage.ts';
import { createPriceTableCostEstimator } from './ledger.ts';

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

describe('createPriceTableCostEstimator', () => {
  const estimate = createPriceTableCostEstimator();

  it('derives the display number from the exact persisted cost', () => {
    // 20 × 0.00000125 + 540 × 0.00000425; reasoning is inside output.
    expect(estimate(tokens({}))).toBe(0.00232);
  });

  it('returns undefined when the call cannot be priced', () => {
    expect(estimate(tokens({ modelId: 'unknown-model' }))).toBeUndefined();
    expect(estimate(tokens({ outputTokens: undefined }))).toBeUndefined();
    // Token usage carries no image count, so per-image models have no display estimate.
    expect(estimate(tokens({ modelId: 'sam-3.1' }))).toBeUndefined();
  });

  it('accepts a fake price table', () => {
    const fake = createPriceTableCostEstimator(
      parsePriceTable({
        fake: { billing: 'tokens', inputUsdPerToken: '0.001', outputUsdPerToken: '0.002' },
      }),
    );
    expect(fake(tokens({ modelId: 'fake', inputTokens: 1, outputTokens: 1 }))).toBe(0.003);
  });
});
