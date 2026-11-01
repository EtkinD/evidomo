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

  it('does not count Spanish, Italian, or Turkish words that are on another list against them', () => {
    // The recorded es caption (fictional town): "de" and "en" are Spanish here, not Dutch.
    const caption =
      'Apartamento de 92 m² en Zandmeer con salón en forma de L de 34 m². Puertas francesas conectan con el balcón de 7 m² orientado al suroeste con sol por la tarde. Cocina y baño de 2021 con placa de inducción y ducha de lluvia.';
    expect(checkLanguage(caption, 'es')).toBe('match');
    // en and nl read as before: Dutch still counts "de" and "en", so this caption checked as nl
    // is a (known, unchanged) false match; as en it is no match.
    expect(checkLanguage(caption, 'en')).toBe('mismatch');
    expect(
      checkLanguage(
        'Il balcone a sud-ovest e la cucina a vista sono del 2021; a Zandmeer è anche vicina la stazione, che è a 10 minuti.',
        'it',
      ),
    ).toBe('match');
    // Turkish endings after an apostrophe are part of their word, not Dutch "de" or English "a".
    expect(
      checkLanguage(
        "Zandmeer'de bu daire 1987'de inşa edildi ve İstasyon'a 10 dakika uzaklıkta; balkon ve mutfak da yenidir, en güzel yer de burası.",
        'tr',
      ),
    ).toBe('match');
    // Dutch and English copy still fail as Spanish, Italian, or Turkish.
    for (const language of ['es', 'it', 'tr']) {
      expect(checkLanguage(NL, language)).toBe('mismatch');
      expect(checkLanguage(EN, language)).toBe('mismatch');
    }
  });

  it('does not check languages it has no word list for', () => {
    expect(checkLanguage(NL, 'de')).toBe('unchecked');
  });
});
