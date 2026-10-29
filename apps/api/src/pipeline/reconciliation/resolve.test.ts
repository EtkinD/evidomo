import { randomUUID } from 'node:crypto';
import type { FactOutcome, MarketProfile, StoredTranscriptTurn } from '@evidomo/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NewFact } from '../../db/repositories/facts.ts';
import { loadDefinitions } from '../../definitions/loader.ts';
import { buildCatalog, type Catalog, type CatalogFact } from './catalog.ts';
import { resolveReconciliation, type ReconciliationResult } from './resolve.ts';
import type { ReconciliationStepOutput } from './schema.ts';
import { newFact, storedFact } from './testing.ts';

// The code that decides: the basis rule on market facts, and every check on the model's answer.
// Inputs are small synthetic catalogs (fictional values); the model answer is written by hand.

const RUN_ID = randomUUID();
const TRANSCRIPT_ID = randomUUID();
const PHOTO_ID = randomUUID();

const TURNS: StoredTranscriptTurn[] = [
  'Het appartement heeft 92 vierkante meter woonoppervlakte volgens NEN 2580.',
  'Energielabel B, gebouwd in 1987.',
  'De berging is zes vierkante meter.',
  'De berging is zeven vierkante meter, en het balkon ligt op het zuiden.',
  'Prachtige straat, alles bij elkaar zo’n 95 vierkante meter.',
  'Erfpacht canon 1200 euro per jaar. Morgen heb ik nog een afspraak.',
].map((text, index) => ({
  index,
  sourceTurnIndex: index,
  speaker: 'A',
  text,
  startMs: index * 10_000,
  endMs: index * 10_000 + 9_000,
  timing: 'model' as const,
}));

const form = (key: string, value: NewFact['value'], extra: Parameters<typeof newFact>[3] = {}) =>
  newFact(key, value, { kind: 'form', field: key.replace(/^other:/, '') }, extra);

function spoken(
  turnIndex: number,
  quote: string,
  key: string,
  value: NewFact['value'],
  extra: Parameters<typeof newFact>[3] = {},
): NewFact {
  const turn = TURNS[turnIndex];
  if (turn === undefined || !turn.text.includes(quote)) throw new Error(`bad quote ${quote}`);
  return newFact(
    key,
    value,
    {
      kind: 'transcript_turn',
      transcriptArtifactId: TRANSCRIPT_ID,
      turnIndex,
      startMs: turn.startMs,
      endMs: turn.endMs,
      quote,
    },
    extra,
  );
}

const photo = (key: string, count: number): NewFact =>
  newFact(key, count, {
    kind: 'photo_region',
    materialId: PHOTO_ID,
    region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
  });

const AREA = { unit: 'm2', basis: 'NEN2580' } as const;
const BASE: NewFact[] = [
  form('energy_label', 'B'),
  form('living_area', 92, AREA),
  form('ground_lease', true),
  form('other:street_name', 'Teststraat'),
];

let market: MarketProfile;

beforeAll(async () => {
  market = (await loadDefinitions()).getMarket('nl', 1);
});

function inventoryWith(keys: readonly string[]) {
  const region = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
  return {
    schemaVersion: 1 as const,
    promptVersion: 1,
    model: 'muse-spark-1.3',
    reasoningEffort: 'low',
    maxOutputTokens: 4000,
    segmentationModel: 'sam-3.1',
    privacyPhrases: ['person'],
    evidence: { cap: 12, candidateCount: 0, requestCount: 0, regionCount: 0, maskCount: 0 },
    counts: {
      photos: 1,
      classified: 1,
      classificationFailed: 0,
      privacy: { clear: 1, masked: 0, review: 0, failed: 0 },
      privacyRegions: 0,
      observations: keys.length,
      facts: keys.length,
      rejectedObservations: 0,
    },
    photos: [
      {
        materialId: PHOTO_ID,
        materialSha256: '0'.repeat(64),
        width: 1024,
        height: 682,
        classification: {
          status: 'ok' as const,
          subject: 'balcony' as const,
          otherSubject: null,
          furnishing: null,
          summary: 'A balcony with a railing.',
          quality: 'good' as const,
          qualityIssues: [],
          coverScore: 5,
          coverRank: 1,
          repairs: [],
        },
        privacy: {
          status: 'clear' as const,
          phrases: [{ status: 'checked' as const, phrase: 'person', modelSaw: false, regions: [] }],
        },
        observations: keys.map((key) => ({
          key,
          object: key.slice('other:'.length),
          label: key.slice('other:'.length),
          detail: 'Visible in the photo.',
          modelCount: 1,
          supports: [],
          evidence: {
            status: 'not_requested' as const,
            phrase: null,
            instanceCount: null,
            regions: [],
            reason: null,
          },
          region,
          factStored: true,
        })),
      },
    ],
    rejected: [],
  };
}

