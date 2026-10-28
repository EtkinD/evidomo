import { describe, expect, it } from 'vitest';
import { buildReconciliationPrompt } from './prompt.ts';
import {
  evidenceIds,
  reconciliationInputSchema,
  reconciliationOutputSchema,
  type ReconciliationOutput,
} from './schema.ts';
import { scoreReconciliation } from './score.ts';
import {
  SYNTHETIC_NL_APARTMENT as INPUT,
  SYNTHETIC_NL_APARTMENT_EXPECTATIONS as EXPECTATIONS,
} from './synthetic-nl-apartment.ts';

// A hand-written correct answer for the synthetic apartment.
const REFERENCE: ReconciliationOutput = {
  verifiedFacts: [
    {
      key: 'property_type',
      value: 'apartment',
      unit: null,
      basis: null,
      evidenceIds: ['F.property_type'],
    },
    {
      key: 'energy_label',
      value: 'A',
      unit: null,
      basis: null,
      evidenceIds: ['F.energy_label', 'C04'],
    },
    {
      key: 'build_year',
      value: 1996,
      unit: null,
      basis: null,
      evidenceIds: ['F.build_year', 'C03'],
    },
    {
      key: 'floor_level',
      value: 3,
      unit: null,
      basis: null,
      evidenceIds: ['F.floor_level', 'C01'],
    },
    { key: 'volume', value: 298, unit: 'm3', basis: 'NEN2580', evidenceIds: ['F.volume', 'C22'] },
    {
      key: 'outdoor_area',
      value: 7,
      unit: 'm2',
      basis: 'NEN2580',
      evidenceIds: ['F.outdoor_area', 'C11', 'C09', 'P04.R1'],
    },
    {
      key: 'external_storage_area',
      value: 6,
      unit: 'm2',
      basis: 'NEN2580',
      evidenceIds: ['F.external_storage_area', 'C17', 'P11.R1'],
    },
    {
      key: 'vve_monthly_contribution',
      value: 185,
      unit: 'EUR',
      basis: null,
      evidenceIds: ['F.vve_monthly_contribution', 'C18'],
    },
    {
      key: 'ground_lease',
      value: 'none (freehold)',
      unit: null,
      basis: null,
      evidenceIds: ['F.ground_lease', 'C20'],
    },
    { key: 'elevator', value: 'yes', unit: null, basis: null, evidenceIds: ['C02', 'P12.R1'] },
    { key: 'gross_floor_area', value: 104, unit: 'm2', basis: null, evidenceIds: ['C06'] },
    { key: 'kitchen_renovation_year', value: 2021, unit: null, basis: null, evidenceIds: ['C07'] },
    {
      key: 'kitchen_appliances',
      value: 'induction hob, dishwasher',
      unit: null,
      basis: null,
      evidenceIds: ['C08', 'P03.R1', 'P03.R2'],
    },
    {
      key: 'balcony_orientation',
      value: 'south-west',
      unit: null,
      basis: null,
      evidenceIds: ['C10'],
    },
    {
      key: 'built_in_wardrobe',
      value: 'yes',
      unit: null,
      basis: null,
      evidenceIds: ['C13', 'P05.R2'],
    },
    { key: 'bathrooms', value: 1, unit: null, basis: null, evidenceIds: ['INV2', 'C14'] },
    { key: 'toilets', value: 2, unit: null, basis: null, evidenceIds: ['C15', 'INV3'] },
    { key: 'heating_boiler_year', value: 2019, unit: null, basis: null, evidenceIds: ['C16'] },
    { key: 'vve_maintenance_plan', value: 'yes', unit: null, basis: null, evidenceIds: ['C19'] },
    {
      key: 'parking',
      value: 'permit parking, no private space',
      unit: null,
      basis: null,
      evidenceIds: ['C23'],
    },
    {
      key: 'flooring',
      value: 'wooden floors',
      unit: null,
      basis: null,
      evidenceIds: ['C24', 'P01.R2'],
    },
  ],
  conflicts: [
    {
      key: 'living_area',
      kind: 'value_mismatch',
      sides: [
        {
          evidenceId: 'F.living_area',
          value: 92,
          unit: 'm2',
          basis: 'NEN2580',
          statement: 'Form: 92 m2',
        },
        {
          evidenceId: 'C05',
          value: 95,
          unit: 'm2',
          basis: 'NEN2580',
          statement: 'Transcript: 95 m2',
        },
      ],
      explanation: 'Same basis, different values.',
    },
    {
      key: 'bedrooms',
      kind: 'count_mismatch',
      sides: [
        {
          evidenceId: 'C12',
          value: 2,
          unit: null,
          basis: null,
          statement: 'Transcript: two bedrooms',
        },
        {
          evidenceId: 'INV1',
          value: 3,
          unit: null,
          basis: null,
          statement: 'Photos: three bedrooms',
        },
      ],
      explanation: 'Transcript count differs from the photo inventory.',
    },
  ],
  distinctBasisNotes: [
    {
      key: 'floor_area',
      evidenceIds: ['C06', 'F.living_area'],
      explanation: 'Gross area incl. storage and walls vs NEN 2580 living area.',
    },
  ],
  rejected: [
    { evidenceId: 'C21', reason: 'opinion', explanation: 'Subjective and a value prediction.' },
  ],
};

