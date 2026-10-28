import {
  marketProfileSchema,
  TRANSCRIPTION_KEYWORD_LIMITS,
  type MarketProfile,
} from '@evidomo/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDefinitions } from '../../definitions/loader.ts';
import {
  buildTranscriptionKeywords,
  labelTerms,
  languageBiasFor,
  normalizeKeyword,
} from './keywords.ts';

function market(overrides: Record<string, unknown> = {}): MarketProfile {
  return marketProfileSchema.parse({
    id: 'test',
    version: 1,
    name: 'Test market',
    source_languages: ['nl'],
    output_languages: ['en'],
    default_output_language: 'en',
    units: { area: 'm2' },
    currency: 'EUR',
    area_bases: [{ id: 'NEN2580', label: 'NEN 2580' }],
    facts: [
      {
        key: 'energy_label',
        label: 'Energy label (energielabel)',
        type: 'enum',
        values: ['A', 'B'],
      },
      {
        key: 'living_area',
        label: 'Living area (woonoppervlakte)',
        type: 'area',
        basis: 'NEN2580',
      },
      { key: 'vve', label: "Owners' association (VvE) monthly contribution", type: 'money' },
      { key: 'outdoor', label: 'Outdoor space (garden, balcony, or terrace)', type: 'boolean' },
      { key: 'rooms', label: 'Rooms', type: 'integer' },
    ],
    publication_checklist: [],
    flagged_phrasing: ['exclusionary'],
    transcription_keywords: ['meterkast', 'vlizotrap'],
    ...overrides,
  });
}

describe('labelTerms', () => {
  it('takes the parenthesised local terms and splits lists', () => {
    expect(labelTerms(market())).toEqual([
      'energielabel',
      'woonoppervlakte',
      'VvE',
      'garden',
      'balcony',
      'terrace',
    ]);
  });
});

describe('buildTranscriptionKeywords', () => {
  it('orders form text values, then label terms, then profile keywords', () => {
    const keywords = buildTranscriptionKeywords({
      market: market(),
      factForm: { street_name: 'Kwartelhoflaan', place_name: 'Zandmeer' },
    });
    expect(keywords).toEqual([
      // Form keys in code-point order: place_name < street_name.
      'Zandmeer',
      'Kwartelhoflaan',
      'energielabel',
      'woonoppervlakte',
      'VvE',
      'garden',
      'balcony',
      'terrace',
      'meterkast',
      'vlizotrap',
    ]);
  });

  it('ignores typed market facts, non-strings, codes, numbers, and over-long text', () => {
    const keywords = buildTranscriptionKeywords({
      market: market({ transcription_keywords: [] }),
      factForm: {
        energy_label: 'B',
        living_area: 92,
        rooms: 3,
        outdoor: true,
        house_number: '27',
        addition: 'A',
        label_code: 'A++',
        notes: 'x'.repeat(TRANSCRIPTION_KEYWORD_LIMITS.maxKeywordLength + 1),
        nested: { street: 'Hidden' },
        list: ['Hidden'],
        nothing: null,
      },
    });
    expect(keywords).toEqual([
      'energielabel',
      'woonoppervlakte',
      'VvE',
      'garden',
      'balcony',
      'terrace',
    ]);
  });

  it('normalizes whitespace and Unicode and de-duplicates case-insensitively, first spelling wins', () => {
    const decomposed = 'Géant'; // "Géant" with a combining accent
    const keywords = buildTranscriptionKeywords({
      market: market({ transcription_keywords: ['vve', 'Géant', 'Woon   kamer'] }),
      factForm: { a_name: `  ${decomposed}  `, b_name: 'VVE', c_name: 'woon kamer' },
    });
    expect(keywords).toEqual([
      'Géant',
      'VVE',
      'woon kamer',
      'energielabel',
      'woonoppervlakte',
      'garden',
      'balcony',
      'terrace',
    ]);
    expect(keywords[0]).toBe('Géant'.normalize('NFC'));
  });

  it('caps the list at the keyword limit, keeping the highest-priority terms', () => {
    const factForm = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `field_${String(i).padStart(2, '0')}`,
        `Straatnaam${i}`,
      ]),
    );
    const keywords = buildTranscriptionKeywords({ market: market(), factForm });
    expect(keywords).toHaveLength(TRANSCRIPTION_KEYWORD_LIMITS.maxKeywords);
    expect(keywords[0]).toBe('Straatnaam0');
    expect(keywords).not.toContain('meterkast');
  });

  it('is deterministic regardless of form key order', () => {
    const a = buildTranscriptionKeywords({ market: market(), factForm: { x: 'Alpha', y: 'Beta' } });
    const b = buildTranscriptionKeywords({ market: market(), factForm: { y: 'Beta', x: 'Alpha' } });
    expect(a).toEqual(b);
  });

  it('builds the nl v1 list from its labels and room terms', async () => {
    const registry = await loadDefinitions();
    const keywords = buildTranscriptionKeywords({
      market: registry.getMarket('nl', 1),
      factForm: {},
    });
    expect(keywords.slice(0, 8)).toEqual([
      'energielabel',
      'woonoppervlakte',
      'inhoud',
      'perceeloppervlakte',
      'bouwjaar',
      'VvE',
      'erfpacht',
      'canon',
    ]);
    expect(keywords).toContain('meterkast');
    expect(keywords.length).toBeLessThanOrEqual(TRANSCRIPTION_KEYWORD_LIMITS.maxKeywords);
  });
});

describe('normalizeKeyword', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeKeyword('  NEN \t 2580\n')).toBe('NEN 2580');
  });
});

describe('languageBiasFor', () => {
  let nl: MarketProfile;
  beforeAll(async () => {
    nl = (await loadDefinitions()).getMarket('nl', 1);
  });

  it('maps ISO 639-1 source languages to the English names the API expects', () => {
    expect(languageBiasFor(nl)).toEqual(['Dutch', 'English']);
  });
});
