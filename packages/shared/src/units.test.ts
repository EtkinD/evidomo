import { describe, expect, it } from 'vitest';
import { AREA_UNITS, VOLUME_UNITS } from './definitions.ts';
import { displayUnit, UNIT_DISPLAY, withDisplayUnit } from './units.ts';

describe('displayUnit', () => {
  it('shows every area and volume unit in its display form', () => {
    expect([...AREA_UNITS, ...VOLUME_UNITS].map(displayUnit)).toEqual([
      'm²',
      'sq ft',
      'm³',
      'cu ft',
    ]);
    expect(Object.keys(UNIT_DISPLAY).sort()).toEqual([...AREA_UNITS, ...VOLUME_UNITS].sort());
  });

  it('shows any other unit as stored, including names of Object.prototype members', () => {
    expect(displayUnit('kWh')).toBe('kWh');
    expect(displayUnit('EUR')).toBe('EUR');
    expect(displayUnit('constructor')).toBe('constructor');
    expect(displayUnit('toString')).toBe('toString');
  });
});

describe('withDisplayUnit', () => {
  it('puts the euro sign before the number and other units after it', () => {
    expect(withDisplayUnit('450000', 'EUR')).toBe('€ 450000');
    expect(withDisplayUnit('92,5', 'm2')).toBe('92,5 m²');
    expect(withDisplayUnit('1200', 'sq_ft')).toBe('1200 sq ft');
    expect(withDisplayUnit('310', 'm3')).toBe('310 m³');
    expect(withDisplayUnit('9000', 'cu_ft')).toBe('9000 cu ft');
    expect(withDisplayUnit('3', 'kWh')).toBe('3 kWh');
  });

  it('returns the number alone without a unit', () => {
    expect(withDisplayUnit('1932', null)).toBe('1932');
  });
});
