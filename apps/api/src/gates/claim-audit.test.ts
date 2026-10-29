import { randomUUID } from 'node:crypto';
import type { MarketProfile } from '@evidomo/shared';
import { describe, expect, it } from 'vitest';
import { copyWarnings, type WarningSegment } from './claim-audit.ts';

const market: Pick<MarketProfile, 'facts'> = {
  facts: [
    {
      key: 'energy_label',
      label: 'Energy label',
      type: 'enum',
      values: ['A', 'B'],
      required: true,
    },
    { key: 'living_area', label: 'Living area', type: 'area', basis: 'NEN2580', required: true },
    { key: 'build_year', label: 'Build year', type: 'integer', required: false },
  ],
};

function segment(
  variant: WarningSegment['variant'],
  factKeys: string[],
  removed = false,
): WarningSegment {
  return { variant, claimId: randomUUID(), factKeys, removed };
}

describe('copyWarnings', () => {
  it('warns nothing without removals', () => {
    expect(copyWarnings([segment('portal', ['energy_label'])], market)).toEqual([]);
  });

  it('names market facts whose last mention in a variant was removed, in profile order', () => {
    const label = segment('portal', ['energy_label', 'other:balcony'], true);
    const year = segment('portal', ['build_year', 'living_area'], true);
    const keeps = segment('portal', ['living_area']);
    const social = segment('social', ['energy_label']);
    expect(copyWarnings([label, year, keeps, social], market)).toEqual([
      {
        kind: 'market_fact_unmentioned',
        variant: 'portal',
        factKey: 'energy_label',
        required: true,
        removedClaimIds: [label.claimId],
      },
      {
        kind: 'market_fact_unmentioned',
        variant: 'portal',
        factKey: 'build_year',
        required: false,
        removedClaimIds: [year.claimId],
      },
    ]);
  });

  it('lists every removed claim that cited the fact, and an emptied variant', () => {
    const first = segment('social', ['living_area'], true);
    const second = segment('social', ['living_area', 'energy_label'], true);
    expect(copyWarnings([segment('portal', ['living_area']), first, second], market)).toEqual([
      {
        kind: 'market_fact_unmentioned',
        variant: 'social',
        factKey: 'energy_label',
        required: true,
        removedClaimIds: [second.claimId],
      },
      {
        kind: 'market_fact_unmentioned',
        variant: 'social',
        factKey: 'living_area',
        required: true,
        removedClaimIds: [first.claimId, second.claimId],
      },
      { kind: 'variant_empty', variant: 'social' },
    ]);
  });

  it('ignores keys outside the market profile', () => {
    expect(
      copyWarnings(
        [segment('portal', ['other:storage_area'], true), segment('portal', [])],
        market,
      ),
    ).toEqual([]);
  });
});
