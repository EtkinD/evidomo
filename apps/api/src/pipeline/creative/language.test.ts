import { describe, expect, it } from 'vitest';
import { checkLanguage } from './language.ts';

const EN =
  'This apartment offers 92 m² of living space on the second floor, with a balcony that faces the afternoon sun and a kitchen from 2021.';
const NL =
  'Dit appartement biedt 92 m² woonoppervlakte op de tweede verdieping, met een balkon op het zuidwesten en een keuken uit 2021.';
const TR =
  'Bu daire ikinci katta 92 m² yaşam alanı sunuyor; öğleden sonra güneş alan bir balkona ve 2021 yılında yenilenen bir mutfağa sahip.';
const IT =
  'Questo appartamento offre 92 mq di superficie al secondo piano, con un balcone che riceve il sole del pomeriggio e una cucina del 2021. È anche molto luminoso.';
const ES =
  'Este piso ofrece 92 m² de superficie en la segunda planta, con un balcón que recibe el sol de la tarde y una cocina de 2021. Es muy luminoso y está cerca del centro.';

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

  it('matches Turkish, Italian, and Spanish copy in its own language', () => {
    expect(checkLanguage(TR, 'tr')).toBe('match');
    expect(checkLanguage(TR.replace('Bu daire', 'İçin daire'), 'tr')).toBe('match');
    expect(checkLanguage(IT, 'it')).toBe('match');
    expect(checkLanguage(ES, 'es')).toBe('match');
  });

  it('tells all five languages apart', () => {
    const texts = { en: EN, nl: NL, tr: TR, it: IT, es: ES };
    for (const [written, text] of Object.entries(texts)) {
      for (const expected of Object.keys(texts)) {
        expect(checkLanguage(text, expected), `${written} as ${expected}`).toBe(
          written === expected ? 'match' : 'mismatch',
        );
      }
    }
  });

  it('does not check languages it has no word list for', () => {
    expect(checkLanguage(NL, 'de')).toBe('unchecked');
  });
});
