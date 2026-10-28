import { describe, expect, it } from 'vitest';
import {
  canonicalUnit,
  isClaimLanguage,
  readNumbers,
  unitOfKey,
  type ClaimLanguage,
  type NumberReading,
} from './numbers.ts';

// The number reader on its own: what counts as a number claim, how it is read in each language,
// and which spans are not claims. The validator's pass/fail decisions are in validator.test.ts.

function read(text: string, language: ClaimLanguage): [string, NumberReading][] {
  return readNumbers(text, language).map((token) => [
    text.slice(token.start, token.end),
    token.reading,
  ]);
}

const value = (v: number, unit: string | null = null): NumberReading => ({
  kind: 'value',
  value: v,
  unit,
});
const unreadable: NumberReading = { kind: 'unreadable' };
const datetime: NumberReading = { kind: 'datetime' };

describe('separators by language', () => {
  it.each<[string, ClaimLanguage, NumberReading]>([
    ['1250', 'en', value(1250)],
    ['1,250', 'en', value(1250)],
    ['1,250,000', 'en', value(1_250_000)],
    ['1.5', 'en', value(1.5)],
    ['1,250.75', 'en', value(1250.75)],
    // English reads "." as the decimal point: "1.250" is 1.25, never 1250.
    ['1.250', 'en', value(1.25)],
    ['1,5', 'en', unreadable],
    ['12,5', 'en', unreadable],
    ['1.250.000', 'en', unreadable],
    ['1250', 'nl', value(1250)],
    ['1.250', 'nl', value(1250)],
    ['1.250.000', 'nl', value(1_250_000)],
    ['1,5', 'nl', value(1.5)],
    ['92,5', 'nl', value(92.5)],
    ['1.250,75', 'nl', value(1250.75)],
    ['1.5', 'nl', unreadable],
    ['1,250.000', 'nl', unreadable],
  ])('%s in %s', (text, language, expected) => {
    expect(read(`Value ${text} here`, language)).toEqual([[text, expected]]);
  });

  it('keeps sentence punctuation out of the number', () => {
    expect(read('Built in 1987. It has 3 rooms, 2 bathrooms.', 'en')).toEqual([
      ['1987', value(1987)],
      ['3', value(3)],
      ['2', value(2)],
    ]);
    expect(read('Bouwjaar 1987, 3 kamers.', 'nl')).toEqual([
      ['1987', value(1987)],
      ['3', value(3)],
    ]);
  });

  it('reads a separator before the digits as unreadable instead of skipping it', () => {
    expect(read('A ceiling of ,5 m', 'en')).toEqual([[',5 m', unreadable]]);
  });
});

describe('units next to numbers', () => {
  it.each<[string, ClaimLanguage, NumberReading]>([
    ['92 m²', 'en', value(92, 'm2')],
    ['92m²', 'en', value(92, 'm2')],
    ['92 m2', 'en', value(92, 'm2')],
    ['92 sq m', 'en', value(92, 'm2')],
    ['92 square metres', 'en', value(92, 'm2')],
    ['92 vierkante meter', 'nl', value(92, 'm2')],
    ['310 m³', 'nl', value(310, 'm3')],
    ['310 kubieke meter', 'nl', value(310, 'm3')],
    ['2.6 m', 'en', value(2.6, 'm')],
    ['2,6 meter', 'nl', value(2.6, 'm')],
    ['3 km', 'en', value(3, 'km')],
    ['3500 kWh', 'en', value(3500, 'kWh')],
    ['€165', 'en', value(165, 'EUR')],
    ['€ 165', 'nl', value(165, 'EUR')],
    ['EUR 165', 'en', value(165, 'EUR')],
    ['165 euro', 'nl', value(165, 'EUR')],
    ['165 €', 'nl', value(165, 'EUR')],
    ['€ 1.250.000,-', 'nl', value(1_250_000, 'EUR')],
    ['€165,-', 'nl', value(165, 'EUR')],
    ['40%', 'en', value(40, '%')],
    ['40 procent', 'nl', value(40, '%')],
    ['10 years', 'en', value(10, 'year')],
    ['10 jaar', 'nl', value(10, 'year')],
    ['10 minutes', 'en', value(10, 'minute')],
    ['10 minuten', 'nl', value(10, 'minute')],
    ['10 min', 'nl', value(10, 'minute')],
    ['2 uur', 'nl', value(2, 'hour')],
  ])('%s (%s)', (text, language, expected) => {
    expect(read(`Here ${text} now`, language)).toEqual([[text, expected]]);
  });

  it('does not take the start of a word as a unit', () => {
    expect(read('Slaapkamer van 14 met inbouwkast', 'nl')).toEqual([['14', value(14)]]);
    expect(read('3 metro stops away', 'en')).toEqual([['3', value(3)]]);
  });

  it('reads a currency sign with another unit, and unknown glued letters, as unreadable', () => {
    expect(read('€92 m²', 'en')).toEqual([['€92 m²', unreadable]]);
    expect(read('A price of 165k', 'en')).toEqual([['165k', unreadable]]);
    expect(read('Renovated in the 1980s', 'en')).toEqual([['1980s', unreadable]]);
    expect(read('2x slaapkamer', 'nl')).toEqual([['2x', unreadable]]);
    expect(read('A 3D tour', 'en')).toEqual([['3D', unreadable]]);
  });

  it('reads a scale word as unreadable: the copy must write the full value', () => {
    expect(read('€1.25 million', 'en')).toEqual([['€1.25 million', unreadable]]);
    expect(read('€ 1,25 miljoen', 'nl')).toEqual([['€ 1,25 miljoen', unreadable]]);
    expect(read('a hundred metres', 'en')).toEqual([['hundred metres', unreadable]]);
    expect(read('honderd meter', 'nl')).toEqual([['honderd meter', unreadable]]);
  });
});