function catalogOf(facts: readonly NewFact[]): Catalog {
  const stored = facts.map((fact) => storedFact(RUN_ID, fact));
  const photoKeys = facts.filter((f) => f.source.kind === 'photo_region').map((f) => f.key);
  return buildCatalog({
    market,
    facts: stored,
    transcript: { artifactId: TRANSCRIPT_ID, turns: TURNS },
    inventory: photoKeys.length > 0 ? inventoryWith(photoKeys) : null,
  });
}

const NO_ANSWER: ReconciliationStepOutput = { verifiedFacts: [], conflicts: [], rejected: [] };

function outcomeOf(
  catalog: Catalog,
  result: ReconciliationResult,
  match: (item: CatalogFact) => boolean,
): FactOutcome {
  const item = catalog.items.find((candidate) => match(candidate));
  const outcome = result.outcomes.find((o) => o.factId === item?.fact.id);
  if (outcome === undefined) throw new Error('no such outcome');
  return outcome;
}

const idOf = (catalog: Catalog, key: string, value: unknown): string => {
  const item = catalog.items.find(
    (candidate) => candidate.key === key && candidate.value === value,
  );
  if (item === undefined) throw new Error(`no ${key}=${String(value)}`);
  return item.evidenceId;
};

describe('market facts: the basis rule decides, the model cannot', () => {
  it('verifies 92 (form + NEN 2580 turn) and sets the basis-less "zo’n 95" aside without a conflict', () => {
    const catalog = catalogOf([
      ...BASE,
      spoken(0, '92 vierkante meter woonoppervlakte volgens NEN 2580', 'living_area', 92, AREA),
      spoken(4, 'zo’n 95 vierkante meter', 'living_area', 95, { unit: 'm2', basis: 'unspecified' }),
    ]);
    // The model even claims a conflict; same-key market comparisons are code's alone.
    const result = resolveReconciliation(market, catalog, {
      ...NO_ANSWER,
      conflicts: [
        {
          key: 'living_area',
          kind: 'value_mismatch',
          evidenceIds: ['F.living_area', 'C02'],
          explanation: 'Living area 92 vs about 95.',
        },
      ],
    });

    expect(result.conflicts).toEqual([]);
    const living = result.entries.find((entry) => entry.key === 'living_area');
    expect(living).toMatchObject({
      value: 92,
      unit: 'm2',
      basis: 'NEN2580',
      evidenceIds: ['F.living_area', 'C01'],
      reason: 'agreement',
      decidedBy: 'code',
    });
    expect(outcomeOf(catalog, result, (f) => f.value === 95)).toMatchObject({
      status: 'rejected',
      reason: 'different_basis',
      decidedBy: 'code',
    });
    expect(result.basisNotes).toEqual([
      expect.objectContaining({
        evidenceId: 'C02',
        value: 95,
        basis: 'unspecified',
        reason: 'different_basis',
        relatedEntryId: living?.id,
        relatedConflictId: null,
      }),
    ]);
    // C02 is decided by the basis rule first, so the proposal has one usable citation left.
    expect(result.diagnostics.conflictsDropped).toEqual({ too_few_evidence: 1 });
    expect(result.diagnostics.citationsStripped).toEqual({ decided_by_rule: 1 });
  });

  it('reports the same basis with different values as a conflict, whatever the model says', () => {
    const catalog = catalogOf([
      ...BASE,
      spoken(4, 'zo’n 95 vierkante meter', 'living_area', 95, AREA),
      spoken(0, '92 vierkante meter woonoppervlakte volgens NEN 2580', 'living_area', 92, {
        unit: 'm2',
        basis: 'unspecified',
      }),
    ]);
    const result = resolveReconciliation(market, catalog, {
      ...NO_ANSWER,
      verifiedFacts: [{ key: 'living_area', value: 92, evidenceIds: ['F.living_area'] }],
      rejected: [{ evidenceId: 'C02', reason: 'ambiguous', explanation: 'Approximate.' }],
    });

    expect(result.conflicts).toHaveLength(1);
    const [conflict] = result.conflicts;
    expect(conflict).toMatchObject({
      id: 'K01',
      key: 'living_area',
      kind: 'value_mismatch',
      detectedBy: ['code'],
    });
    expect(conflict?.sides.map((side) => [side.value, side.basis, side.evidenceIds])).toEqual([
      [92, 'NEN2580', ['F.living_area']],
      [95, 'NEN2580', ['C02']],
    ]);
    // The basis-less 92 neither decides nor joins the conflict.
    expect(
      outcomeOf(catalog, result, (f) => f.value === 92 && f.sourceKind !== 'form'),
    ).toMatchObject({
      status: 'rejected',
      reason: 'different_basis',
    });
    expect(result.basisNotes[0]?.relatedConflictId).toBe('K01');
    expect(result.entries.some((entry) => entry.key === 'living_area')).toBe(false);
    expect(result.diagnostics.citationsStripped).toEqual({ market_fact_compared_by_code: 1 });
    expect(result.diagnostics.rejectionsIgnored).toEqual({ market_fact_compared_by_code: 1 });
  });

  it('lets a basis-less equal value corroborate, and keeps another named basis out', () => {
    const catalog = catalogOf([
      ...BASE,
      spoken(0, '92 vierkante meter', 'living_area', 92, { unit: 'm2', basis: 'unspecified' }),
      spoken(4, 'zo’n 95 vierkante meter', 'living_area', 95, { unit: 'm2', basis: 'cadastral' }),
    ]);
    const result = resolveReconciliation(market, catalog, NO_ANSWER);
    expect(result.entries.find((e) => e.key === 'living_area')?.evidenceIds).toEqual([
      'F.living_area',
      'C01',
    ]);
    expect(
      outcomeOf(
        catalog,
        result,
        (f) => f.value === 92 && f.key === 'living_area' && f.sourceKind === 'transcript_turn',
      ),
    ).toMatchObject({
      status: 'verified',
      reason: 'corroborating',
    });
    expect(outcomeOf(catalog, result, (f) => f.value === 95).reason).toBe('different_basis');
  });

  it('never verifies an opinion and never lets the model see one', () => {
    const catalog = catalogOf([
      ...BASE,
      spoken(4, 'Prachtige straat', 'other:street_quality', 'prachtig', { assertion: 'opinion' }),
    ]);
    expect(catalog.input.candidates).toEqual([]);
    const opinionId = catalog.items.find((i) => i.assertion === 'opinion')?.evidenceId ?? '';
    const result = resolveReconciliation(market, catalog, {
      ...NO_ANSWER,
      verifiedFacts: [{ key: 'other:street_quality', value: 'prachtig', evidenceIds: [opinionId] }],
    });
    expect(outcomeOf(catalog, result, (f) => f.key === 'other:street_quality')).toMatchObject({
      status: 'rejected',
      reason: 'opinion',
      decidedBy: 'code',
    });
    expect(result.diagnostics.unknownEvidenceIds).toBe(1);
  });
});

