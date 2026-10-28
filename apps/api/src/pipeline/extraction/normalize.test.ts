import {
  factSourceSchema,
  marketProfileSchema,
  type MarketProfile,
  type StoredTranscriptTurn,
} from '@evidomo/shared';
import { NoObjectGeneratedError } from 'ai';
import { describe, expect, it } from 'vitest';
import { NonRetryableStepError } from '../../runs/steps.ts';
import { classifyExtractionError, toFormFact, toTranscriptFact } from './handler.ts';
import {
  coerceProfileValue,
  findQuoteSpan,
  normalizeExtractedFacts,
  resolveKey,
  slugify,
} from './normalize.ts';
import type { RawExtractedFact } from './schema.ts';

// A small synthetic market in the shape of nl v1 (no personal data).
const market: MarketProfile = marketProfileSchema.parse({
  id: 'test',
  version: 1,
  name: 'Test market',
  source_languages: ['nl'],
  output_languages: ['en'],
  default_output_language: 'en',
  units: { area: 'm2', volume: 'm3' },
  currency: 'EUR',
  area_bases: [
    { id: 'NEN2580', label: 'NEN 2580 usable area' },
    { id: 'cadastral', label: 'Plot size' },
  ],
  facts: [
    { key: 'energy_label', label: 'Energy label', type: 'enum', values: ['A', 'B', 'C'] },
    { key: 'living_area', label: 'Living area', type: 'area', basis: 'NEN2580', required: true },
    { key: 'volume', label: 'Volume', type: 'volume' },
    { key: 'build_year', label: 'Build year', type: 'integer', min: 1000, max: 2100 },
    { key: 'vve_monthly_contribution', label: 'VvE contribution', type: 'money' },
    { key: 'ground_lease', label: 'Ground lease', type: 'boolean' },
  ],
  publication_checklist: [],
  flagged_phrasing: ['exclusionary'],
});

const turn = (index: number, text: string): StoredTranscriptTurn => ({
  index,
  sourceTurnIndex: index,
  speaker: 'A',
  text,
  startMs: index * 10_000,
  endMs: index * 10_000 + 9_000,
  timing: 'model',
});

const turns: StoredTranscriptTurn[] = [
  turn(0, 'De woonoppervlakte is  92 vierkante meter, gemeten volgens NEN 2580.'),
  turn(1, 'Er zijn twee slaapkamers, en het is in in 1987 gebouwd.'),
  turn(2, "Samengevat zo'n 95 vierkante meter woonoppervlak, de mooiste straat van de wijk."),
];

function raw(overrides: Partial<RawExtractedFact>): RawExtractedFact {
  return {
    turnIndex: 0,
    quote: '92 vierkante meter',
    key: 'living_area',
    otherKey: null,
    value: 92,
    unit: 'm2',
    basis: 'NEN2580',
    assertion: 'stated',
    ...overrides,
  };
}

describe('findQuoteSpan', () => {
  it('matches up to whitespace and case and returns the exact span of the turn', () => {
    const text = 'De woonoppervlakte is  92 vierkante meter, gemeten volgens NEN 2580.';
    expect(findQuoteSpan(text, 'is 92 VIERKANTE meter')).toBe('is  92 vierkante meter');
    expect(findQuoteSpan(text, '  nen 2580 ')).toBe('NEN 2580');
    expect(findQuoteSpan(text, 'is\n92\tvierkante')).toBe('is  92 vierkante');
  });

  it('rejects any other difference: corrections, punctuation, ellipses, empty quotes', () => {
    const text = 'het is in in 1987 gebouwd';
    expect(findQuoteSpan(text, 'in in 1987 gebouwd')).toBe('in in 1987 gebouwd');
    expect(findQuoteSpan(text, 'het is in 1987 gebouwd')).toBeUndefined();
    expect(findQuoteSpan("zo'n 95", 'zo’n 95')).toBeUndefined();
    expect(findQuoteSpan(text, 'het is ... gebouwd')).toBeUndefined();
    expect(findQuoteSpan(text, '   ')).toBeUndefined();
  });

  it('maps case folds that change length back to the source characters', () => {
    expect(findQuoteSpan('Straat İstanbul 3', 'i̇stanbul')).toBe('İstanbul');
  });
});

describe('resolveKey', () => {
  it('keeps profile keys chosen from the enum', () => {
    expect(resolveKey(market, 'living_area', null)).toMatchObject({
      key: 'living_area',
      repaired: false,
    });
  });

  it('files "other" under other:<slug> and repairs non-slug names', () => {
    expect(resolveKey(market, 'other', 'bedrooms')).toEqual({
      key: 'other:bedrooms',
      fact: undefined,
      repaired: false,
    });
    expect(resolveKey(market, 'other', 'Gross area (incl. storage)')).toMatchObject({
      key: 'other:gross_area_incl_storage',
      repaired: true,
    });
  });

  it('never promotes an invented or misspelled key to a profile fact', () => {
    expect(resolveKey(market, 'gross_floor_area', null)).toMatchObject({
      key: 'other:gross_floor_area',
      repaired: true,
    });
    expect(resolveKey(market, 'Living_Area', null)).toMatchObject({
      key: 'other:living_area',
      fact: undefined,
    });
    expect(resolveKey(market, 'other', 'living_area')).toMatchObject({
      key: 'other:living_area',
      fact: undefined,
    });
  });

  it('rejects names that cannot become a slug', () => {
    expect(resolveKey(market, 'other', null)).toBeUndefined();
    expect(resolveKey(market, 'other', '2nd bedroom')).toBeUndefined();
    expect(resolveKey(market, '!!!', null)).toBeUndefined();
    expect(slugify('Wóonkamer  oppervlak')).toBe('woonkamer_oppervlak');
  });
});

