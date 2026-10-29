import { randomUUID } from 'node:crypto';
import {
  listingCopyContentSchema,
  qaCardsContentSchema,
  type ListingCopyContent,
  type MarketProfile,
  type QaCardsContent,
} from '@evidomo/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadDefinitions } from '../../definitions/loader.ts';
import type { CopyCatalogFact, CopyFactCatalog } from '../creative/catalog.ts';
import {
  auditDraft,
  auditSegmentId,
  buildVerificationInput,
  checkVerifierFlags,
  draftSegments,
  qaSegments,
  segmentKey,
  toQaRevisionFlags,
  toRevisionFlags,
  validatorFlags,
  type DraftFlag,
  type VerdictMemory,
  type VerifierAnswer,
} from './audit.ts';
import { buildVerificationRubric } from './rubric.ts';
import { VERIFICATION_STEP_SYSTEM_PROMPT, verificationSystemPrompt } from './step-prompt.ts';

// Building the verifier input, checking its flags in code, and turning validator and verifier
// flags into revision flags, on a small synthetic draft (no model, no database).

const FACT = {
  area: randomUUID(),
  label: randomUUID(),
  storage: randomUUID(),
  unused: randomUUID(),
};

function catalogFact(
  id: string,
  key: string,
  value: CopyCatalogFact['value'],
  factId: string,
  unit: string | null = null,
): CopyCatalogFact {
  return {
    id,
    key,
    label: null,
    value,
    unit,
    basis: null,
    presence: false,
    seenIn: [],
    factIds: [factId],
  };
}

const facts = [
  catalogFact('VF01', 'energy_label', 'B', FACT.label),
  catalogFact('VF02', 'living_area', 92, FACT.area, 'm2'),
  catalogFact('VF03', 'other:external_storage_area', 6, FACT.storage, 'm2'),
  catalogFact('VF04', 'other:unused', 'never cited', FACT.unused),
];
const catalog: CopyFactCatalog = { facts, byId: new Map(facts.map((fact) => [fact.id, fact])) };

function segment(index: number, paragraph: number, text: string, catalogIds: string[]) {
  return {
    index,
    paragraph,
    text,
    catalogIds,
    factIds: catalogIds.map((id) => catalog.byId.get(id)?.factIds[0] ?? ''),
  };
}

/** Portal: two paragraphs (3 segments); social: 2 segments (global indexes 3 and 4). */
function draft(overrides: { findings?: ListingCopyContent['validation']['findings'] } = {}) {
  const findings = overrides.findings ?? [];
  return listingCopyContentSchema.parse({
    schemaVersion: 1,
    promptVersion: 1,
    modelRun: {
      model: 'muse-spark-1.3',
      reasoningEffort: 'medium',
      maxOutputTokens: 16000,
      fallbackFrom: null,
    },
    outputLanguage: 'en',
    tone: null,
    revision: 0,
    previousArtifactId: null,
    catalog: facts.map((fact) => ({ id: fact.id, factIds: [...fact.factIds] })),
    variants: [
      {
        kind: 'portal',
        languageCheck: 'match',
        segments: [
          segment(0, 0, 'This apartment offers 92 m² of living space.', ['VF02']),
          segment(1, 0, 'It has energy label B.', ['VF01']),
          segment(2, 1, 'A 6 m² external storage is included.', ['VF03']),
        ],
      },
      {
        kind: 'social',
        languageCheck: 'match',
        segments: [
          segment(3, 0, 'Energy label B and 92 m² of living space.', ['VF01', 'VF02']),
          segment(4, 0, 'With a 6 m² storage.', ['VF03']),
        ],
      },
    ],
    repairs: { mergedUncited: 0, droppedUncitedParagraphs: 0, droppedEmpty: 0 },
    counts: { catalogFacts: 4, citedCatalogFacts: 3, segments: 5 },
    validation: {
      rulesVersion: 1,
      language: 'en',
      result: findings.length === 0 ? 'pass' : 'fail',
      counts: {
        segments: 5,
        failedSegments: new Set(findings.map((f) => f.segmentIndex)).size,
        numbers: 5,
        findings: findings.length,
      },
      findings,
    },
  } satisfies ListingCopyContent);
}

