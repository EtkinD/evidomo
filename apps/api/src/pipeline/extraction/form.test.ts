import { beforeAll, describe, expect, it } from 'vitest';
import type { MarketProfile } from '@evidomo/shared';
import { loadDefinitions } from '../../definitions/loader.ts';
import { WALKTHROUGH_FACT_FORM } from '../intake/testing.ts';
import { FactFormError, factFormToCandidates } from './form.ts';

let nl: MarketProfile;

beforeAll(async () => {
  nl = (await loadDefinitions()).getMarket('nl', 1);
});

describe('factFormToCandidates (nl v1)', () => {
  it('maps market facts with profile units and bases, then other fields as other: facts', () => {
    const { candidates, skippedFields } = factFormToCandidates(WALKTHROUGH_FACT_FORM, nl);
    expect(candidates).toEqual([
      { key: 'energy_label', value: 'B', unit: null, basis: null, field: 'energy_label' },
      { key: 'living_area', value: 92, unit: 'm2', basis: 'NEN2580', field: 'living_area' },
      { key: 'build_year', value: 1987, unit: null, basis: null, field: 'build_year' },
      {
        key: 'vve_monthly_contribution',
        value: 165,
        unit: 'EUR',
        basis: null,
        field: 'vve_monthly_contribution',
      },
      { key: 'ground_lease', value: false, unit: null, basis: null, field: 'ground_lease' },
      {
        key: 'other:place_name',
        value: 'Zandmeer',
        unit: null,
        basis: null,
        field: 'place_name',
      },
      {
        key: 'other:street_name',
        value: 'Kwartelhoflaan',
        unit: null,
        basis: null,
        field: 'street_name',
      },
    ]);
    expect(skippedFields).toBe(0);
  });

  it('treats null and absent optional fields as unknown, and maps volume and plot area', () => {
    const { candidates } = factFormToCandidates(
      { energy_label: 'A', living_area: 74.5, volume: 240, plot_area: null },
      nl,
    );
    expect(candidates.map((c) => [c.key, c.value, c.unit, c.basis])).toEqual([
      ['energy_label', 'A', null, null],
      ['living_area', 74.5, 'm2', 'NEN2580'],
      ['volume', 240, 'm3', null],
    ]);
  });

  it('refuses a form with missing required or invalid market values, naming keys only', () => {
    let error: unknown;
    try {
      factFormToCandidates(
        { living_area: 'ninety-two', build_year: 1987.5, energy_label: null, ground_lease: 'no' },
        nl,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FactFormError);
    expect(error).toMatchObject({
      missing: ['energy_label'],
      invalid: ['living_area', 'build_year', 'ground_lease'],
    });
    expect(String(error)).not.toMatch(/ninety/);
    expect(() => factFormToCandidates({ energy_label: 'A++++++', living_area: 92 }, nl)).toThrow(
      /invalid value for field\(s\): energy_label/,
    );
  });

  it('skips other fields that are not scalar values under a slug key', () => {
    const { candidates, skippedFields } = factFormToCandidates(
      {
        energy_label: 'B',
        living_area: 92,
        notes: { nested: true },
        'Street Name': 'Fictiefstraat',
        empty: '  ',
        rooms: 3,
        garden: true,
        long_text: 'x'.repeat(301),
      },
      nl,
    );
    expect(candidates.slice(2).map((c) => [c.key, c.value])).toEqual([
      ['other:garden', true],
      ['other:rooms', 3],
    ]);
    expect(skippedFields).toBe(4);
  });
});
