import { describe, expect, it } from 'vitest';
import { qaCardsContentSchema, type QaCardsContent } from './qa.ts';
import { qaCardsGeneratedPayloadSchema } from './run-events.ts';

const FACT = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';
const PREVIOUS = '9a0e8a2c-5a8e-4d43-9f0e-1c1a6f6f2f10';
const segment = (index: number, catalogId = 'VF01') => ({
  index,
  text: 'The living area is 92 m².',
  catalogIds: [catalogId],
  factIds: [FACT],
});
const content: QaCardsContent = {
  schemaVersion: 1,
  promptVersion: 1,
  modelRun: {
    model: 'muse-spark-1.3',
    reasoningEffort: 'low',
    maxOutputTokens: 8000,
    fallbackFrom: null,
  },
  outputLanguage: 'en',
  tone: null,
  revision: 0,
  previousArtifactId: null,
  catalog: [{ id: 'VF01', factIds: [FACT] }],
  languageCheck: 'match',
  cards: [
    { card: 0, question: 'How large is the living area?', segments: [segment(0)] },
    { card: 1, question: 'What is the energy label?', segments: [segment(1), segment(2)] },
  ],
  repairs: {
    mergedUncited: 0,
    droppedEmpty: 0,
    droppedCards: {
      uncited: 0,
      invalidQuestion: 0,
      numberInQuestion: 0,
      duplicateQuestion: 0,
      overLimit: 0,
    },
  },
  counts: { catalogFacts: 1, citedCatalogFacts: 1, cards: 2, segments: 3 },
  validation: {
    rulesVersion: 1,
    language: 'en',
    result: 'pass',
    counts: { segments: 3, failedSegments: 0, numbers: 3, findings: 0 },
    findings: [],
  },
};

describe('qaCardsContentSchema', () => {
  it('accepts consistent cards', () => {
    expect(qaCardsContentSchema.parse(content)).toEqual(content);
  });

  it('refuses numbering, citations, duplicates, counts, and reports that do not fit', () => {
    const bad = (patch: Partial<QaCardsContent>) =>
      qaCardsContentSchema.safeParse({ ...content, ...patch }).success;
    const [first, second] = content.cards;
    if (first === undefined || second === undefined) throw new Error('fixture');
    expect(bad({ cards: [second, first] })).toBe(false);
    expect(bad({ cards: [first, { ...second, segments: [segment(2), segment(1)] }] })).toBe(false);
    expect(bad({ cards: [first, { ...second, segments: [segment(1, 'VF02'), segment(2)] }] })).toBe(
      false,
    );
    expect(bad({ cards: [first, { ...second, question: 'HOW LARGE is the living area?' }] })).toBe(
      false,
    );
    expect(bad({ counts: { ...content.counts, cards: 3 } })).toBe(false);
    expect(
      bad({
        validation: {
          ...content.validation,
          result: 'fail',
          counts: { ...content.validation.counts, failedSegments: 1, findings: 1 },
          findings: [
            {
              variant: 'portal',
              segmentIndex: 0,
              code: 'number_not_in_facts',
              token: '95',
              factId: null,
              detail: 'x',
            },
          ],
        },
      }),
    ).toBe(false);
    expect(bad({ revision: 1 })).toBe(false);
    expect(bad({ revision: 1, previousArtifactId: PREVIOUS })).toBe(true);
    expect(bad({ cards: [] })).toBe(false);
  });

  it('keeps the event to counts', () => {
    const payload = {
      stepId: 'qa_cards',
      artifactId: PREVIOUS,
      revision: 0,
      outputLanguage: 'en',
      catalogFactCount: 9,
      citedFactCount: 7,
      cardCount: 6,
      segmentCount: 8,
      claimCount: 8,
      mergedUncitedCount: 0,
      droppedCardCount: 1,
      validatorResult: 'pass',
      validatorFailedSegmentCount: 0,
      validatorFindingCount: 0,
      model: 'muse-spark-1.3',
      fallbackUsed: false,
    };
    expect(qaCardsGeneratedPayloadSchema.parse(payload)).toEqual(payload);
    expect(qaCardsGeneratedPayloadSchema.safeParse({ ...payload, question: 'x' }).success).toBe(
      false,
    );
  });
});