let market: MarketProfile;
beforeAll(async () => {
  market = (await loadDefinitions()).getMarket('nl', 1);
});

describe('verification input', () => {
  it('addresses segments by variant position, sends only cited facts, and marks every new segment for audit', () => {
    const content = draft();
    const request = buildVerificationInput({
      content,
      catalog,
      market,
      rubric: buildVerificationRubric(market),
      memory: new Map(),
    });
    expect(request.auditIds).toEqual(['P01', 'P02', 'P03', 'S01', 'S02']);
    expect(
      request.input.copy.map((v) => [v.variant, v.segments.map((s) => [s.id, s.paragraph])]),
    ).toEqual([
      [
        'portal',
        [
          ['P01', 0],
          ['P02', 0],
          ['P03', 1],
        ],
      ],
      [
        'social',
        [
          ['S01', 0],
          ['S02', 0],
        ],
      ],
    ]);
    expect(request.input.facts.map((fact) => fact.id)).toEqual(['VF01', 'VF02', 'VF03']);
    expect(request.input.language).toEqual({ code: 'en', name: 'English' });
    expect(request.categories).toEqual([
      'claim_support',
      'unverifiable_superlative',
      'investment_promise',
      'exclusionary',
      'area_basis',
    ]);
    expect(request.segmentsById.get('S02')).toMatchObject({
      variant: 'social',
      segment: 1,
      segmentIndex: 4,
    });
    expect(auditSegmentId('qa', 11)).toBe('Q12');
  });

  it('sends a remembered (unchanged) segment as context only, with its earlier flags carried', () => {
    const content = draft();
    const [first] = draftSegments(content);
    if (first === undefined) throw new Error('no segment');
    const memory: VerdictMemory = new Map([[segmentKey(first), []]]);
    const request = buildVerificationInput({
      content,
      catalog,
      market,
      rubric: buildVerificationRubric(market),
      memory,
    });
    expect(request.auditIds).toEqual(['P02', 'P03', 'S01', 'S02']);
    expect(request.input.copy[0]?.segments[0]).toMatchObject({ id: 'P01', audit: false });
    expect([...request.carried.keys()]).toEqual(['P01']);
    // Citations are part of the identity: the same text citing other facts is audited again.
    expect(segmentKey({ ...first, catalogIds: ['VF01'] })).not.toBe(segmentKey(first));
    expect(segmentKey({ ...first, catalogIds: [...first.catalogIds].reverse() })).toBe(
      segmentKey(first),
    );
  });
});

describe('verifier flag check', () => {
  const request = () =>
    buildVerificationInput({
      content: draft(),
      catalog,
      market,
      rubric: buildVerificationRubric(market).filter((rule) => rule.category !== 'area_basis'),
      memory: new Map([
        [
          segmentKey(
            draftSegments(draft())[1] ?? {
              variant: 'portal',
              text: '',
              catalogIds: [],
              question: null,
            },
          ),
          [],
        ],
      ]),
    });

  it('keeps valid flags in segment order and drops unknown, context, off-rubric, empty, and duplicate ones', () => {
    const flag = (
      segment: string,
      category: string,
      problem = 'A problem.',
      suggestion: string | null = null,
    ) => ({
      segment,
      category,
      problem,
      suggestion,
    });
    const { flags, dropped } = checkVerifierFlags(
      {
        flags: [
          flag('S02', 'claim_support', '  "storage" is   fine but\nnot cited. ', '  '),
          flag('P03', 'claim_support', '"included" is not a fact.', 'A 6 m² external storage.'),
          flag('P99', 'claim_support'),
          flag('P02', 'unverifiable_superlative'),
          flag('P01', 'area_basis'),
          flag('P01', 'made_up'),
          flag('P01', 'exclusionary', '   '),
          flag('P03', 'claim_support', '"included" is not a fact.', 'Another rewrite.'),
          flag('P01', 'investment_promise', 'x'.repeat(600)),
        ],
      },
      request(),
    );
    expect(
      flags.map((f) => [f.segment.segmentIndex, f.category, f.problem.length, f.suggestion]),
    ).toEqual([
      [0, 'investment_promise', 500, null],
      [2, 'claim_support', 25, 'A 6 m² external storage.'],
      [4, 'claim_support', 32, null],
    ]);
    expect(flags[2]?.problem).toBe('"storage" is fine but not cited.');
    expect(flags[0]?.problem.endsWith('…')).toBe(true);
    expect(dropped).toEqual({
      unknownSegment: 1,
      notAudited: 1,
      unknownCategory: 2,
      emptyProblem: 1,
      duplicate: 1,
    });
  });
});

