import { describe, expect, it } from 'vitest';
import { checkLanguage } from './language.ts';

const EN =
  'This apartment offers 92 m² of living space on the second floor, with a balcony that faces the afternoon sun and a kitchen from 2021.';
const NL =
  'Dit appartement biedt 92 m² woonoppervlakte op de tweede verdieping, met een balkon op het zuidwesten en een keuken uit 2021.';

describe('copy language check', () => {
  it('matches English and Dutch copy in its own language', () => {
    expect(checkLanguage(EN, 'en')).toBe('match');
    expect(checkLanguage(NL, 'nl')).toBe('match');
  });

  it('detects copy in the other known language', () => {
    expect(checkLanguage(NL, 'en')).toBe('mismatch');
    expect(checkLanguage(EN, 'nl')).toBe('mismatch');
  });

  it('stays inconclusive on too little or mixed evidence instead of guessing', () => {
    expect(checkLanguage('Energy label B. 92 m².', 'en')).toBe('inconclusive');
    expect(checkLanguage(`${EN} ${NL}`, 'en')).toBe('inconclusive');
  });

  it('does not check languages it has no word list for', () => {
    expect(checkLanguage(NL, 'de')).toBe('unchecked');
  });
});
