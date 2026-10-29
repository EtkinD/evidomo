import { describe, expect, expectTypeOf, it } from 'vitest';
import { publicationChecklistItemSchema, type PublicationChecklistItem } from './definitions.ts';
import {
  PUBLICATION_CHECKLIST_RULES,
  publicationChecklistItemResultSchema,
  publicationChecklistResultSchema,
  type PublicationChecklistItemResult,
  type PublicationChecklistResult,
  type PublicationChecklistRule,
} from './publication-checklist.ts';

const FACT = '0b7f2a0e-5c1d-4d6e-9a51-000000000001';
const IMAGE = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';
const CLAIM = 'c0a8012e-7d2b-4f5e-8f3a-2b1c0d9e8f7a';

const factItem: PublicationChecklistItemResult = {
  id: 'energy_label_shown',
  label: 'The energy label class is shown in the listing',
  rule: 'fact_present',
  status: 'pass',
  detail: 'Verified (1 source) and cited in the portal copy.',
  fact: 'energy_label',
  factIds: [FACT],
  citedIn: ['portal'],
};

const stagingItem: PublicationChecklistItemResult = {
  id: 'staging_disclosed',
  label: 'Every virtually staged image is labeled as such',
  rule: 'staged_images_labeled',
  status: 'pass',
  detail: 'The approved staged image carries the visible "Virtually staged" label.',
  stagedArtifactIds: [IMAGE],
  unlabeledArtifactIds: [],
};

const phrasingItem: PublicationChecklistItemResult = {
  id: 'no_exclusionary_language',
  label: 'No exclusionary phrasing remains',
  rule: 'no_flagged_phrasing',
  status: 'pass',
  detail: 'The claim audit left no flag in this category.',
  category: 'exclusionary',
  audited: true,
  unresolvedClaimIds: [],
  acceptedClaimIds: [],
  editedClaimIds: [],
  removedClaimIds: [],
};

const result: PublicationChecklistResult = {
  schemaVersion: 1,
  rulesVersion: 1,
  market: { id: 'nl', version: 1 },
  items: [factItem, stagingItem],
  summary: { readyToPublish: true, counts: { items: 2, pass: 2, fail: 0, notApplicable: 0 } },
};

const accepts = (item: unknown) => publicationChecklistItemResultSchema.safeParse(item).success;

describe('publication checklist rules', () => {
  it('cover exactly the rule kinds of the market profile schema', () => {
    expectTypeOf<PublicationChecklistRule>().toEqualTypeOf<PublicationChecklistItem['rule']>();
    expectTypeOf<PublicationChecklistItemResult['rule']>().toEqualTypeOf<
      PublicationChecklistItem['rule']
    >();
    expect(publicationChecklistItemSchema.options.map((option) => option.shape.rule.value)).toEqual(
      [...PUBLICATION_CHECKLIST_RULES],
    );
  });
});

describe('publicationChecklistItemResultSchema', () => {
  it('accepts consistent items of every rule', () => {
    for (const item of [factItem, stagingItem, phrasingItem]) expect(accepts(item)).toBe(true);
  });

  it('refuses a status the evidence contradicts', () => {
    expect(accepts({ ...factItem, factIds: [] })).toBe(false);
    expect(accepts({ ...factItem, status: 'not_applicable' })).toBe(false);
    expect(accepts({ ...factItem, status: 'fail' })).toBe(true);
    expect(accepts({ ...stagingItem, stagedArtifactIds: [] })).toBe(false);
    expect(
      accepts({
        ...stagingItem,
        stagedArtifactIds: [],
        unlabeledArtifactIds: [],
        status: 'not_applicable',
      }),
    ).toBe(true);
    expect(accepts({ ...stagingItem, unlabeledArtifactIds: [IMAGE] })).toBe(false);
    expect(accepts({ ...phrasingItem, unresolvedClaimIds: [CLAIM] })).toBe(false);
    expect(accepts({ ...phrasingItem, audited: false })).toBe(false);
    expect(accepts({ ...phrasingItem, status: 'not_applicable' })).toBe(false);
    // An approved-as-written flag is an override, except where the category allows none.
    const accepted = { ...phrasingItem, acceptedClaimIds: [CLAIM] };
    expect(accepts({ ...accepted, category: 'investment_promise' })).toBe(true);
    expect(accepts(accepted)).toBe(false);
    expect(accepts({ ...accepted, status: 'fail' })).toBe(true);
  });

  it('refuses unknown rules, categories, and fields', () => {
    expect(accepts({ ...stagingItem, rule: 'photos_watermarked' })).toBe(false);
    expect(accepts({ ...phrasingItem, category: 'tone' })).toBe(false);
    expect(accepts({ ...stagingItem, note: 'extra' })).toBe(false);
  });
});

describe('publicationChecklistResultSchema', () => {
  const parses = (patch: Partial<PublicationChecklistResult>) =>
    publicationChecklistResultSchema.safeParse({ ...result, ...patch }).success;

  it('accepts a consistent result', () => {
    expect(publicationChecklistResultSchema.parse(result)).toEqual(result);
  });

  it('ties readyToPublish and the counts to the items', () => {
    const failing = { ...factItem, status: 'fail' as const, detail: 'Two values.' };
    expect(
      parses({
        items: [failing, stagingItem],
        summary: {
          readyToPublish: false,
          counts: { items: 2, pass: 1, fail: 1, notApplicable: 0 },
        },
      }),
    ).toBe(true);
    expect(
      parses({
        items: [failing, stagingItem],
        summary: { readyToPublish: true, counts: { items: 2, pass: 1, fail: 1, notApplicable: 0 } },
      }),
    ).toBe(false);
    expect(
      parses({
        summary: { readyToPublish: true, counts: { items: 2, pass: 1, fail: 0, notApplicable: 1 } },
      }),
    ).toBe(false);
    expect(parses({ items: [factItem, factItem] })).toBe(false);
  });
});