describe('validator flags', () => {
  it('turns findings into hard claim_support flags addressed by position within the variant', () => {
    const content = draft({
      findings: [
        {
          variant: 'social',
          segmentIndex: 4,
          code: 'number_not_in_facts',
          token: '7 m²',
          factId: null,
          detail: 'The number "7 m²" matches no cited fact.',
        },
      ],
    });
    expect(validatorFlags(content)).toEqual([
      {
        source: 'validator',
        category: 'claim_support',
        code: 'number_not_in_facts',
        variant: 'social',
        segment: 1,
        segmentIndex: 4,
        problem: 'The number "7 m²" matches no cited fact.',
        suggestion: null,
        carried: false,
      },
    ]);
  });
});

describe('revision flags', () => {
  const flag = (overrides: Partial<DraftFlag>): DraftFlag => ({
    source: 'verifier',
    category: 'claim_support',
    code: null,
    variant: 'portal',
    segment: 2,
    segmentIndex: 2,
    problem: '"included" is not a fact.',
    suggestion: null,
    carried: false,
    ...overrides,
  });

  it('appends the suggestion, keeps validator details as they are, and drops repeats', () => {
    const revision = toRevisionFlags([
      flag({
        source: 'validator',
        code: 'number_not_in_facts',
        problem: 'The number "7" matches no cited fact.',
      }),
      flag({ suggestion: 'A 6 m² external storage.' }),
      flag({ suggestion: 'A 6 m² external storage.' }),
      flag({ variant: 'social', segment: 0, segmentIndex: 3, suggestion: 'x'.repeat(600) }),
      flag({ variant: 'qa', segment: 0, segmentIndex: 0 }),
    ]);
    expect(revision.slice(0, 2)).toEqual([
      { variant: 'portal', segment: 2, problem: 'The number "7" matches no cited fact.' },
      {
        variant: 'portal',
        segment: 2,
        problem: '"included" is not a fact. Suggested rewrite: A 6 m² external storage.',
      },
    ]);
    const capped = revision[2];
    expect([capped?.variant, capped?.segment, capped?.problem.length]).toEqual(['social', 0, 500]);
    expect(capped?.problem).toMatch(/^"included" is not a fact\. Suggested rewrite: x+…$/);
    expect(revision).toHaveLength(3);
  });
});