describe('coerceProfileValue', () => {
  const fact = (key: string) => market.facts.find((item) => item.key === key) ?? never();

  it('accepts valid values and repairs only unambiguous conversions', () => {
    expect(coerceProfileValue(fact('energy_label'), 'B')).toEqual({ value: 'B', repaired: false });
    expect(coerceProfileValue(fact('energy_label'), ' b ')).toEqual({ value: 'B', repaired: true });
    expect(coerceProfileValue(fact('living_area'), '92')).toEqual({ value: 92, repaired: true });
    expect(coerceProfileValue(fact('ground_lease'), 'no')).toEqual({
      value: false,
      repaired: true,
    });
  });

  it('rejects values that do not fit the fact type', () => {
    expect(coerceProfileValue(fact('energy_label'), 'A+')).toBeUndefined();
    expect(coerceProfileValue(fact('living_area'), 'ninety-two')).toBeUndefined();
    expect(coerceProfileValue(fact('living_area'), '92,5')).toBeUndefined();
    expect(coerceProfileValue(fact('living_area'), -1)).toBeUndefined();
    expect(coerceProfileValue(fact('build_year'), 1987.5)).toBeUndefined();
    expect(coerceProfileValue(fact('build_year'), 3000)).toBeUndefined();
    expect(coerceProfileValue(fact('ground_lease'), 'maybe')).toBeUndefined();
  });
});

describe('normalizeExtractedFacts', () => {
  it('keeps valid facts with the exact turn span and the turn timestamps', () => {
    const { accepted, rejected } = normalizeExtractedFacts(market, turns, [
      raw({ quote: 'is 92 vierkante meter' }),
      raw({
        turnIndex: 1,
        quote: 'twee slaapkamers',
        key: 'other',
        otherKey: 'bedrooms',
        value: 2,
        unit: null,
        basis: null,
      }),
    ]);
    expect(rejected).toEqual([]);
    expect(accepted).toEqual([
      {
        key: 'living_area',
        value: 92,
        unit: 'm2',
        basis: 'NEN2580',
        assertion: 'stated',
        turnIndex: 0,
        startMs: 0,
        endMs: 9_000,
        quote: 'is  92 vierkante meter',
        repaired: false,
      },
      expect.objectContaining({ key: 'other:bedrooms', value: 2, unit: null, basis: null }),
    ]);
  });

  it('keeps the same quantity from two turns as two facts (the planted 92 vs ~95)', () => {
    const { accepted } = normalizeExtractedFacts(market, turns, [
      raw({}),
      raw({ turnIndex: 2, quote: "zo'n 95 vierkante meter woonoppervlak", value: 95, basis: null }),
    ]);
    expect(accepted.map((f) => [f.key, f.value, f.basis, f.turnIndex])).toEqual([
      ['living_area', 92, 'NEN2580', 0],
      ['living_area', 95, 'unspecified', 2],
    ]);
    expect(accepted[1]?.repaired).toBe(true);
  });

  it('drops facts whose turn does not exist or whose quote is not in that turn', () => {
    const { accepted, rejected } = normalizeExtractedFacts(market, turns, [
      raw({ turnIndex: 7 }),
      raw({ turnIndex: 0.5 }),
      raw({ turnIndex: -1 }),
      // In the transcript, but in another turn.
      raw({ turnIndex: 1, quote: '92 vierkante meter' }),
      // A corrected repetition is not verbatim.
      raw({ turnIndex: 1, quote: 'het is in 1987 gebouwd', key: 'build_year', value: 1987 }),
    ]);
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual([
      'unknown_turn',
      'unknown_turn',
      'unknown_turn',
      'quote_mismatch',
      'quote_mismatch',
    ]);
  });

  it('takes units from the profile and drops a fact whose unit names another quantity', () => {
    const { accepted, rejected } = normalizeExtractedFacts(market, turns, [
      raw({ unit: null }),
      raw({ unit: 'm3' }),
      raw({ key: 'other', otherKey: 'room_area', unit: 'sq_ft' }),
      raw({ key: 'vve_monthly_contribution', unit: null, basis: null, value: 165 }),
    ]);
    expect(accepted.map((f) => [f.key, f.unit, f.repaired])).toEqual([
      ['living_area', 'm2', true],
      ['vve_monthly_contribution', 'EUR', true],
    ]);
    expect(rejected.map((r) => r.reason)).toEqual(['unit_mismatch', 'unit_mismatch']);
  });

  it('limits bases to the profile plus unspecified, and only for areas', () => {
    const { accepted } = normalizeExtractedFacts(market, turns, [
      raw({ basis: 'gross' }),
      raw({ basis: 'cadastral', value: 93 }),
      raw({ key: 'other', otherKey: 'gross_area', basis: null, value: 104 }),
      raw({ key: 'energy_label', value: 'B', unit: null, basis: 'NEN2580', quote: 'NEN 2580' }),
    ]);
    expect(accepted.map((f) => [f.key, f.value, f.basis, f.repaired])).toEqual([
      ['living_area', 92, 'unspecified', true],
      // A listed basis is kept even when it differs from the profile's: reconciliation compares.
      ['living_area', 93, 'cadastral', false],
      ['other:gross_area', 104, 'unspecified', true],
      ['energy_label', 'B', null, true],
    ]);
  });

  it('rejects invalid keys and values, and keeps opinions marked', () => {
    const { accepted, rejected } = normalizeExtractedFacts(market, turns, [
      raw({ key: 'other', otherKey: null }),
      raw({ value: 'about ninety' }),
      raw({ key: 'other', otherKey: 'note', value: '   ', unit: null, basis: null }),
      raw({
        turnIndex: 2,
        quote: 'de mooiste straat van de wijk',
        key: 'other',
        otherKey: 'street_quality',
        value: 'most beautiful street in the area',
        unit: null,
        basis: null,
        assertion: 'opinion',
      }),
      raw({ assertion: 'certain' }),
    ]);
    expect(rejected.map((r) => [r.reason, r.key])).toEqual([
      ['invalid_key', 'other:'],
      ['invalid_value', 'living_area'],
      ['invalid_value', 'other:note'],
    ]);
    // An unknown assertion is treated as an opinion (the safe direction).
    expect(accepted.map((f) => [f.key, f.assertion, f.repaired])).toEqual([
      ['other:street_quality', 'opinion', false],
      ['living_area', 'opinion', true],
    ]);
  });

  it('drops exact repeats but keeps the same value from another turn', () => {
    const { accepted, rejected } = normalizeExtractedFacts(market, turns, [
      raw({}),
      raw({ quote: 'De woonoppervlakte is  92 vierkante meter' }),
      raw({ turnIndex: 2, quote: '95 vierkante meter', value: 92, basis: 'NEN2580' }),
    ]);
    expect(accepted.map((f) => f.turnIndex)).toEqual([0, 2]);
    expect(rejected.map((r) => r.reason)).toEqual(['duplicate']);
  });

  it('clips model text stored in the report', () => {
    const { rejected } = normalizeExtractedFacts(market, turns, [
      raw({ quote: 'x'.repeat(1000), key: 'k'.repeat(1000) }),
    ]);
    expect(rejected[0]?.quote).toHaveLength(300);
    expect(rejected[0]?.key).toHaveLength(300);
  });
});

