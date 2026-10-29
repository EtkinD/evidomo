import { beforeAll, describe, expect, it } from 'vitest';
import { FACT_FORM_LIMITS, factFormValuesSchema, type MarketProfile } from '@evidomo/shared';
import { loadDefinitions } from '../definitions/loader.ts';
import { factFormToCandidates } from '../pipeline/extraction/form.ts';
import { OTHER_SLUG_PATTERN } from '../pipeline/extraction/schema.ts';
import { WALKTHROUGH_FACT_FORM as WALKTHROUGH_JSON } from '../pipeline/intake/testing.ts';
import { checkFactForm, fieldIssues } from './fact-form.ts';

const WALKTHROUGH_FACT_FORM = factFormValuesSchema.parse(WALKTHROUGH_JSON);

let nl: MarketProfile;

beforeAll(async () => {
  nl = (await loadDefinitions()).getMarket('nl', 1);
});

describe('checkFactForm (nl v1)', () => {
  it('accepts the walkthrough form unchanged, and the run accepts what was saved', () => {
    const result = checkFactForm(WALKTHROUGH_FACT_FORM, nl);
    expect(result).toEqual({ ok: true, values: WALKTHROUGH_FACT_FORM });
    if (!result.ok) throw new Error('unreachable');
    expect(factFormToCandidates(result.values, nl).skippedFields).toBe(0);
  });

  it('saves partial drafts: required fields may be empty, nulls clear a field', () => {
    expect(checkFactForm({ energy_label: null, build_year: 1990, street_name: null }, nl)).toEqual({
      ok: true,
      values: { build_year: 1990 },
    });
    expect(checkFactForm({}, nl)).toEqual({ ok: true, values: {} });
  });

  it('trims extra-field text', () => {
    expect(checkFactForm({ place_name: '  Zandmeer ' }, nl)).toEqual({
      ok: true,
      values: { place_name: 'Zandmeer' },
    });
  });

  it('reports one problem code per invalid field and stores nothing', () => {
    const result = checkFactForm(
      {
        energy_label: 'Z',
        living_area: '92',
        volume: -1,
        plot_area: 120.5,
        build_year: 1987.5,
        vve_monthly_contribution: true,
        ground_lease: 'no',
        'Street Name': 'Kwartelhoflaan',
        place_name: '   ',
        note: 'x'.repeat(FACT_FORM_LIMITS.extraTextMaxLength + 1),
      },
      nl,
    );
    expect(result).toEqual({
      ok: false,
      fields: {
        energy_label: 'not_allowed',
        living_area: 'wrong_type',
        volume: 'out_of_range',
        build_year: 'not_an_integer',
        vve_monthly_contribution: 'wrong_type',
        ground_lease: 'wrong_type',
        'Street Name': 'invalid_key',
        place_name: 'invalid_text',
        note: 'invalid_text',
      },
    });
  });

  it('checks integer ranges and enum types', () => {
    expect(checkFactForm({ build_year: 999, energy_label: 3 }, nl)).toEqual({
      ok: false,
      fields: { build_year: 'out_of_range', energy_label: 'wrong_type' },
    });
    expect(checkFactForm({ build_year: 1000 }, nl).ok).toBe(true);
    expect(checkFactForm({ build_year: 2101 }, nl).ok).toBe(false);
  });

  it('caps extra fields, marking the keys past the limit in key order', () => {
    const submitted: Record<string, string> = {};
    for (let i = 0; i <= FACT_FORM_LIMITS.maxExtraFields; i += 1) {
      submitted[`extra_${String(i).padStart(2, '0')}`] = 'x';
    }
    const result = checkFactForm(submitted, nl);
    const last = `extra_${String(FACT_FORM_LIMITS.maxExtraFields).padStart(2, '0')}`;
    expect(result).toEqual({ ok: false, fields: { [last]: 'too_many_fields' } });
  });

  it('turns problems into validation issues under values.<key>', () => {
    expect(fieldIssues({ energy_label: 'not_allowed' })).toEqual([
      { path: ['values', 'energy_label'], message: 'Not one of the allowed values' },
    ]);
  });
});

describe('parity with the fact extraction step', () => {
  it('uses the same extra-field key pattern', () => {
    expect(FACT_FORM_LIMITS.extraKeyPattern.source).toBe(OTHER_SLUG_PATTERN.source);
  });

  it('uses the same text limit: the longest accepted text becomes an other: fact', () => {
    const longest = 'x'.repeat(FACT_FORM_LIMITS.extraTextMaxLength);
    const result = checkFactForm({ ...WALKTHROUGH_FACT_FORM, note: longest }, nl);
    if (!result.ok) throw new Error('expected the longest text to be accepted');
    expect(factFormToCandidates(result.values, nl).candidates).toContainEqual(
      expect.objectContaining({ key: 'other:note', value: longest }),
    );
    const tooLong = { ...WALKTHROUGH_FACT_FORM, note: `${longest}x` };
    expect(checkFactForm(tooLong, nl).ok).toBe(false);
    expect(factFormToCandidates(tooLong, nl).skippedFields).toBe(1);
  });
});