describe('auditDraft', () => {
  const answer = (flags: VerifierAnswer['output']['flags']): VerifierAnswer => ({
    output: { flags },
    modelRun: {
      model: 'muse-wonder-1.0',
      reasoningEffort: 'low',
      maxOutputTokens: 12000,
      fallbackFrom: null,
    },
  });

  it('combines validator and verifier flags, remembers verdicts, and carries them to an unchanged draft without a call', async () => {
    const content = draft({
      findings: [
        {
          variant: 'portal',
          segmentIndex: 0,
          code: 'approximate_number',
          token: 'about 92 m²',
          factId: null,
          detail: 'Approximate.',
        },
      ],
    });
    const memory: VerdictMemory = new Map();
    const rubric = buildVerificationRubric(market);
    const verify = vi.fn(() =>
      Promise.resolve(
        answer([
          {
            segment: 'P03',
            category: 'claim_support',
            problem: '"included" is not a fact.',
            suggestion: null,
          },
        ]),
      ),
    );
    const first = await auditDraft({ content, catalog, market, rubric, memory, verify });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      segments: 5,
      auditedSegments: 5,
      carriedSegments: 0,
      modelRun: { model: 'muse-wonder-1.0' },
    });
    expect(first.flags.map((f) => [f.source, f.segmentIndex, f.carried])).toEqual([
      ['validator', 0, false],
      ['verifier', 2, false],
    ]);
    expect(memory.size).toBe(5);

    // The same draft again: every verdict is remembered, so no call; the verifier flag is
    // carried, the validator flag recomputed from the draft.
    const second = await auditDraft({ content, catalog, market, rubric, memory, verify });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ auditedSegments: 0, carriedSegments: 5, modelRun: null });
    expect(second.flags.map((f) => [f.source, f.segmentIndex, f.carried])).toEqual([
      ['validator', 0, false],
      ['verifier', 2, true],
    ]);
    expect(second.verifierFlagsByIndex.get(2)).toHaveLength(1);
    expect([...second.carriedIndexes].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('sends only the changed segment of a revision to the verifier', async () => {
    const memory: VerdictMemory = new Map();
    const rubric = buildVerificationRubric(market);
    await auditDraft({
      content: draft(),
      catalog,
      market,
      rubric,
      memory,
      verify: () => Promise.resolve(answer([])),
    });
    const revised = listingCopyContentSchema.parse({
      ...draft(),
      revision: 1,
      previousArtifactId: randomUUID(),
      variants: draft().variants.map((variant) => ({
        ...variant,
        segments: variant.segments.map((s) =>
          s.index === 2 ? { ...s, text: 'There is a 6 m² external storage.' } : s,
        ),
      })),
    });
    const verify = vi.fn((request: { auditIds: readonly string[] }) => {
      expect(request.auditIds).toEqual(['P03']);
      return Promise.resolve(answer([]));
    });
    const audit = await auditDraft({ content: revised, catalog, market, rubric, memory, verify });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(audit).toMatchObject({ auditedSegments: 1, carriedSegments: 4, flags: [] });
  });
});

function qaSegment(index: number, text: string, catalogIds: string[]) {
  const { paragraph: _paragraph, ...rest } = segment(index, 0, text, catalogIds);
  return rest;
}

