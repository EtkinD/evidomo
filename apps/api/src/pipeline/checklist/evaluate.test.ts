import { randomUUID } from 'node:crypto';
import {
  STAGED_IMAGE_LABEL,
  publicationChecklistResultSchema,
  type ClaimAuditCategory,
  type MarketProfile,
  type PublicationChecklistItemResult,
} from '@evidomo/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDefinitions } from '../../definitions/loader.ts';
import {
  evaluatePublicationChecklist,
  type ChecklistClaimAudit,
  type ChecklistCopySegment,
  type ChecklistFact,
  type ChecklistStagedImage,
  type PublicationChecklistInput,
} from './evaluate.ts';

// Every rule on the real `nl` v1 and `international` v1 checklists: pass, fail, and
// not_applicable where the rule has it. Facts, segments, and flags are synthetic.

let nl: MarketProfile;
let international: MarketProfile;

beforeAll(async () => {
  const registry = await loadDefinitions();
  nl = registry.getMarket('nl', 1);
  international = registry.getMarket('international', 1);
});

function fact(overrides: Partial<ChecklistFact> = {}): ChecklistFact {
  return {
    id: randomUUID(),
    key: 'energy_label',
    value: 'B',
    unit: null,
    basis: null,
    status: 'verified',
    source: { kind: 'form' },
    ...overrides,
  };
}

function segment(overrides: Partial<ChecklistCopySegment> = {}): ChecklistCopySegment {
  return { claimId: randomUUID(), variant: 'portal', factIds: [], decision: null, ...overrides };
}

const ALL_CATEGORIES: ClaimAuditCategory[] = [
  'claim_support',
  'unverifiable_superlative',
  'investment_promise',
  'exclusionary',
  'area_basis',
];

function audit(
  remainingFlags: ChecklistClaimAudit['remainingFlags'] = [],
  auditedCategories = ALL_CATEGORIES,
): ChecklistClaimAudit {
  return { auditedCategories, remainingFlags };
}

const labeled = (): ChecklistStagedImage => ({
  artifactId: randomUUID(),
  disclosure: { label: STAGED_IMAGE_LABEL, visibleLabelRequired: true },
});

function input(
  market: MarketProfile,
  overrides: Partial<PublicationChecklistInput> = {},
): PublicationChecklistInput {
  return {
    market,
    facts: [],
    copy: { segments: [] },
    claimAudit: audit(),
    stagedImages: [],
    ...overrides,
  };
}

function item(
  market: MarketProfile,
  id: string,
  overrides: Partial<PublicationChecklistInput> = {},
): PublicationChecklistItemResult {
  const found = evaluatePublicationChecklist(input(market, overrides)).items.find(
    (candidate) => candidate.id === id,
  );
  if (found === undefined) throw new Error(`No checklist item ${id}`);
  return found;
}

describe('the real checklists', () => {
  it('are evaluated in profile order with one result per item', () => {
    expect(evaluatePublicationChecklist(input(nl)).items.map((i) => [i.id, i.rule])).toEqual([
      ['energy_label_shown', 'fact_present'],
      ['staging_disclosed', 'staged_images_labeled'],
    ]);
    expect(
      evaluatePublicationChecklist(input(international)).items.map((i) => [i.id, i.rule]),
    ).toEqual([
      ['staging_disclosed', 'staged_images_labeled'],
      ['no_exclusionary_language', 'no_flagged_phrasing'],
      ['no_investment_promises', 'no_flagged_phrasing'],
    ]);
  });
});

