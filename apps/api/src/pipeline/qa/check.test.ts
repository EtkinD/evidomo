import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CopyCatalogFact, CopyFactCatalog } from '../creative/catalog.ts';
import { checkQaOutput, questionProblem } from './check.ts';
import type { QaDraft } from './schema.ts';

const FACT_IDS = [randomUUID(), randomUUID(), randomUUID()];
const facts: CopyCatalogFact[] = [
  {
    id: 'VF01',
    key: 'living_area',
    label: 'Living area',
    value: 92,
    unit: 'm2',
    basis: 'NEN2580',
    presence: false,
    seenIn: [],
    factIds: [FACT_IDS[0] ?? '', FACT_IDS[1] ?? ''],
  },
  {
    id: 'VF02',
    key: 'energy_label',
    label: 'Energy label',
    value: 'B',
    unit: null,
    basis: null,
    presence: false,
    seenIn: [],
    factIds: [FACT_IDS[2] ?? ''],
  },
];
const CATALOG: CopyFactCatalog = { facts, byId: new Map(facts.map((f) => [f.id, f])) };

const card = (question: string, ...answer: { text: string; factIds: string[] }[]) => ({
  question,
  answer,
});
const area = { text: 'The living area is 92 m², measured to NEN 2580.', factIds: ['VF01'] };
const label = { text: 'The home has energy label B.', factIds: ['VF02'] };

describe('checkQaOutput', () => {
  it('numbers cards and answer segments, and maps catalog IDs to every stored fact', () => {
    const checked = checkQaOutput(
      {
        cards: [
          card('  How large is   the living area? ', area),
          card('What is the energy label?', label, { text: 'It was rated', factIds: [] }),
        ],
      },
      CATALOG,
      'en',
    );
    expect(checked.cards).toEqual([
      {
        card: 0,
        question: 'How large is the living area?',
        segments: [
          { index: 0, text: area.text, catalogIds: ['VF01'], factIds: FACT_IDS.slice(0, 2) },
        ],
      },
      {
        card: 1,
        question: 'What is the energy label?',
        // The uncited trailing segment is joined to the cited one before it.
        segments: [
          {
            index: 1,
            text: `${label.text} It was rated`,
            catalogIds: ['VF02'],
            factIds: [FACT_IDS[2]],
          },
        ],
      },
    ]);
    expect(checked.repairs.mergedUncited).toBe(1);
    expect(checked.citedCatalogIds).toEqual(['VF01', 'VF02']);
    expect(checked.languageCheck).toBe('match');
  });

  it('drops cards that cannot be published, counting each reason', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      card(`What is the energy label of the home, part ${'abcdefghi'[i] ?? ''}?`, label),
    );
    const checked = checkQaOutput(
      {
        cards: [
          card('Is there storage?', { text: 'Contact the agent for details.', factIds: [] }),
          card('How large is the living area', area),
          card('Are there 2 bedrooms?', area),
          card('Is the bedroom on the first floor?', area),
          card('How large is the living area?', area),
          card('how large is the  living area?', area),
          ...many,
        ],
      },
      CATALOG,
      'en',
    );
    expect(checked.repairs.droppedCards).toEqual({
      uncited: 1,
      invalidQuestion: 1,
      numberInQuestion: 2,
      duplicateQuestion: 1,
      overLimit: 2,
    });
    expect(checked.cards).toHaveLength(8);
    expect(checked.cards.map((c) => c.card)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(checked.cards.flatMap((c) => c.segments.map((s) => s.index))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it('refuses unknown IDs, an answer without usable cards, and another language', () => {
    const run =
      (draft: QaDraft, language = 'en') =>
      () =>
        checkQaOutput(draft, CATALOG, language);
    expect(
      run({ cards: [card('Is there a garden?', { text: 'Yes.', factIds: ['VF09'] })] }),
    ).toThrow(expect.objectContaining({ name: 'QaOutputError', problem: 'unknown_fact_id' }));
    expect(run({ cards: [card('Is there a garden', area)] })).toThrow(
      expect.objectContaining({ problem: 'no_cards' }),
    );
    expect(
      run(
        {
          cards: [
            card('Hoe groot is de woonoppervlakte van de woning?', {
              text: 'De woonoppervlakte van het appartement is 92 m² en het is licht.',
              factIds: ['VF01'],
            }),
          ],
        },
        'en',
      ),
    ).toThrow(expect.objectContaining({ problem: 'wrong_language' }));
  });
});

describe('checkQaOutput bounds', () => {
  it('treats an answer segment over 2,000 characters as a model failure, not a ZodError', () => {
    const long = { text: `The living area is 92 m². ${'x'.repeat(2000)}`, factIds: ['VF01'] };
    expect(() =>
      checkQaOutput({ cards: [card('How large is the living area?', long)] }, CATALOG, 'en'),
    ).toThrow(expect.objectContaining({ name: 'QaOutputError', problem: 'segment_too_long' }));
  });
});

describe('questionProblem', () => {
  it('requires a question mark and no number in either language', () => {
    expect(questionProblem('Is there a balcony?', 'en')).toBeNull();
    expect(questionProblem('Is er een balkon?', 'nl')).toBeNull();
    expect(questionProblem('Is er een tweede badkamer?', 'nl')).toBe('numberInQuestion');
    expect(questionProblem('Built in 1987?', 'en')).toBe('numberInQuestion');
    expect(questionProblem('Is there a balcony.', 'en')).toBe('invalidQuestion');
    expect(questionProblem(`${'x'.repeat(200)}?`, 'en')).toBe('invalidQuestion');
  });

  it('catches the quantity words the number reader does not read', () => {
    for (const question of [
      'Is it a one-bedroom apartment?',
      'Is it on a single level?',
      'Do both bedrooms face the garden?',
      'Is there a double garage?',
      'Are there twin sinks in the bathroom?',
      'Does it have triple glazing?',
      'Was it built in the sixties?',
      'Has the roof been replaced twice?',
    ]) {
      expect(questionProblem(question, 'en'), question).toBe('numberInQuestion');
    }
    for (const question of [
      'Is er één badkamer?',
      'Is er enkel glas?',
      'Hebben beide slaapkamers een raam?',
      'Is er dubbelglas?',
      'Heeft de woning driedubbele beglazing?',
      'Is de woning gebouwd in de jaren zestig?',
      'Is het dak tweemaal vernieuwd?',
    ]) {
      expect(questionProblem(question, 'nl'), question).toBe('numberInQuestion');
    }
  });

  it('refuses tag questions, which presume their statement', () => {
    expect(questionProblem('It has a garden, doesn’t it?', 'en')).toBe('invalidQuestion');
    expect(questionProblem('The roof is new, right?', 'en')).toBe('invalidQuestion');
    expect(questionProblem('Het heeft een tuin, toch?', 'nl')).toBe('invalidQuestion');
    expect(questionProblem('Er is een balkon, of niet?', 'nl')).toBe('invalidQuestion');
  });

  it('leaves what the word lists do not cover to the verifier', () => {
    // Not numbers in this sense: energy classes, vague quantities, words that merely contain a
    // listed word, and the Dutch article "een".
    for (const question of [
      'Is the energy label A+++?',
      'Are there several storage rooms?',
      'Is anyone allowed to use the garden?',
      'Is the bathroom on the ground floor?',
    ]) {
      expect(questionProblem(question, 'en'), question).toBeNull();
    }
    expect(questionProblem('Is er een balkon?', 'nl')).toBeNull();
    expect(questionProblem('Hoe groot is het woonoppervlak?', 'nl')).toBeNull();
  });
});