/** Two Q&A cards: card 0 with one answer segment, card 1 with two (indexes 0..2). */
function qaCards(
  findings: QaCardsContent['validation']['findings'] = [],
  question = 'How large is the storage?',
): QaCardsContent {
  return qaCardsContentSchema.parse({
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
    catalog: facts.map((fact) => ({ id: fact.id, factIds: [...fact.factIds] })),
    languageCheck: 'match',
    cards: [
      {
        card: 0,
        question: 'What is the energy label?',
        segments: [qaSegment(0, 'The energy label is B.', ['VF01'])],
      },
      {
        card: 1,
        question,
        segments: [
          qaSegment(1, 'The external storage is 6 m².', ['VF03']),
          qaSegment(2, 'The living area is 92 m².', ['VF02']),
        ],
      },
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
    counts: { catalogFacts: 4, citedCatalogFacts: 3, cards: 2, segments: 3 },
    validation: {
      rulesVersion: 1,
      language: 'en',
      result: findings.length === 0 ? 'pass' : 'fail',
      counts: {
        segments: 3,
        failedSegments: new Set(findings.map((f) => f.segmentIndex)).size,
        numbers: 2,
        findings: findings.length,
      },
      findings,
    },
  } satisfies QaCardsContent);
}

describe('Q&A cards in the audit (P3-03)', () => {
  const answer = (flags: VerifierAnswer['output']['flags']): VerifierAnswer => ({
    output: { flags },
    modelRun: {
      model: 'muse-wonder-1.0',
      reasoningEffort: 'low',
      maxOutputTokens: 12000,
      fallbackFrom: null,
    },
  });

  it('adds the answers as a "qa" text with their questions, and keeps the copy-only input unchanged', () => {
    const rubric = buildVerificationRubric(market);
    const copyOnly = buildVerificationInput({
      content: draft(),
      catalog,
      market,
      rubric,
      memory: new Map(),
    });
    const withQa = buildVerificationInput({
      content: draft(),
      qa: qaCards(),
      catalog,
      market,
      rubric,
      memory: new Map(),
    });
    expect(withQa.auditIds).toEqual(['P01', 'P02', 'P03', 'S01', 'S02', 'Q01', 'Q02', 'Q03']);
    expect(withQa.input.copy.slice(0, 2)).toEqual(copyOnly.input.copy);
    expect(withQa.input.copy[2]).toMatchObject({
      variant: 'qa',
      questions: ['What is the energy label?', 'How large is the storage?'],
      segments: [
        { id: 'Q01', paragraph: 0 },
        { id: 'Q02', paragraph: 1 },
        { id: 'Q03', paragraph: 1 },
      ],
    });
    // Copy variants carry no `questions` key, so the copy-only request is byte-identical to P3-06.
    expect(JSON.stringify(copyOnly.input.copy)).not.toContain('questions');
    expect(withQa.segmentsById.get('Q02')).toMatchObject({
      variant: 'qa',
      segment: 1,
      segmentIndex: 1,
      question: 'How large is the storage?',
    });
  });

  it('keys copy and Q&A verdicts apart although both artifacts start at index 0', async () => {
    const rubric = buildVerificationRubric(market);
    const memory: VerdictMemory = new Map();
    const finding = {
      variant: 'qa',
      segmentIndex: 1,
      code: 'number_not_in_facts' as const,
      token: '6 m²',
      factId: null,
      detail: '"6 m²" is not stated by any cited fact.',
    };
    const audit = await auditDraft({
      content: draft(),
      qa: qaCards([finding]),
      catalog,
      market,
      rubric,
      memory,
      verify: () =>
        Promise.resolve(
          answer([
            {
              segment: 'P01',
              category: 'claim_support',
              problem: 'Copy problem.',
              suggestion: null,
            },
            {
              segment: 'Q01',
              category: 'exclusionary',
              problem: 'Question problem.',
              suggestion: 'Fix.',
            },
          ]),
        ),
    });
    expect(audit.flags.map((f) => [f.source, f.variant, f.segment, f.segmentIndex])).toEqual([
      ['validator', 'qa', 1, 1],
      ['verifier', 'portal', 0, 0],
      ['verifier', 'qa', 0, 0],
    ]);
    expect(audit.verifierFlagsByIndex.get(0)).toEqual([
      { category: 'claim_support', problem: 'Copy problem.', suggestion: null },
    ]);
    expect(audit.qaVerifierFlagsByIndex.get(0)).toEqual([
      { category: 'exclusionary', problem: 'Question problem.', suggestion: 'Fix.' },
    ]);
    expect(toRevisionFlags(audit.flags)).toEqual([
      { variant: 'portal', segment: 0, problem: 'Copy problem.' },
    ]);
    expect(toQaRevisionFlags(audit.flags, qaCards([finding]))).toEqual([
      { card: 1, segment: 0, problem: '"6 m²" is not stated by any cited fact.' },
      { card: 0, segment: 0, problem: 'Question problem. Suggested rewrite: Fix.' },
    ]);

    // A changed question is a changed segment: only its card's answers are audited again.
    const changed = qaCards([], 'Is there storage?');
    const verify = vi.fn((request: { auditIds: readonly string[] }) => {
      expect(request.auditIds).toEqual(['Q02', 'Q03']);
      return Promise.resolve(answer([]));
    });
    const next = await auditDraft({
      content: draft(),
      qa: changed,
      catalog,
      market,
      rubric,
      memory,
      verify,
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect([...next.qaCarriedIndexes]).toEqual([0]);
    expect([...next.carriedIndexes].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(qaSegments(changed).map((s) => s.paragraph)).toEqual([0, 1, 1]);
  });

  it('sends the P3-06 system prompt without Q&A cards and the Q&A wording with them', () => {
    expect(verificationSystemPrompt(false)).toBe(VERIFICATION_STEP_SYSTEM_PROMPT);
    const withQa = verificationSystemPrompt(true);
    expect(withQa).toContain('"questions", the buyer questions by card');
    expect(withQa).toContain('on the first segment of its card');
    expect(withQa).toContain('Be precise, not pedantic');
  });
});