describe('model judgments are verified in code', () => {
  const storage6 = spoken(2, 'zes vierkante meter', 'other:storage_area', 6, {
    unit: 'm2',
    basis: 'unspecified',
  });
  const storage7 = spoken(3, 'zeven vierkante meter', 'other:storage_area', 7, {
    unit: 'm2',
    basis: 'unspecified',
  });
  const balcony = spoken(3, 'het balkon ligt op het zuiden', 'other:balcony_orientation', 'zuiden');
  const appointment = spoken(5, 'Morgen heb ik nog een afspraak', 'other:appointment', 'morgen');

  it('accepts a grouping whose value is cited exactly, with photo support for a presence', () => {
    const catalog = catalogOf([...BASE, balcony, photo('other:balcony', 1)]);
    const result = resolveReconciliation(market, catalog, {
      ...NO_ANSWER,
      verifiedFacts: [
        // The `other:` prefix may be dropped; the value must be the candidate's, untranslated.
        { key: 'balcony_orientation', value: 'zuiden', evidenceIds: ['C01', 'P01.R1', 'C99'] },
      ],
    });
    expect(result.entries.find((e) => e.key === 'other:balcony_orientation')).toMatchObject({
      value: 'zuiden',
      evidenceIds: ['C01', 'P01.R1'],
      sourceKinds: ['transcript_turn', 'photo_region'],
      reason: 'model_verified',
      decidedBy: 'model',
    });
    expect(result.diagnostics).toMatchObject({ verifiedAccepted: 1, unknownEvidenceIds: 1 });
    // The form's own `other:` field stands on its own: the form is the source of truth.
    expect(result.entries.find((e) => e.key === 'other:street_name')?.reason).toBe('single_source');
  });

  it('drops a value that no cited candidate states, and never verifies the candidate by default', () => {
    const catalog = catalogOf([...BASE, balcony]);
    const result = resolveReconciliation(market, catalog, {
      ...NO_ANSWER,
      verifiedFacts: [{ key: 'other:balcony_orientation', value: 'south', evidenceIds: ['C01'] }],
    });
    expect(result.diagnostics.verifiedDropped).toEqual({ value_not_cited: 1 });
    expect(outcomeOf(catalog, result, (f) => f.key === 'other:balcony_orientation')).toMatchObject({
      status: 'rejected',
      reason: 'not_reconciled',
    });
  });

  it('turns a grouping of different values on one measure into a conflict', () => {
    const catalog = catalogOf([...BASE, storage6, storage7]);
    const result = resolveReconciliation(market, catalog, {
      ...NO_ANSWER,
      verifiedFacts: [{ key: 'other:storage_area', value: 7, evidenceIds: ['C01', 'C02'] }],
    });
    expect(result.diagnostics.verifiedEscalated).toBe(1);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        key: 'other:storage_area',
        detectedBy: ['code'],
        sides: [
          expect.objectContaining({ value: 6, evidenceIds: ['C01'] }),
          expect.objectContaining({ value: 7, evidenceIds: ['C02'] }),
        ],
      }),
    ]);
  });

  it('does not treat related statements under different keys as support or contradiction', () => {
    const address = spoken(0, 'Het appartement heeft 92', 'other:address', 'Teststraat 1');
    const catalog = catalogOf([...BASE, address]);
    const result = resolveReconciliation(market, catalog, {
      ...NO_ANSWER,
      verifiedFacts: [
        { key: 'other:address', value: 'Teststraat 1', evidenceIds: ['C01', 'F.street_name'] },
      ],
    });
    expect(result.conflicts).toEqual([]);
    expect(result.entries.find((e) => e.key === 'other:address')?.evidenceIds).toEqual(['C01']);
    expect(result.entries.find((e) => e.key === 'other:street_name')?.reason).toBe('single_source');
    expect(result.diagnostics.citationsStripped).toEqual({ value_differs: 1 });
  });

  it('keeps photos out of measurements', () => {
    const catalog = catalogOf([...BASE, storage6, photo('other:storage_room', 1)]);
    const result = resolveReconciliation(market, catalog, {
      ...NO_ANSWER,
      verifiedFacts: [{ key: 'other:storage_area', value: 6, evidenceIds: ['C01', 'P01.R1'] }],
    });
    expect(result.entries.find((e) => e.key === 'other:storage_area')?.evidenceIds).toEqual([
      'C01',
    ]);
    expect(result.diagnostics.citationsStripped).toEqual({ photo_cannot_support_measurement: 1 });
    // The observation itself is what the photo shows.
    expect(result.entries.find((e) => e.key === 'other:storage_room')).toMatchObject({
      value: 1,
      reason: 'single_source',
      decidedBy: 'code',
    });
  });

  it('accepts a cross-key conflict and pulls the whole verified market entry into it', () => {
    const fee = spoken(5, 'Erfpacht canon 1200 euro per jaar', 'ground_lease_annual_fee', 1200, {
      unit: 'EUR',
    });
    const catalog = catalogOf([
      ...BASE.map((fact) => (fact.key === 'ground_lease' ? { ...fact, value: false } : fact)),
      fee,
      spoken(1, 'Energielabel B', 'energy_label', 'B'),
    ]);
    const result = resolveReconciliation(market, catalog, {
      ...NO_ANSWER,
      conflicts: [
        {
          key: 'ground_lease',
          kind: 'presence_mismatch',
          evidenceIds: ['F.ground_lease', 'C02'],
          explanation: 'The form says no ground lease, the agent names an annual ground lease fee.',
        },
      ],
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      kind: 'presence_mismatch',
      detectedBy: ['model'],
      sides: [
        expect.objectContaining({ key: 'ground_lease', value: false }),
        expect.objectContaining({ key: 'ground_lease_annual_fee', value: 1200 }),
      ],
    });
    expect(result.entries.map((e) => e.key)).not.toContain('ground_lease');
    // Energy label (form + transcript) is untouched.
    expect(result.entries.find((e) => e.key === 'energy_label')?.evidenceIds).toEqual([
      'F.energy_label',
      'C01',
    ]);
  });

  it('applies the basis rule to model conflicts on measurements', () => {
    const gross = spoken(4, 'zo’n 95 vierkante meter', 'other:gross_area', 95, {
      unit: 'm2',
      basis: 'unspecified',
    });
    const catalog = catalogOf([...BASE, gross]);
    const result = resolveReconciliation(market, catalog, {
      ...NO_ANSWER,
      conflicts: [
        {
          key: 'living_area',
          kind: 'value_mismatch',
          evidenceIds: ['F.living_area', 'C01'],
          explanation: '92 vs 95.',
        },
      ],
    });
    expect(result.conflicts).toEqual([]);
    expect(result.diagnostics.conflictsDropped).toEqual({ no_disagreement: 1 });
  });

  it('accepts rejections of transcript candidates only', () => {
    const catalog = catalogOf([...BASE, appointment]);
    const result = resolveReconciliation(market, catalog, {
      ...NO_ANSWER,
      rejected: [
        {
          evidenceId: idOf(catalog, 'other:appointment', 'morgen'),
          reason: 'out_of_scope',
          explanation: 'The agent’s schedule.',
        },
        { evidenceId: 'F.street_name', reason: 'ambiguous', explanation: 'x' },
        { evidenceId: 'F.energy_label', reason: 'ambiguous', explanation: 'x' },
      ],
    });
    expect(outcomeOf(catalog, result, (f) => f.key === 'other:appointment')).toMatchObject({
      status: 'rejected',
      reason: 'out_of_scope',
      decidedBy: 'model',
      note: 'The agent’s schedule.',
    });
    expect(result.diagnostics.rejectionsIgnored).toEqual({
      form_or_photo_not_rejectable: 1,
      market_fact_compared_by_code: 1,
    });
    expect(outcomeOf(catalog, result, (f) => f.key === 'other:street_name').status).toBe(
      'verified',
    );
  });

  it('gives every candidate exactly one outcome and keeps conflicts disjoint', () => {
    const catalog = catalogOf([
      ...BASE,
      storage6,
      storage7,
      balcony,
      appointment,
      photo('other:balcony', 1),
    ]);
    const result = resolveReconciliation(market, catalog, {
      verifiedFacts: [
        { key: 'other:storage_area', value: 6, evidenceIds: ['C01'] },
        { key: 'other:storage_area', value: 7, evidenceIds: ['C02', 'C01'] },
      ],
      conflicts: [
        {
          key: 'other:storage_area',
          kind: 'value_mismatch',
          evidenceIds: ['C01', 'C02'],
          explanation: '6 vs 7.',
        },
        {
          key: 'other:balcony',
          kind: 'presence_mismatch',
          evidenceIds: ['C03', 'P01.R1', 'C02'],
          explanation: 'x',
        },
      ],
      rejected: [],
    });
    expect(result.outcomes).toHaveLength(catalog.items.length);
    const conflicted = result.conflicts.flatMap((c) => c.factIds);
    expect(new Set(conflicted).size).toBe(conflicted.length);
  });
});
