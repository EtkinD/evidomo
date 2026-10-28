import { describe, expect, it } from 'vitest';
import { compareMeasures, compareProfileFacts, sameValue, type Measured } from './compare.ts';

const area = (value: number, basis: string | null, key = 'living_area'): Measured => ({
  key,
  value,
  unit: 'm2',
  basis,
});

describe('compareMeasures (the basis rule)', () => {
  it('compares stated numbers exactly, without tolerance or coercion', () => {
    expect(sameValue(92, 92)).toBe(true);
    expect(sameValue(92, 92.5)).toBe(false);
    expect(sameValue(92, '92')).toBe(false);
    expect(sameValue(true, 'yes')).toBe(false);
  });

  it('same basis: equal agrees, different contradicts', () => {
    expect(compareMeasures(area(92, 'NEN2580'), area(92, 'NEN2580'))).toEqual({
      relation: 'agree',
    });
    expect(compareMeasures(area(92, 'NEN2580'), area(95, 'NEN2580'))).toEqual({
      relation: 'contradict',
    });
    // Two values that both lack a basis are on the same (unstated) basis.
    expect(compareMeasures(area(6, 'unspecified'), area(7, 'unspecified'))).toEqual({
      relation: 'contradict',
    });
  });

  it('a stated basis next to an unstated one: equal corroborates, different is another measure', () => {
    expect(compareMeasures(area(92, 'NEN2580'), area(92, 'unspecified'))).toEqual({
      relation: 'agree',
    });
    expect(compareMeasures(area(92, 'NEN2580'), area(95, 'unspecified'))).toEqual({
      relation: 'incomparable',
      reason: 'different_basis',
    });
  });

  it('two different named bases or units are never compared', () => {
    expect(compareMeasures(area(92, 'NEN2580'), area(92, 'cadastral'))).toEqual({
      relation: 'incomparable',
      reason: 'different_basis',
    });
    expect(
      compareMeasures(area(92, 'NEN2580'), {
        key: 'living_area',
        value: 92,
        unit: 'ft2',
        basis: 'NEN2580',
      }),
    ).toEqual({ relation: 'incomparable', reason: 'different_unit' });
  });

  it('non-measurements (basis null) compare by value', () => {
    const label = (value: string): Measured => ({
      key: 'energy_label',
      value,
      unit: null,
      basis: null,
    });
    expect(compareMeasures(label('B'), label('B')).relation).toBe('agree');
    expect(compareMeasures(label('B'), label('C')).relation).toBe('contradict');
  });
});

describe('compareProfileFacts', () => {
  const measure = { key: 'living_area', unit: 'm2', basis: 'NEN2580' };

  it('verifies one value on the profile measure and sets other measures aside', () => {
    const form = area(92, 'NEN2580');
    const spoken = area(92, 'NEN2580');
    const approx = area(95, 'unspecified');
    const unstatedEqual = area(92, 'unspecified');
    const cadastral = area(92, 'cadastral');
    const result = compareProfileFacts(measure, [form, spoken, approx, unstatedEqual, cadastral]);
    expect(result).toEqual({
      kind: 'verified',
      members: [form, spoken],
      corroborating: [unstatedEqual],
      offMeasure: [
        { item: approx, reason: 'different_basis' },
        { item: cadastral, reason: 'different_basis' },
      ],
    });
  });

  it('reports different values on the profile measure as one conflict, grouped by value', () => {
    const form = area(92, 'NEN2580');
    const a = area(95, 'NEN2580');
    const b = area(95, 'NEN2580');
    const approx = area(92, 'unspecified');
    const result = compareProfileFacts(measure, [form, a, b, approx]);
    expect(result).toEqual({
      kind: 'conflict',
      sides: [[form], [a, b]],
      // Off-measure values never join a conflict: they cannot say which value is right.
      offMeasure: [{ item: approx, reason: 'different_basis' }],
    });
  });

  it('verifies nothing from off-measure values alone', () => {
    const approx = area(120, 'unspecified', 'plot_area');
    expect(
      compareProfileFacts({ key: 'plot_area', unit: 'm2', basis: 'cadastral' }, [approx]),
    ).toEqual({ kind: 'none', offMeasure: [{ item: approx, reason: 'different_basis' }] });
  });
});
