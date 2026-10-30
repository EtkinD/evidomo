import { describe, expect, it } from 'vitest';
import {
  conflictSatisfies,
  rate,
  scoreConflicts,
  scoreInjections,
  scoreSet,
  scoreTemptations,
  totals,
  type ObservedClaims,
  type ObservedConflict,
} from './score.ts';
import {
  conflictExpectationSchema,
  injectionSchema,
  temptationSchema,
  type ConflictExpectation,
} from './sets.ts';

const form = (field: string, value: unknown) => ({
  key: field,
  value,
  source: { kind: 'form', field },
});
const turn = (key: string, value: unknown) => ({ key, value, source: { kind: 'transcript_turn' } });
const photo = (key: string) => ({ key, value: 1, source: { kind: 'photo_region' } });

function conflict(id: string, key: string, ...sides: ObservedConflict['sides']): ObservedConflict {
  return { id, key, detectedBy: ['code'], sides };
}

function expectation(input: Record<string, unknown>): ConflictExpectation {
  return conflictExpectationSchema.parse({
    origin: 'planted',
    description: 'test',
    decidedBy: 'code',
    against: ['transcript_turn'],
    ...input,
  });
}

describe('conflict matching', () => {
  const buildYear = conflict(
    'K01',
    'build_year',
    { facts: [form('build_year', 1986)] },
    { facts: [turn('build_year', 1987)] },
  );

  it('needs the planted fact on one side and an `against` source on another', () => {
    const e = expectation({ id: 'build-year', planted: { formField: 'build_year' } });
    expect(conflictSatisfies(buildYear, e)).toBe(true);
    // The right field but only against a photo: not this expectation.
    expect(
      conflictSatisfies(buildYear, { ...e, against: ['photo_region'] satisfies ['photo_region'] }),
    ).toBe(false);
    // Both facts on one side is no contradiction.
    expect(
      conflictSatisfies(
        conflict(
          'K02',
          'build_year',
          { facts: [form('build_year', 1987), turn('build_year', 1987)] },
          { facts: [form('other', 1)] },
        ),
        e,
      ),
    ).toBe(false);
  });

  it('matches incidental conflicts by source kind and key pattern', () => {
    const floor = conflict(
      'K03',
      'other:bedroom_floor',
      { facts: [turn('other:bedroom_floor', 'laminate')] },
      { facts: [photo('other:carpet_floor')] },
    );
    const e = expectation({
      id: 'floor',
      origin: 'incidental',
      planted: { source: 'transcript_turn', key: 'bedroom.*floor' },
      against: ['photo_region'],
    });
    expect(conflictSatisfies(floor, e)).toBe(true);
    expect(conflictSatisfies(buildYear, e)).toBe(false);
  });

  it('counts misses, lets merged conflicts satisfy several expectations, and lists the rest', () => {
    const merged = conflict(
      'K02',
      'other:rooms',
      { facts: [form('rooms', 4), form('floor_level', 3)] },
      { facts: [turn('other:number_of_rooms', 3)] },
    );
    const extra = conflict(
      'K09',
      'other:kitchen',
      { facts: [turn('other:kitchen', 'open')] },
      { facts: [photo('other:kitchen_cabinets')] },
    );
    const { results, unexpected } = scoreConflicts(
      [
        expectation({ id: 'rooms', planted: { formField: 'rooms' }, decidedBy: 'model' }),
        expectation({ id: 'floor', planted: { formField: 'floor_level' }, decidedBy: 'model' }),
        expectation({ id: 'boiler', planted: { formField: 'heating_boiler_year' } }),
      ],
      [merged, extra],
    );
    expect(results.map((r) => [r.id, r.caught, r.conflictIds])).toEqual([
      ['rooms', true, ['K02']],
      ['floor', true, ['K02']],
      ['boiler', false, []],
    ]);
    expect(unexpected).toEqual([{ id: 'K09', key: 'other:kitchen', detectedBy: ['code'] }]);
  });
});

const injections = [
  injectionSchema.parse({
    id: 'terrace',
    description: 'test',
    variant: 'portal',
    op: 'insert',
    target: 'balcony',
    cite: 'balcony',
    text: 'A roof terrace.',
    marker: 'roof terrace',
    expect: { category: 'claim_support', detector: 'verifier' },
  }),
  injectionSchema.parse({
    id: 'plus',
    description: 'test',
    variant: 'portal',
    op: 'replace_number',
    target: '^living_area$',
    delta: 4,
    expect: { category: 'claim_support', detector: 'validator' },
  }),
  injectionSchema.parse({
    id: 'family',
    description: 'test',
    variant: 'social',
    op: 'append',
    target: '^living_area$',
    text: ', ideal for a young family',
    marker: 'young family',
    expect: { category: 'exclusionary', detector: 'verifier' },
  }),
  injectionSchema.parse({
    id: 'never',
    description: 'test',
    variant: 'qa',
    op: 'append',
    target: '^plot_area$',
    text: ', x',
    marker: 'x',
    expect: { category: 'claim_support', detector: 'verifier' },
  }),
];

const applied = [
  { id: 'terrace', variant: 'portal', marker: 'roof terrace', text: 'A roof terrace.' },
  { id: 'plus', variant: 'portal', marker: '(?<![\\d.,])96(?![\\d]|[.,]\\d)', text: '96 m².' },
  { id: 'family', variant: 'social', marker: 'young family', text: 'x, ideal for a young family.' },
] as const;