describe('fact_present (nl energy_label_shown)', () => {
  it('passes with a verified value, and records whether the copy cites it', () => {
    const label = fact();
    const uncited = item(nl, 'energy_label_shown', { facts: [label] });
    expect(uncited).toMatchObject({
      status: 'pass',
      fact: 'energy_label',
      factIds: [label.id],
      citedIn: [],
    });
    expect(uncited.detail).toMatch(/does not cite it/);

    const cited = item(nl, 'energy_label_shown', {
      facts: [label],
      copy: {
        segments: [
          segment({ variant: 'social', factIds: [label.id] }),
          segment({ variant: 'portal', factIds: [randomUUID(), label.id] }),
        ],
      },
    });
    expect(cited).toMatchObject({ status: 'pass', citedIn: ['portal', 'social'] });
  });

  it('passes when form and walkthrough agree on one value; a removed segment is not a citation', () => {
    const form = fact();
    const spoken = fact({ source: { kind: 'transcript_turn' } });
    const result = item(nl, 'energy_label_shown', {
      facts: [form, spoken],
      copy: { segments: [segment({ factIds: [form.id], decision: 'remove' })] },
    });
    expect(result).toMatchObject({ status: 'pass', factIds: [form.id, spoken.id], citedIn: [] });
    expect(result.detail).toMatch(/2 sources/);
  });

  it('counts a Gate 1 decision as a verified value', () => {
    const decided = fact({ value: 'A', source: { kind: 'gate_decision' } });
    expect(item(nl, 'energy_label_shown', { facts: [decided] }).status).toBe('pass');
  });

  it('fails without a verified value: missing, candidate, rejected, or conflicted', () => {
    expect(item(nl, 'energy_label_shown').status).toBe('fail');
    const unverified = (['candidate', 'rejected', 'conflicted'] as const).map((status) =>
      fact({ status }),
    );
    const result = item(nl, 'energy_label_shown', { facts: unverified });
    expect(result).toMatchObject({ status: 'fail', factIds: [] });
    expect(result.detail).toBe('No verified "energy_label" value, so the pack cannot show it.');
  });

  it('fails on photo evidence alone, an invalid value, or another fact key', () => {
    const photo = fact({ source: { kind: 'photo_region' } });
    const invalid = fact({ value: 'Z' });
    const other = fact({ key: 'build_year', value: 1987 });
    const result = item(nl, 'energy_label_shown', { facts: [photo, invalid, other] });
    expect(result).toMatchObject({ status: 'fail', factIds: [] });
    expect(result.detail).toMatch(/1 verified fact uses another unit, basis, or an invalid value/);
  });

  it('fails when the verified values differ', () => {
    const b = fact({ value: 'B' });
    const c = fact({ value: 'C', source: { kind: 'gate_decision' } });
    const result = item(nl, 'energy_label_shown', { facts: [b, c] });
    expect(result).toMatchObject({ status: 'fail', factIds: [b.id, c.id] });
    expect(result.detail).toMatch(/2 different verified "energy_label" values/);
  });

  it('reads area facts on the profile measure only (unit and basis)', () => {
    const market: MarketProfile = {
      ...nl,
      publication_checklist: [
        {
          id: 'living_area_shown',
          label: 'Living area shown',
          rule: 'fact_present',
          fact: 'living_area',
        },
      ],
    };
    const nen = fact({ key: 'living_area', value: 92, unit: 'm2', basis: 'NEN2580' });
    const unspecified = fact({ key: 'living_area', value: 95, unit: 'm2', basis: 'unspecified' });
    const sqft = fact({ key: 'living_area', value: 990, unit: 'sq_ft', basis: 'NEN2580' });

    expect(item(market, 'living_area_shown', { facts: [nen, unspecified, sqft] })).toMatchObject({
      status: 'pass',
      factIds: [nen.id],
    });
    const off = item(market, 'living_area_shown', { facts: [unspecified, sqft] });
    expect(off).toMatchObject({ status: 'fail', factIds: [] });
    expect(off.detail).toBe(
      'No verified "living_area" value on the profile measure (m2, NEN2580); 2 verified facts use another unit, basis, or an invalid value.',
    );
  });

  it('fails closed for a fact the profile does not define (an unvalidated profile)', () => {
    const market: MarketProfile = {
      ...nl,
      publication_checklist: [
        { id: 'epc_shown', label: 'EPC shown', rule: 'fact_present', fact: 'epc_rating' },
      ],
    };
    expect(item(market, 'epc_shown', { facts: [fact({ key: 'epc_rating' })] })).toMatchObject({
      status: 'fail',
      detail: '"epc_rating" is not a fact of market nl v1.',
    });
  });
});

describe('staged_images_labeled (staging_disclosed, both markets)', () => {
  it('is not applicable without approved staged images', () => {
    for (const market of [nl, international]) {
      expect(item(market, 'staging_disclosed')).toMatchObject({
        status: 'not_applicable',
        stagedArtifactIds: [],
        unlabeledArtifactIds: [],
        detail: 'No staged image is approved for the pack.',
      });
    }
  });

  it('passes when every approved image records the visible disclosure', () => {
    const images = [labeled(), labeled()];
    for (const market of [nl, international]) {
      expect(item(market, 'staging_disclosed', { stagedImages: images })).toMatchObject({
        status: 'pass',
        stagedArtifactIds: images.map((image) => image.artifactId),
        unlabeledArtifactIds: [],
        detail: 'All 2 approved staged images carry the visible "Virtually staged" label.',
      });
    }
  });

  it('fails when any approved image lacks the label, the visibility flag, or the disclosure', () => {
    const good = labeled();
    const wrongLabel = {
      ...labeled(),
      disclosure: { label: 'AI enhanced', visibleLabelRequired: true },
    };
    const hidden = {
      ...labeled(),
      disclosure: { label: STAGED_IMAGE_LABEL, visibleLabelRequired: false },
    };
    const none = { ...labeled(), disclosure: null };
    for (const market of [nl, international]) {
      const result = item(market, 'staging_disclosed', {
        stagedImages: [good, wrongLabel, hidden, none],
      });
      expect(result).toMatchObject({
        status: 'fail',
        unlabeledArtifactIds: [wrongLabel.artifactId, hidden.artifactId, none.artifactId],
        detail: '3 of 4 approved staged images lack the visible "Virtually staged" disclosure.',
      });
    }
  });

  it('counts an image passed twice once', () => {
    const image = labeled();
    expect(item(nl, 'staging_disclosed', { stagedImages: [image, image] }).detail).toBe(
      'The approved staged image carries the visible "Virtually staged" label.',
    );
  });
});

