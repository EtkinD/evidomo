import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CopyCatalogFact, CopyFactCatalog } from './catalog.ts';
import { checkCopyOutput, CopyOutputError } from './check.ts';
import type { CopyDraft, ModelSegment } from './schema.ts';

const LIVING = [randomUUID(), randomUUID()];
const LABEL = [randomUUID()];
const BALCONY = [randomUUID()];

function entry(
  id: string,
  key: string,
  value: number | string,
  factIds: string[],
): CopyCatalogFact {
  return {
    id,
    key,
    label: null,
    value,
    unit: null,
    basis: null,
    presence: false,
    seenIn: [],
    factIds,
  };
}
const facts = [
  entry('VF01', 'energy_label', 'B', LABEL),
  entry('VF02', 'living_area', 92, LIVING),
  entry('VF03', 'other:balcony_area', 7, BALCONY),
];
const CATALOG: CopyFactCatalog = { facts, byId: new Map(facts.map((f) => [f.id, f])) };

const seg = (text: string, ...factIds: string[]): ModelSegment => ({ text, factIds });
function draft(portal: ModelSegment[][], social: ModelSegment[]): CopyDraft {
  return {
    portal: { paragraphs: portal.map((segments) => ({ segments })) },
    social: { segments: social },
  };
}
const SOCIAL = [
  seg('A home of 92 m² with energy label B and a balcony of 7 m².', 'VF02', 'VF01', 'VF03'),
];

describe('copy output check', () => {
  it('maps catalog IDs to stored facts and numbers segments across variants', () => {
    const checked = checkCopyOutput(
      draft(
        [
          [seg('This home offers 92 m² of living space.', 'VF02')],
          [seg('It has energy label B.', 'VF01', 'VF01'), seg('The balcony is 7 m².', 'VF03')],
        ],
        SOCIAL,
      ),
      CATALOG,
      'en',
    );
    const [portal, social] = checked.variants;
    expect(portal?.segments.map((s) => [s.index, s.paragraph, s.catalogIds, s.factIds])).toEqual([
      [0, 0, ['VF02'], LIVING],
      [1, 1, ['VF01'], LABEL],
      [2, 1, ['VF03'], BALCONY],
    ]);
    expect(social?.segments[0]).toMatchObject({
      index: 3,
      paragraph: 0,
      factIds: [...LIVING, ...LABEL, ...BALCONY],
    });
    expect(checked.citedCatalogIds).toEqual(['VF02', 'VF01', 'VF03']);
    expect(checked.repairs).toEqual({
      mergedUncited: 0,
      droppedUncitedParagraphs: 0,
      droppedEmpty: 0,
    });
  });

  it('joins uncited text to the next cited segment, or to the previous one at the end', () => {
    const checked = checkCopyOutput(
      draft(
        [
          [
            seg('Welcome home.'),
            seg('This apartment offers 92 m² of living space,', 'VF02'),
            seg('and the energy label is B.', 'VF01'),
            seg('Take a look.'),
          ],
        ],
        SOCIAL,
      ),
      CATALOG,
      'en',
    );
    expect(checked.variants[0]?.segments.map((s) => [s.text, s.catalogIds])).toEqual([
      ['Welcome home. This apartment offers 92 m² of living space,', ['VF02']],
      ['and the energy label is B. Take a look.', ['VF01']],
    ]);
    expect(checked.repairs.mergedUncited).toBe(2);
  });

  it('drops paragraphs that cite nothing and empty segments, and normalizes whitespace', () => {
    const checked = checkCopyOutput(
      draft(
        [
          [seg('Contact us for a viewing today and see it for yourself.')],
          [
            seg('  The home offers\n92 m² of living space with the label B. ', 'VF02', 'VF01'),
            seg('  '),
          ],
        ],
        SOCIAL,
      ),
      CATALOG,
      'en',
    );
    expect(checked.variants[0]?.segments).toEqual([
      expect.objectContaining({
        paragraph: 0,
        text: 'The home offers 92 m² of living space with the label B.',
      }),
    ]);
    expect(checked.repairs).toEqual({
      mergedUncited: 0,
      droppedUncitedParagraphs: 1,
      droppedEmpty: 1,
    });
  });

  it('rejects unknown fact IDs, naming only their number', () => {
    const run = () =>
      checkCopyOutput(
        draft([[seg('A home of 92 m².', 'VF02', 'VF99', 'F.x')]], SOCIAL),
        CATALOG,
        'en',
      );
    expect(run).toThrow(CopyOutputError);
    expect(run).toThrow('The copy cites 2 unknown fact IDs');
  });

  it('rejects a variant without any cited segment', () => {
    expect(() => checkCopyOutput(draft([[seg('Lovely.')]], SOCIAL), CATALOG, 'en')).toThrowError(
      expect.objectContaining({ problem: 'empty_variant' }),
    );
    expect(() =>
      checkCopyOutput(draft([[seg('The home has 92 m².', 'VF02')]], []), CATALOG, 'en'),
    ).toThrow('The social copy has no cited segment');
  });

  it('rejects copy written in another language than the output language', () => {
    const dutch = draft(
      [
        [
          seg(
            'Dit appartement heeft een woonoppervlakte van 92 m² en het energielabel is B.',
            'VF02',
            'VF01',
          ),
        ],
      ],
      [
        seg(
          'Een woning van 92 m² met een balkon van 7 m² en ook energielabel B.',
          'VF02',
          'VF03',
          'VF01',
        ),
      ],
    );
    expect(() => checkCopyOutput(dutch, CATALOG, 'en')).toThrowError(
      expect.objectContaining({ problem: 'wrong_language' }),
    );
    const checked = checkCopyOutput(dutch, CATALOG, 'nl');
    expect(checked.variants.map((v) => v.languageCheck)).toEqual(['match', 'match']);
  });
});