describe('stored provenance', () => {
  const artifactId = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';

  it('maps a transcript candidate to a transcript_turn source with the verified quote', () => {
    const [fact] = normalizeExtractedFacts(market, turns, [raw({})]).accepted;
    const stored = toTranscriptFact('fact_extraction', artifactId, fact ?? never());
    expect(stored).toEqual({
      stepId: 'fact_extraction',
      key: 'living_area',
      value: 92,
      unit: 'm2',
      basis: 'NEN2580',
      assertion: 'stated',
      source: {
        kind: 'transcript_turn',
        transcriptArtifactId: artifactId,
        turnIndex: 0,
        startMs: 0,
        endMs: 9_000,
        quote: '92 vierkante meter',
      },
    });
    expect(factSourceSchema.parse(stored.source)).toEqual(stored.source);
  });

  it('maps a form candidate to a form source citing the field', () => {
    const stored = toFormFact('fact_extraction', {
      key: 'living_area',
      value: 92,
      unit: 'm2',
      basis: 'NEN2580',
      field: 'living_area',
    });
    expect(stored.source).toEqual({ kind: 'form', field: 'living_area' });
    expect(stored.assertion).toBe('stated');
    expect(factSourceSchema.parse(stored.source)).toEqual(stored.source);
  });
});

describe('classifyExtractionError', () => {
  const truncated = (finishReason: 'length' | 'stop') =>
    new NoObjectGeneratedError({
      message: 'No object generated',
      text: '{"facts": [',
      response: { id: 'resp_1', timestamp: new Date(0), modelId: 'muse-spark-1.3' },
      usage: {
        inputTokens: 1,
        inputTokenDetails: {
          noCacheTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        outputTokens: 1,
        outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
        totalTokens: 2,
      },
      finishReason,
    });

  it('fails the run without a retry when the answer was cut off at the token cap', () => {
    const classified = classifyExtractionError(truncated('length'), 14_000);
    expect(classified).toBeInstanceOf(NonRetryableStepError);
    expect(String(classified)).toMatch(/max_output_tokens \(14000\)/);
  });

  it('passes other errors through', () => {
    const other = truncated('stop');
    expect(classifyExtractionError(other, 14_000)).toBe(other);
  });
});

function never(): never {
  throw new Error('unexpected undefined');
}
