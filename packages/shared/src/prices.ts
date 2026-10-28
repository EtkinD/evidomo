import { z } from 'zod';
import {
  addDecimals,
  decimalFromInteger,
  formatDecimalCeil,
  multiplyDecimals,
  parseDecimal,
  type ScaledDecimal,
} from './decimal.ts';

// The shared price table: list prices (Standard mode) from docs/architecture.md §10, stored per
// single billing unit so that cost = units × price is always an exact decimal product. (A price
// per audio hour divided by 3600 is not a terminating decimal in general.)

/** Fraction digits of persisted costs; matches `usage_ledger.estimated_cost_usd numeric(12,8)`. */
export const COST_USD_SCALE = 8;

const perUnitUsd = z
  .string()
  .regex(/^\d{1,6}(\.\d{1,12})?$/, 'Expected a non-negative decimal USD price per unit');

export const modelPriceSchema = z.discriminatedUnion('billing', [
  z.strictObject({
    billing: z.literal('tokens'),
    inputUsdPerToken: perUnitUsd,
    // Reasoning tokens are part of `output_tokens` and billed at this rate; they are never
    // added on top (docs/model-notes.md, P1-01).
    outputUsdPerToken: perUnitUsd,
  }),
  z.strictObject({ billing: z.literal('audio_seconds'), usdPerAudioSecond: perUnitUsd }),
  z.strictObject({ billing: z.literal('images'), usdPerImage: perUnitUsd }),
]);
export type ModelPrice = z.infer<typeof modelPriceSchema>;
export type BillingKind = ModelPrice['billing'];

export const priceTableSchema = z.record(z.string().min(1), modelPriceSchema);
export type PriceTable = Readonly<Record<string, ModelPrice>>;

export function parsePriceTable(input: unknown): PriceTable {
  return priceTableSchema.parse(input);
}

export const PRICE_TABLE: PriceTable = parsePriceTable({
  // $1.25 in / $4.25 out per 1M tokens.
  'muse-spark-1.3': {
    billing: 'tokens',
    inputUsdPerToken: '0.00000125',
    outputUsdPerToken: '0.00000425',
  },
  // $4.00 in / $20.00 out per 1M tokens; reasoning billed as output.
  'muse-wonder-1.0': {
    billing: 'tokens',
    inputUsdPerToken: '0.000004',
    outputUsdPerToken: '0.00002',
  },
  // $0.18 per audio hour.
  'muse-voice-transcribe-1.0': { billing: 'audio_seconds', usdPerAudioSecond: '0.00005' },
  // $0.01 per image.
  'muse-image-1.0': { billing: 'images', usdPerImage: '0.01' },
  // $2.50 per 1,000 images.
  'sam-3.1': { billing: 'images', usdPerImage: '0.0025' },
});

export function findModelPrice(table: PriceTable, modelId: string): ModelPrice | undefined {
  return Object.hasOwn(table, modelId) ? table[modelId] : undefined;
}

/** Billable units of one model call. Only the units of the model's billing kind are required. */
export interface BillableUnits {
  /** Includes cached input tokens; no cache discount is documented, so they bill at full rate. */
  readonly inputTokens?: number | undefined;
  /** Already includes reasoning tokens. */
  readonly outputTokens?: number | undefined;
  /** Whole milliseconds of billed audio. */
  readonly audioDurationMs?: number | undefined;
  readonly images?: number | undefined;
}

export type BillableUnitField = keyof BillableUnits;

export type CostResult =
  | { readonly ok: true; readonly billing: BillingKind; readonly costUsd: string }
  | { readonly ok: false; readonly reason: 'unknown_model' }
  | {
      readonly ok: false;
      readonly reason: 'missing_units' | 'invalid_units';
      readonly fields: readonly BillableUnitField[];
    };

const REQUIRED_UNITS: Readonly<Record<BillingKind, readonly BillableUnitField[]>> = {
  tokens: ['inputTokens', 'outputTokens'],
  audio_seconds: ['audioDurationMs'],
  images: ['images'],
};

/**
 * Estimated cost of one call as an exact decimal string with {@link COST_USD_SCALE} fraction
 * digits, rounded up. Unknown models and missing or invalid units are reported, never priced as
 * zero: an unpriced call would silently stop counting toward the budget caps.
 */
export function computeCostUsd(
  table: PriceTable,
  modelId: string,
  units: BillableUnits,
): CostResult {
  const price = findModelPrice(table, modelId);
  if (price === undefined) return { ok: false, reason: 'unknown_model' };

  const required = REQUIRED_UNITS[price.billing];
  const missing = required.filter((field) => units[field] === undefined);
  if (missing.length > 0) return { ok: false, reason: 'missing_units', fields: missing };
  const invalid = required.filter((field) => {
    const value = units[field];
    return value === undefined || !Number.isSafeInteger(value) || value < 0;
  });
  if (invalid.length > 0) return { ok: false, reason: 'invalid_units', fields: invalid };

  // Validated above: every required field is a non-negative safe integer.
  const count = (field: BillableUnitField, scale = 0): ScaledDecimal =>
    decimalFromInteger(units[field] ?? 0, scale);

  let cost: ScaledDecimal;
  switch (price.billing) {
    case 'tokens':
      cost = addDecimals(
        multiplyDecimals(count('inputTokens'), parseDecimal(price.inputUsdPerToken)),
        multiplyDecimals(count('outputTokens'), parseDecimal(price.outputUsdPerToken)),
      );
      break;
    case 'audio_seconds':
      // Milliseconds are seconds with scale 3.
      cost = multiplyDecimals(count('audioDurationMs', 3), parseDecimal(price.usdPerAudioSecond));
      break;
    case 'images':
      cost = multiplyDecimals(count('images'), parseDecimal(price.usdPerImage));
      break;
    default: {
      const unreachable: never = price;
      throw new Error(`Unhandled billing kind: ${JSON.stringify(unreachable)}`);
    }
  }
  return { ok: true, billing: price.billing, costUsd: formatDecimalCeil(cost, COST_USD_SCALE) };
}
