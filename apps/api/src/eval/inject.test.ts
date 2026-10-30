import { describe, expect, it } from 'vitest';
import type { CopyDraft } from '../pipeline/creative/schema.ts';
import type { QaDraft } from '../pipeline/qa/schema.ts';
import { injectCopyDraft, injectQaDraft, type InjectionCatalogFact } from './inject.ts';
import { injectionSchema, type Injection } from './sets.ts';

const facts: InjectionCatalogFact[] = [
  { id: 'VF01', key: 'energy_label', value: 'B' },
  { id: 'VF02', key: 'living_area', value: 92 },
  { id: 'VF03', key: 'other:balcony_area', value: 7 },
  { id: 'VF04', key: 'other:window', value: true },
];

const draft: CopyDraft = {
  portal: {
    paragraphs: [
      {
        segments: [
          { text: 'The apartment offers 92 m² of living space.', factIds: ['VF02'] },
          { text: 'It has energy label B', factIds: ['VF01'] },
        ],
      },
      { segments: [{ text: 'The 7 m² balcony faces southwest.', factIds: ['VF03'] }] },
    ],
  },
  social: { segments: [{ text: 'Apartment with 92 m² and label B.', factIds: ['VF02', 'VF01'] }] },
};

const expect_ = { category: 'claim_support', detector: 'verifier' } as const;

function injection(input: Record<string, unknown>): Injection {
  return injectionSchema.parse({ description: 'test', expect: expect_, ...input });
}

describe('injectCopyDraft', () => {
  it('appends a clause before the final punctuation, adding one when there is none', () => {
    const result = injectCopyDraft(draft, facts, [
      injection({
        id: 'a',
        op: 'append',
        variant: 'portal',
        target: '^energy_label$',
        text: ', ideal for a young family',
        marker: 'young family',
      }),
      injection({
        id: 'b',
        op: 'append',
        variant: 'social',
        target: '^living_area$',
        text: ', the best in town',
        marker: 'best in town',
      }),
    ]);
    expect(result.draft.portal.paragraphs[0]?.segments[1]?.text).toBe(
      'It has energy label B, ideal for a young family.',
    );
    expect(result.draft.social.segments[0]?.text).toBe(
      'Apartment with 92 m² and label B, the best in town.',
    );
    expect(result.applied.map((a) => [a.id, a.variant, a.marker])).toEqual([
      ['a', 'portal', 'young family'],
      ['b', 'social', 'best in town'],
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('inserts a segment after the target that cites the first matching fact', () => {
    const result = injectCopyDraft(draft, facts, [
      injection({
        id: 'windows',
        op: 'insert',
        variant: 'portal',
        target: 'balcony',
        cite: '^other:window$',
        text: 'The living room has 3 large windows.',
        marker: '3 large windows',
      }),
    ]);
    expect(result.draft.portal.paragraphs[1]?.segments).toEqual([
      { text: 'The 7 m² balcony faces southwest.', factIds: ['VF03'] },
      { text: 'The living room has 3 large windows.', factIds: ['VF04'] },
    ]);
  });

  it('changes or softens the target fact’s number and derives the marker from it', () => {
    const result = injectCopyDraft(draft, facts, [
      injection({
        id: 'plus',
        op: 'replace_number',
        variant: 'portal',
        target: '^living_area$',
        delta: 4,
      }),
      injection({
        id: 'about',
        op: 'approximate',
        variant: 'portal',
        target: 'balcony',
        prefix: 'about',
      }),
    ]);
    const [first] = result.draft.portal.paragraphs[0]?.segments ?? [];
    expect(first?.text).toBe('The apartment offers 96 m² of living space.');
    expect(result.draft.portal.paragraphs[1]?.segments[0]?.text).toBe(
      'The about 7 m² balcony faces southwest.',
    );
    const [plus, about] = result.applied;
    expect(new RegExp(plus?.marker ?? '', 'iu').test('offers 96 m²')).toBe(true);
    // The marker stands alone: 196 or 96.5 are other numbers.
    expect(new RegExp(plus?.marker ?? '', 'iu').test('offers 196 m²')).toBe(false);
    expect(new RegExp(plus?.marker ?? '', 'iu').test('offers 96.5 m²')).toBe(false);
    expect(new RegExp(about?.marker ?? '', 'iu').test('The about 7 m² balcony')).toBe(true);
    // The caption is another variant and stays as written.
    expect(result.draft.social).toEqual(draft.social);
  });

  it('skips what it cannot target and never changes the input draft', () => {
    const before = structuredClone(draft);
    const result = injectCopyDraft(draft, facts, [
      injection({
        id: 'no-target',
        op: 'append',
        variant: 'portal',
        target: '^plot_area$',
        text: ', x',
        marker: 'x',
      }),
      injection({
        id: 'no-cite',
        op: 'insert',
        variant: 'portal',
        target: 'balcony',
        cite: '^other:garage$',
        text: 'A garage.',
        marker: 'garage',
      }),
      injection({
        id: 'not-a-number',
        op: 'replace_number',
        variant: 'portal',
        target: '^energy_label$',
        delta: 1,
      }),
    ]);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'no-target', reason: 'no_target' },
      { id: 'no-cite', reason: 'no_citable_fact' },
      { id: 'not-a-number', reason: 'no_number_in_text' },
    ]);
    expect(result.draft).toEqual(before);
    expect(draft).toEqual(before);
  });

  it('is deterministic: the same draft and answer key give the same output', () => {
    const injections = [
      injection({
        id: 'plus',
        op: 'replace_number',
        variant: 'portal',
        target: '^living_area$',
        delta: 4,
      }),
    ];
    expect(JSON.stringify(injectCopyDraft(draft, facts, injections).draft)).toBe(
      JSON.stringify(injectCopyDraft(draft, facts, injections).draft),
    );
  });
});

describe('injectQaDraft', () => {
  it('changes answers only, in the first card citing the target', () => {
    const qa: QaDraft = {
      cards: [
        {
          question: 'What is the energy label?',
          answer: [{ text: 'It is B.', factIds: ['VF01'] }],
        },
        {
          question: 'How large is it?',
          answer: [{ text: 'The living area is 92 m².', factIds: ['VF02'] }],
        },
      ],
    };
    const result = injectQaDraft(qa, facts, [
      injection({
        id: 'qa-plus',
        op: 'replace_number',
        variant: 'qa',
        target: '^living_area$',
        delta: 5,
      }),
      injection({
        id: 'copy-only',
        op: 'append',
        variant: 'portal',
        target: '^living_area$',
        text: ', x',
        marker: 'x',
      }),
    ]);
    expect(result.draft.cards.map((c) => c.question)).toEqual(qa.cards.map((c) => c.question));
    expect(result.draft.cards[1]?.answer[0]?.text).toBe('The living area is 97 m².');
    expect(result.applied.map((a) => a.id)).toEqual(['qa-plus']);
  });
});
