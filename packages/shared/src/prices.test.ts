import { describe, expect, it } from 'vitest';
import { formatDecimalCeil, multiplyDecimals, parseDecimal } from './decimal.ts';
import {
  computeCostUsd,
  findModelPrice,
  parsePriceTable,
  PRICE_TABLE,
  type ModelPrice,
} from './prices.ts';

function scaled(price: string, factor: number): string {
  return formatDecimalCeil(multiplyDecimals(parseDecimal(price), parseDecimal(String(factor))), 2);
}

function priceOf(modelId: string): ModelPrice {
  const price = findModelPrice(PRICE_TABLE, modelId);
  if (price === undefined) throw new Error(`${modelId} is not in the price table`);
  return price;
}

describe('PRICE_TABLE', () => {
  it('matches the list prices in docs/architecture.md §10', () => {
    const spark = priceOf('muse-spark-1.3');
    const wonder = priceOf('muse-wonder-1.0');
    const voice = priceOf('muse-voice-transcribe-1.0');
    const image = priceOf('muse-image-1.0');
    const sam = priceOf('sam-3.1');

    expect(spark.billing === 'tokens' && scaled(spark.inputUsdPerToken, 1_000_000)).toBe('1.25');
    expect(spark.billing === 'tokens' && scaled(spark.outputUsdPerToken, 1_000_000)).toBe('4.25');
    expect(wonder.billing === 'tokens' && scaled(wonder.inputUsdPerToken, 1_000_000)).toBe('4.00');
    expect(wonder.billing === 'tokens' && scaled(wonder.outputUsdPerToken, 1_000_000)).toBe(
      '20.00',
    );
    expect(voice.billing === 'audio_seconds' && scaled(voice.usdPerAudioSecond, 3600)).toBe('0.18');
    expect(image.billing === 'images' && scaled(image.usdPerImage, 1)).toBe('0.01');
    expect(sam.billing === 'images' && scaled(sam.usdPerImage, 1000)).toBe('2.50');
  });

  it('never prices Contributor-mode models', () => {
    expect(Object.keys(PRICE_TABLE).some((id) => id.endsWith('-contributor'))).toBe(false);
  });

  it('does not resolve inherited object keys as models', () => {
    expect(findModelPrice(PRICE_TABLE, 'toString')).toBeUndefined();
    expect(findModelPrice(PRICE_TABLE, '__proto__')).toBeUndefined();
  });

  it('rejects malformed tables', () => {
    expect(() => parsePriceTable({ m: { billing: 'tokens', inputUsdPerToken: '0.1' } })).toThrow();
    expect(() => parsePriceTable({ m: { billing: 'images', usdPerImage: 0.01 } })).toThrow();
    expect(() => parsePriceTable({ m: { billing: 'images', usdPerImage: '-0.01' } })).toThrow();
    expect(() =>
      parsePriceTable({ m: { billing: 'images', usdPerImage: '0.01', extra: '1' } }),
    ).toThrow();
  });
});

describe('computeCostUsd', () => {
  it('bills Spark input and output, with reasoning inside output and not added again', () => {
    // Recorded P1-01 call: 20 input, 540 output of which 515 reasoning.
    // 20 × 0.00000125 + 540 × 0.00000425 = 0.000025 + 0.002295
    expect(
      computeCostUsd(PRICE_TABLE, 'muse-spark-1.3', { inputTokens: 20, outputTokens: 540 }),
    ).toEqual({ ok: true, billing: 'tokens', costUsd: '0.00232000' });
  });

  it('bills Wonder reasoning at the output rate exactly once', () => {
    // 1,000 in + 2,000 out (1,500 of them reasoning): 0.004 + 0.04. Adding reasoning on top
    // would give 0.074.
    expect(
      computeCostUsd(PRICE_TABLE, 'muse-wonder-1.0', { inputTokens: 1_000, outputTokens: 2_000 }),
    ).toEqual({ ok: true, billing: 'tokens', costUsd: '0.04400000' });
  });

  it('bills audio per second from whole milliseconds', () => {
    // 183.25 s × $0.18 / 3600 s
    expect(
      computeCostUsd(PRICE_TABLE, 'muse-voice-transcribe-1.0', { audioDurationMs: 183_250 }),
    ).toEqual({ ok: true, billing: 'audio_seconds', costUsd: '0.00916250' });
    // One hour is exactly the list price.
    expect(
      computeCostUsd(PRICE_TABLE, 'muse-voice-transcribe-1.0', { audioDurationMs: 3_600_000 }),
    ).toMatchObject({ costUsd: '0.18000000' });
  });

  it('bills images per image', () => {
    expect(computeCostUsd(PRICE_TABLE, 'sam-3.1', { images: 4 })).toEqual({
      ok: true,
      billing: 'images',
      costUsd: '0.01000000',
    });
    expect(computeCostUsd(PRICE_TABLE, 'muse-image-1.0', { images: 3 })).toMatchObject({
      costUsd: '0.03000000',
    });
  });

  it('accepts zero counts as real, reported zeros', () => {
    expect(
      computeCostUsd(PRICE_TABLE, 'muse-spark-1.3', { inputTokens: 0, outputTokens: 0 }),
    ).toMatchObject({ ok: true, costUsd: '0.00000000' });
  });

  it('rounds sub-precision costs up to 8 fraction digits', () => {
    const table = parsePriceTable({
      fake: { billing: 'tokens', inputUsdPerToken: '0.000000001', outputUsdPerToken: '0' },
    });
    expect(computeCostUsd(table, 'fake', { inputTokens: 1, outputTokens: 0 })).toMatchObject({
      costUsd: '0.00000001',
    });
    expect(computeCostUsd(table, 'fake', { inputTokens: 10, outputTokens: 0 })).toMatchObject({
      costUsd: '0.00000001',
    });
    expect(computeCostUsd(table, 'fake', { inputTokens: 11, outputTokens: 0 })).toMatchObject({
      costUsd: '0.00000002',
    });
  });

  it('reports unknown models instead of pricing them as zero', () => {
    expect(
      computeCostUsd(PRICE_TABLE, 'unknown-model', { inputTokens: 1, outputTokens: 1 }),
    ).toEqual({ ok: false, reason: 'unknown_model' });
  });

  it('reports the missing units of the billing kind', () => {
    expect(computeCostUsd(PRICE_TABLE, 'muse-spark-1.3', { inputTokens: 20 })).toEqual({
      ok: false,
      reason: 'missing_units',
      fields: ['outputTokens'],
    });
    expect(
      computeCostUsd(PRICE_TABLE, 'muse-voice-transcribe-1.0', { inputTokens: 5, outputTokens: 5 }),
    ).toEqual({ ok: false, reason: 'missing_units', fields: ['audioDurationMs'] });
    expect(computeCostUsd(PRICE_TABLE, 'sam-3.1', {})).toEqual({
      ok: false,
      reason: 'missing_units',
      fields: ['images'],
    });
  });

  it('reports negative and fractional units as invalid', () => {
    expect(computeCostUsd(PRICE_TABLE, 'sam-3.1', { images: -1 })).toEqual({
      ok: false,
      reason: 'invalid_units',
      fields: ['images'],
    });
    expect(
      computeCostUsd(PRICE_TABLE, 'muse-voice-transcribe-1.0', { audioDurationMs: 1.5 }),
    ).toMatchObject({ ok: false, reason: 'invalid_units' });
  });
});
