import { describe, expect, it } from 'vitest';
import {
  addDecimals,
  compareDecimalStrings,
  DecimalError,
  decimalFromInteger,
  formatDecimalCeil,
  multiplyDecimals,
  parseDecimal,
} from './decimal.ts';

describe('decimal arithmetic', () => {
  it('adds without binary floating-point error', () => {
    expect(formatDecimalCeil(addDecimals(parseDecimal('0.1'), parseDecimal('0.2')), 8)).toBe(
      '0.30000000',
    );
  });

  it('multiplies exactly', () => {
    const cost = multiplyDecimals(decimalFromInteger(540), parseDecimal('0.00000425'));
    expect(formatDecimalCeil(cost, 8)).toBe('0.00229500');
  });

  it('rounds up when digits are dropped, and only then', () => {
    expect(formatDecimalCeil(parseDecimal('0.000000001'), 8)).toBe('0.00000001');
    expect(formatDecimalCeil(parseDecimal('1.234567891'), 8)).toBe('1.23456790');
    expect(formatDecimalCeil(parseDecimal('1.2345678900'), 8)).toBe('1.23456789');
    expect(formatDecimalCeil(parseDecimal('0'), 8)).toBe('0.00000000');
    expect(formatDecimalCeil(parseDecimal('12.5'), 0)).toBe('13');
  });

  it('compares across scales', () => {
    expect(compareDecimalStrings('0.5', '0.50000000')).toBe(0);
    expect(compareDecimalStrings('0.49999999', '0.5')).toBe(-1);
    expect(compareDecimalStrings('10', '9.99999999')).toBe(1);
  });

  it('rejects negative, malformed, and non-integer inputs', () => {
    expect(() => parseDecimal('-1')).toThrow(DecimalError);
    expect(() => parseDecimal('1e-8')).toThrow(DecimalError);
    expect(() => parseDecimal('.5')).toThrow(DecimalError);
    expect(() => decimalFromInteger(1.5)).toThrow(DecimalError);
    expect(() => decimalFromInteger(-1)).toThrow(DecimalError);
  });
});