describe('ordinals', () => {
  it.each<[string, ClaimLanguage, number]>([
    ['1st', 'en', 1],
    ['2nd', 'en', 2],
    ['3rd', 'en', 3],
    ['4th', 'en', 4],
    ['first', 'en', 1],
    ['second', 'en', 2],
    ['twentieth', 'en', 20],
    ['1e', 'nl', 1],
    ['2de', 'nl', 2],
    ['8ste', 'nl', 8],
    ['eerste', 'nl', 1],
    ['tweede', 'nl', 2],
    ['achtste', 'nl', 8],
  ])('%s (%s) is the number %d', (text, language, expected) => {
    expect(read(`on the ${text} floor`, language)).toEqual([[text, value(expected)]]);
  });

  it('only reads the language’s own ordinal suffixes', () => {
    expect(read('op de 2nd verdieping', 'nl')).toEqual([['2nd', unreadable]]);
    expect(read('on the 2e floor', 'en')).toEqual([['2e', unreadable]]);
  });
});

describe('number words', () => {
  it.each<[string, ClaimLanguage, number]>([
    ['zero', 'en', 0],
    ['two', 'en', 2],
    ['Three', 'en', 3],
    ['twelve', 'en', 12],
    ['twenty', 'en', 20],
    ['twenty-one', 'en', 21],
    ['ninety-nine', 'en', 99],
    ['pair', 'en', 2],
    ['dozen', 'en', 12],
    ['nul', 'nl', 0],
    ['één', 'nl', 1],
    ['twee', 'nl', 2],
    ['Drie', 'nl', 3],
    ['twaalf', 'nl', 12],
    ['eenentwintig', 'nl', 21],
    ['tweeëntwintig', 'nl', 22],
    ['tweeentwintig', 'nl', 22],
    ['vierentachtig', 'nl', 84],
    ['anderhalve', 'nl', 1.5],
  ])('%s (%s) is %d', (word, language, expected) => {
    expect(read(`with ${word} rooms`, language)).toEqual([[word, value(expected)]]);
  });

  it('reads a unit after a number word', () => {
    expect(read('drie vierkante meter', 'nl')).toEqual([['drie vierkante meter', value(3, 'm2')]]);
  });

  it('leaves out "one" and "een", which are mostly a pronoun and the article', () => {
    expect(read('One of the bedrooms has a balcony; no one else.', 'en')).toEqual([]);
    expect(read('Een woning met een balkon.', 'nl')).toEqual([]);
  });

  it('reads only the segment language’s words, as whole words', () => {
    expect(read('drie kamers', 'en')).toEqual([]);
    expect(read('three rooms', 'nl')).toEqual([]);
    expect(read('Attention, network, often, tweeling, vieren', 'en')).toEqual([]);
    expect(read('tweeling, vieren, zestal', 'nl')).toEqual([]);
  });
});

describe('spans that are not claims', () => {
  it('skips measurement standards', () => {
    expect(read('Measured to NEN 2580: 92 m².', 'en')).toEqual([['92 m²', value(92, 'm2')]]);
    expect(read('Gemeten volgens NEN-2580 en NEN 2580:2007.', 'nl')).toEqual([]);
    expect(read('NEN-EN 13829', 'nl')).toEqual([]);
  });

  it('skips the house type name 2-onder-1-kap', () => {
    expect(read('Een 2-onder-1-kapwoning', 'nl')).toEqual([]);
    expect(read('Twee-onder-een-kap', 'nl')).toEqual([]);
  });

  it('never reads digits glued to a preceding letter (units, names, label classes)', () => {
    expect(read('m2, CO2, A0, HR107, label A++', 'en')).toEqual([]);
  });

  it('reads dates and times as one token each', () => {
    expect(read('Handover 12-03-2027 at 10:30', 'en')).toEqual([
      ['12-03-2027', datetime],
      ['10:30', datetime],
    ]);
    expect(read('Bezichtiging 12.03.2027 om 10.30 uur', 'nl')).toEqual([
      ['12.03.2027', datetime],
      ['10.30', datetime],
    ]);
  });
});