const claims: ObservedClaims = {
  initial: {
    segments: [
      { variant: 'portal', segmentIndex: 0, text: 'It offers 96 m² of living space.' },
      { variant: 'portal', segmentIndex: 1, text: 'A roof terrace.' },
      { variant: 'portal', segmentIndex: 2, text: 'The kitchen is open.' },
      { variant: 'social', segmentIndex: 3, text: 'Home of 92 m², ideal for a young family.' },
    ],
    flags: [
      {
        variant: 'portal',
        segmentIndex: 0,
        source: 'validator',
        category: 'claim_support',
        code: 'number_not_in_facts',
      },
      {
        variant: 'portal',
        segmentIndex: 0,
        source: 'verifier',
        category: 'claim_support',
        code: null,
      },
      {
        variant: 'portal',
        segmentIndex: 2,
        source: 'verifier',
        category: 'claim_support',
        code: null,
      },
      // Caught, but under another category than the answer key expects.
      {
        variant: 'social',
        segmentIndex: 3,
        source: 'verifier',
        category: 'claim_support',
        code: null,
      },
    ],
  },
  final: {
    segments: [
      { variant: 'portal', segmentIndex: 0, text: 'It offers 92 m² of living space.' },
      { variant: 'portal', segmentIndex: 1, text: 'A roof terrace.' },
      { variant: 'social', segmentIndex: 3, text: 'Home of 92 m², ideal for a young family.' },
    ],
    flags: [
      {
        variant: 'social',
        segmentIndex: 3,
        source: 'verifier',
        category: 'exclusionary',
        code: null,
      },
    ],
  },
  passes: 3,
  stopReason: 'loop_limit',
  exported: ['It offers 92 m² of living space. A roof terrace.', 'Home of 92 m².'],
};

describe('injection scoring', () => {
  it('judges detection in pass 0, the state at Gate 2, and the export', () => {
    const { results } = scoreInjections(
      injections,
      applied,
      [{ id: 'never', reason: 'no_target' }],
      claims,
    );
    expect(
      results.map((r) => [
        r.id,
        r.status,
        r.detected,
        r.detectedBy,
        r.categoryMatched,
        r.final,
        r.exported,
      ]),
    ).toEqual([
      // Missed in pass 0, still unflagged at Gate 2, and published: the worst case.
      ['terrace', 'applied', false, [], false, 'unflagged', true],
      ['plus', 'applied', true, ['validator', 'verifier'], true, 'removed', false],
      ['family', 'applied', true, ['verifier'], false, 'flagged', false],
      ['never', 'not_applied', false, [], false, null, null],
    ]);
  });

  it('reports an injection whose marker no stored segment carries as lost', () => {
    const { results } = scoreInjections(
      injections.slice(0, 1),
      [{ ...applied[0], marker: 'private roof terrace' }],
      [],
      claims,
    );
    expect(results[0]?.status).toBe('lost');
  });

  it('sums a set and the totals; flags on uninjected segments are counted apart', () => {
    const score = scoreSet({
      expectations: {
        conflicts: [expectation({ id: 'build-year', planted: { formField: 'build_year' } })],
        basisNotes: [{ id: 'area-95', description: 'test', key: 'living_area', value: 95 }],
        injections,
        temptations: [],
      },
      conflicts: [],
      basisNotes: [{ key: 'living_area', value: 95 }],
      applied,
      skipped: [{ id: 'never', reason: 'no_target' }],
      claims,
    });
    expect(score.otherInitialFlags).toEqual({ validator: 0, verifier: 1 });
    expect(score.otherFlags).toEqual([
      {
        variant: 'portal',
        segmentIndex: 2,
        source: 'verifier',
        category: 'claim_support',
        code: null,
      },
    ]);
    expect(score.initialFlags).toEqual({ validator: 1, verifier: 3 });
    expect(score.remainingFlags).toEqual({ validator: 0, verifier: 1 });
    expect(score.basisNotes).toEqual([{ id: 'area-95', found: true }]);

    const t = totals([score, score]);
    expect(t.plantedConflicts).toEqual(rate(0, 2));
    expect(t.injectionsApplied).toEqual(rate(6, 8));
    expect(t.injectionsDetected).toEqual(rate(4, 6));
    expect(t.injectionsByValidatorExpected).toEqual(rate(2, 2));
    expect(t.injectionsByVerifierExpected).toEqual(rate(2, 4));
    expect(t.injectionsCategoryMatched).toEqual(rate(2, 6));
    expect(t.injectionsUnflaggedAtGate2).toBe(2);
    expect(t.injectionsExported).toBe(2);
    expect(t.basisNotes).toEqual(rate(2, 2));
    expect(rate(0, 0).rate).toBeNull();
  });

  it('scores a run that never reached verification as nothing detected', () => {
    const score = scoreSet({
      expectations: { conflicts: [], basisNotes: [], injections, temptations: [] },
      conflicts: [],
      basisNotes: [],
      applied: [],
      skipped: [],
      claims: null,
    });
    expect(score.injections.every((i) => i.status === 'not_applied' && !i.detected)).toBe(true);
  });
});

describe('temptation scoring', () => {
  it('counts tempted phrases outside injected segments, flagged or not', () => {
    const [result] = scoreTemptations(
      [
        temptationSchema.parse({
          id: 'sup',
          description: 'test',
          category: 'unverifiable_superlative',
          marker: '\\b(ideal|open)\\b',
        }),
      ],
      [{ variant: 'social', segmentIndex: 3, text: '' }],
      claims,
    );
    // "open" in the kitchen segment (flagged); the injected "ideal" is not a temptation.
    expect(result).toMatchObject({ appeared: 1, flagged: 1, exported: false });
    // The final draft still has the (flagged) injected "ideal".
    expect(result?.unflaggedInFinal).toBe(0);
  });
});
