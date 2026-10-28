import type { MarketProfile } from '@evidomo/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { buildVerificationRubric } from './rubric.ts';

// The rubric comes from the market profile: claim support always, the phrasing categories the
// copy prompt also forbids, and the area-basis rule from the profile's area facts and bases.

let registry: DefinitionRegistry;
beforeAll(async () => {
  registry = await loadDefinitions();
});

describe('verification rubric', () => {
  it('covers claim support, every flagged phrasing category, and the area basis of nl', () => {
    const rubric = buildVerificationRubric(registry.getMarket('nl', 1));
    expect(rubric.map((rule) => rule.category)).toEqual([
      'claim_support',
      'unverifiable_superlative',
      'investment_promise',
      'exclusionary',
      'area_basis',
    ]);
    const area = rubric.find((rule) => rule.category === 'area_basis')?.rule ?? '';
    // Built from the profile: each area fact with its basis label, never a hardcoded market.
    expect(area).toContain('"living_area" (Living area (woonoppervlakte)) is measured as NEN 2580');
    expect(area).toContain('"plot_area"');
    expect(rubric.find((r) => r.category === 'claim_support')?.rule).toContain('plain negation');
  });

  it('takes the area bases of the international profile', () => {
    const rubric = buildVerificationRubric(registry.getMarket('international', 1));
    const area = rubric.find((rule) => rule.category === 'area_basis')?.rule ?? '';
    expect(area).toContain('"living_area" (Living area) is measured as Net internal floor area');
    expect(area).not.toContain('NEN');
  });

  it('always checks superlatives and promises, adds exclusionary phrasing only when listed, and skips the area rule without area facts', () => {
    const nl = registry.getMarket('nl', 1);
    const market: MarketProfile = {
      ...nl,
      flagged_phrasing: ['investment_promise'],
      facts: nl.facts.filter((fact) => fact.type !== 'area'),
    };
    expect(buildVerificationRubric(market).map((rule) => rule.category)).toEqual([
      'claim_support',
      'unverifiable_superlative',
      'investment_promise',
    ]);
  });
});