describe('no_flagged_phrasing (international)', () => {
  it('passes when the audit checked the category and left no flag in it', () => {
    const other = segment();
    const result = item(international, 'no_exclusionary_language', {
      copy: { segments: [other] },
      // A flag of another category does not count against this item.
      claimAudit: audit([{ category: 'investment_promise', claimId: other.claimId }]),
    });
    expect(result).toMatchObject({
      status: 'pass',
      audited: true,
      unresolvedClaimIds: [],
      detail: 'The claim audit left no flag in this category.',
    });
    expect(
      item(international, 'no_investment_promises', {
        copy: { segments: [other] },
        claimAudit: audit([{ category: 'investment_promise', claimId: other.claimId }]),
      }).status,
    ).toBe('fail');
  });

  it('passes when every flagged segment was decided at Gate 2, and lists each decision', () => {
    const accepted = segment({ decision: 'accept' });
    const edited = segment({ variant: 'social', decision: 'edit' });
    const removed = segment({ decision: 'remove' });
    const flags = [accepted, edited, removed, edited].map((s) => ({
      category: 'investment_promise' as const,
      claimId: s.claimId,
    }));
    const result = item(international, 'no_investment_promises', {
      copy: { segments: [accepted, edited, removed, segment()] },
      claimAudit: audit(flags),
    });
    expect(result).toMatchObject({
      status: 'pass',
      acceptedClaimIds: [accepted.claimId],
      editedClaimIds: [edited.claimId],
      removedClaimIds: [removed.claimId],
      unresolvedClaimIds: [],
      detail:
        '3 flagged segments in this category, all decided at Gate 2: 1 approved as written, 1 rewritten (not re-audited), 1 removed.',
    });
  });

  it('fails while a flagged segment is undecided', () => {
    const open = segment();
    const removed = segment({ decision: 'remove' });
    const result = item(international, 'no_exclusionary_language', {
      copy: { segments: [open, removed] },
      claimAudit: audit([
        { category: 'exclusionary', claimId: open.claimId },
        { category: 'exclusionary', claimId: removed.claimId },
      ]),
    });
    expect(result).toMatchObject({
      status: 'fail',
      unresolvedClaimIds: [open.claimId],
      removedClaimIds: [removed.claimId],
      detail: '1 flagged segment is undecided at Gate 2.',
    });
  });

  it('fails closed on a flag whose claim is not in the final copy', () => {
    const stray = randomUUID();
    const result = item(international, 'no_exclusionary_language', {
      copy: { segments: [segment()] },
      claimAudit: audit([{ category: 'exclusionary', claimId: stray }]),
    });
    expect(result).toMatchObject({
      status: 'fail',
      unresolvedClaimIds: [stray],
      detail: '1 flag points at a segment outside the final copy.',
    });
  });

  it('fails when nobody checked: no claim audit, or the category not in its rubric', () => {
    expect(item(international, 'no_exclusionary_language', { claimAudit: null })).toMatchObject({
      status: 'fail',
      audited: false,
      detail: 'The copy has no claim audit, so this category was not checked.',
    });
    expect(
      item(international, 'no_exclusionary_language', {
        claimAudit: audit([], ['claim_support', 'investment_promise']),
      }),
    ).toMatchObject({
      status: 'fail',
      audited: false,
      detail: 'The claim audit did not check this category.',
    });
  });
});

describe('the result', () => {
  it('is ready to publish exactly when no item fails', () => {
    const label = fact();
    const ready = evaluatePublicationChecklist(input(nl, { facts: [label] }));
    expect(ready.summary).toEqual({
      readyToPublish: true,
      counts: { items: 2, pass: 1, fail: 0, notApplicable: 1 },
    });
    const blocked = evaluatePublicationChecklist(input(nl));
    expect(blocked.summary).toEqual({
      readyToPublish: false,
      counts: { items: 2, pass: 0, fail: 1, notApplicable: 1 },
    });
    expect(publicationChecklistResultSchema.parse(blocked)).toEqual(blocked);
    expect(ready).toMatchObject({
      schemaVersion: 1,
      rulesVersion: 1,
      market: { id: 'nl', version: 1 },
    });
  });

  it('is deterministic for the same input', () => {
    const fixed = input(international, {
      copy: { segments: [segment()] },
      stagedImages: [labeled()],
    });
    expect(JSON.stringify(evaluatePublicationChecklist(fixed))).toBe(
      JSON.stringify(evaluatePublicationChecklist(fixed)),
    );
  });

  it('throws on a rule it does not implement instead of skipping it', () => {
    // Mutated past the type system on purpose: the loader never lets such a profile through.
    const unvalidated = structuredClone(nl);
    const [first] = unvalidated.publication_checklist;
    if (first === undefined) throw new Error('nl v1 has a checklist');
    Object.assign(first, { rule: 'photos_watermarked' });
    expect(() => evaluatePublicationChecklist(input(unvalidated))).toThrow(
      'Unknown publication checklist rule',
    );
  });
});