describe('approximations and ranges', () => {
  function markers(text: string, language: ClaimLanguage) {
    return readNumbers(text, language).map((token) => ({
      token: text.slice(token.start, token.end),
      approximate:
        token.approximateFrom === null
          ? token.approximateSuffix
            ? text.slice(token.start, token.end)
            : null
          : text.slice(token.approximateFrom, token.end),
      range: token.rangeTo === null ? null : text.slice(token.start, token.rangeTo),
    }));
  }

  it.each<[string, ClaimLanguage, string]>([
    ['about 92 m²', 'en', 'about 92 m²'],
    ['approx. 92 m²', 'en', 'approx. 92 m²'],
    ['around €165', 'en', 'around €165'],
    ['nearly 92', 'en', 'nearly 92'],
    ['more than 90 m²', 'en', 'more than 90 m²'],
    ['up to 4 bedrooms', 'en', 'up to 4'],
    ['± 92 m²', 'en', '± 92 m²'],
    ['~92 m²', 'en', '~92 m²'],
    ['92+ m²', 'en', '92+'],
    ['92 m²+', 'en', '92 m²+'],
    ['90-ish', 'en', '90-ish'],
    ['ca. 92 m²', 'nl', 'ca. 92 m²'],
    ['circa 92', 'nl', 'circa 92'],
    ["zo'n 95 m²", 'nl', "zo'n 95 m²"],
    ['zo’n 95 m²', 'nl', 'zo’n 95 m²'],
    ['ruim 92 m²', 'nl', 'ruim 92 m²'],
    ['ongeveer drie kamers', 'nl', 'ongeveer drie'],
    ['rond de 1990', 'nl', 'rond de 1990'],
    ['meer dan 90', 'nl', 'meer dan 90'],
    ['95 of zo', 'nl', '95 of zo'],
  ])('%s (%s) is approximate', (text, language, approximate) => {
    expect(markers(`De woning ${text}.`, language)[0]?.approximate).toBe(approximate);
  });

  it('does not read a marker inside a word or a marker that is not next to the number', () => {
    expect(markers('Grond 92 m²', 'nl')[0]?.approximate).toBeNull();
    expect(markers('About the home: 92 m²', 'en')[0]?.approximate).toBeNull();
    expect(markers('92 m² plus a balcony', 'en')[0]?.approximate).toBeNull();
  });

  it.each<[string, ClaimLanguage, string]>([
    ['90-95 m²', 'en', '90-95 m²'],
    ['90 – 95 m²', 'en', '90 – 95 m²'],
    ['90 to 95 m²', 'en', '90 to 95 m²'],
    ['two or three bedrooms', 'en', 'two or three'],
    ['between 90 and 95 m²', 'en', '90 and 95 m²'],
    ['90 tot 95 m²', 'nl', '90 tot 95 m²'],
    ['twee à drie slaapkamers', 'nl', 'twee à drie'],
    ['2 of 3 slaapkamers', 'nl', '2 of 3'],
    ['tussen 90 en 95 m²', 'nl', '90 en 95 m²'],
  ])('%s (%s) is a range', (text, language, range) => {
    expect(markers(text, language)[0]?.range).toBe(range);
  });

  it('does not read a list as a range', () => {
    expect(markers('34 m² and 7 m²', 'en').map((m) => m.range)).toEqual([null, null]);
    expect(markers('34 m² en 7 m²', 'nl').map((m) => m.range)).toEqual([null, null]);
    expect(markers('a 3-room home', 'en').map((m) => m.range)).toEqual([null]);
  });
});

describe('units and languages', () => {
  it('canonicalizes known units and keeps unknown ones distinct', () => {
    expect(canonicalUnit('m2')).toBe('m2');
    expect(canonicalUnit('M²')).toBe('m2');
    expect(canonicalUnit('EUR')).toBe('EUR');
    expect(canonicalUnit('€')).toBe('EUR');
    expect(canonicalUnit('kW')).toBe('other:kw');
  });

  it('reads a unit from the last word of a unit-less fact key', () => {
    expect(unitOfKey('other:station_cycling_time_minutes')).toBe('minute');
    expect(unitOfKey('other:roof_age_years')).toBe('year');
    expect(unitOfKey('build_year')).toBe('year');
    expect(unitOfKey('other:balcony_area')).toBeNull();
    expect(unitOfKey('other:number_of_rooms')).toBeNull();
  });

  it('has number rules for en and nl only', () => {
    expect(isClaimLanguage('en')).toBe(true);
    expect(isClaimLanguage('nl')).toBe(true);
    expect(isClaimLanguage('de')).toBe(false);
  });
});