describe('synthetic NL apartment', () => {
  it('is a valid reconciliation input with verbatim quotes and consistent timestamps', () => {
    expect(() => reconciliationInputSchema.parse(INPUT)).not.toThrow();
  });

  it('only references catalog IDs in its expectations', () => {
    const catalog = evidenceIds(INPUT);
    const referenced = [
      ...EXPECTATIONS.conflicts.flatMap((rule) => [...rule.all, ...rule.anyOf]),
      ...EXPECTATIONS.neverInConflict.flatMap((rule) => rule.evidenceIds),
      ...EXPECTATIONS.neverVerified.flatMap((rule) => rule.evidenceIds),
      ...EXPECTATIONS.opinions,
      ...EXPECTATIONS.expectedVerified,
    ];
    expect(referenced.filter((id) => !catalog.has(id))).toEqual([]);
  });

  it('serializes to a reconciliation-sized prompt', () => {
    // ~4 characters per token: the catalog alone is several thousand input tokens.
    expect(buildReconciliationPrompt(INPUT).length).toBeGreaterThan(12_000);
  });

  it('rejects a candidate whose quote is not verbatim from its turn', () => {
    const tampered = {
      ...INPUT,
      candidates: INPUT.candidates.map((c) => (c.id === 'C05' ? { ...c, quote: '92 m2' } : c)),
    };
    expect(reconciliationInputSchema.safeParse(tampered).success).toBe(false);
  });
});

describe('scoreReconciliation', () => {
  it('gives the reference answer a clean score', () => {
    expect(reconciliationOutputSchema.parse(REFERENCE)).toEqual(REFERENCE);
    expect(scoreReconciliation(INPUT, EXPECTATIONS, REFERENCE)).toEqual({
      conflictsCaught: { living_area_same_basis: true, bedrooms_transcript_vs_photos: true },
      extraConflicts: 0,
      falseConflictEvidence: [],
      wronglyVerifiedEvidence: [],
      opinionsRejectedAsOpinion: 1,
      unknownEvidenceIds: [],
      verifiedWithoutEvidence: [],
      numericMismatches: [],
      oneSidedConflicts: [],
      unaccountedCandidates: [],
      expectedVerifiedCovered: EXPECTATIONS.expectedVerified.length,
      expectedVerifiedTotal: EXPECTATIONS.expectedVerified.length,
    });
  });

  it('detects missed conflicts, false conflicts, verified opinions, and provenance errors', () => {
    const broken: ReconciliationOutput = {
      verifiedFacts: [
        ...REFERENCE.verifiedFacts,
        {
          key: 'living_area',
          value: 92,
          unit: 'm2',
          basis: 'NEN2580',
          evidenceIds: ['F.living_area'],
        },
        { key: 'location', value: 'best street', unit: null, basis: null, evidenceIds: ['C21'] },
        { key: 'rooms', value: 4, unit: null, basis: null, evidenceIds: ['C12'] },
        { key: 'cellar', value: 'yes', unit: null, basis: null, evidenceIds: ['T15'] },
        { key: 'garden', value: 'no', unit: null, basis: null, evidenceIds: [] },
      ],
      conflicts: [
        {
          key: 'floor_area',
          kind: 'value_mismatch',
          sides: [
            { evidenceId: 'F.living_area', value: 92, unit: 'm2', basis: 'NEN2580', statement: '' },
            { evidenceId: 'C06', value: 104, unit: 'm2', basis: null, statement: '' },
          ],
          explanation: 'Wrongly treats a gross area as a contradiction.',
        },
        {
          key: 'bedrooms',
          kind: 'count_mismatch',
          sides: [{ evidenceId: 'C12', value: 2, unit: null, basis: null, statement: '' }],
          explanation: 'One-sided.',
        },
      ],
      distinctBasisNotes: [],
      rejected: [],
    };

    const score = scoreReconciliation(INPUT, EXPECTATIONS, broken);
    expect(score.conflictsCaught).toEqual({
      living_area_same_basis: false,
      bedrooms_transcript_vs_photos: false,
    });
    expect(score.extraConflicts).toBe(2);
    expect(score.falseConflictEvidence).toEqual(['C06']);
    expect(score.wronglyVerifiedEvidence).toEqual(['C21', 'F.living_area', 'C12']);
    expect(score.opinionsRejectedAsOpinion).toBe(0);
    expect(score.unknownEvidenceIds).toEqual(['T15']);
    expect(score.verifiedWithoutEvidence).toEqual(['garden']);
    expect(score.numericMismatches).toEqual(['rooms=4']);
    expect(score.oneSidedConflicts).toEqual(['bedrooms']);
    expect(score.unaccountedCandidates).toEqual(['C05']);
  });
});
