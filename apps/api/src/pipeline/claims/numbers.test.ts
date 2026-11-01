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

  it('has number rules for en, nl, tr, it, and es only', () => {
    for (const language of ['en', 'nl', 'tr', 'it', 'es']) {
      expect(isClaimLanguage(language)).toBe(true);
    }
    expect(isClaimLanguage('de')).toBe(false);
    expect(isClaimLanguage('fr')).toBe(false);
  });

  it('keeps the Turkish lira apart from the euro, and matches a TRY fact unit', () => {
    expect(read('250.000 TL', 'tr')).toEqual([['250.000 TL', value(250_000, 'TRY')]]);
    expect(read('₺250.000', 'tr')).toEqual([['₺250.000', value(250_000, 'TRY')]]);
    expect(read('250.000 TRY', 'tr')).toEqual([['250.000 TRY', value(250_000, 'TRY')]]);
    expect(canonicalUnit('TRY')).toBe('TRY');
  });
});

// --- Turkish, Italian, Spanish --------------------------------------------------------------

describe('separators in tr, it, and es (group ".", decimal "," as in nl)', () => {
  it.each<[string, ClaimLanguage, NumberReading]>([
    ['85,5', 'tr', value(85.5)],
    ['250.000', 'tr', value(250_000)],
    ['1.250.000,75', 'tr', value(1_250_000.75)],
    ['85.5', 'tr', unreadable],
    ['85,5', 'it', value(85.5)],
    ['250.000', 'it', value(250_000)],
    ['85.5', 'it', unreadable],
    ['85,5', 'es', value(85.5)],
    ['250.000', 'es', value(250_000)],
    ['85.5', 'es', unreadable],
    ['1,250.000', 'es', unreadable],
    // Space-grouped thousands (the RAE and SI form) are one number, also with a no-break or
    // narrow no-break space; a group that is not exactly three digits does not join.
    ['250 000', 'es', value(250_000)],
    ['1 250 000', 'it', value(1_250_000)],
    ['250\u00A0000', 'tr', value(250_000)],
    ['250\u202F000', 'es', value(250_000)],
    ['1 250,5', 'it', value(1250.5)],
    ['1 250.000', 'es', unreadable],
  ])('%s in %s', (text, language, expected) => {
    expect(read(`Valor ${text} aquí`, language)).toEqual([[text, expected]]);
  });

  it('reads a space between numbers as two numbers in en and nl, and when it is not a group', () => {
    expect(read('Value 250 000 here', 'en')).toEqual([
      ['250', value(250)],
      ['000', value(0)],
    ]);
    expect(read('Waarde 250 000 hier', 'nl')).toEqual([
      ['250', value(250)],
      ['000', value(0)],
    ]);
    expect(read('Piano 2 1250 mq', 'it')).toEqual([
      ['2', value(2)],
      ['1250 mq', value(1250, 'm2')],
    ]);
    expect(read('Año 2021 500 m²', 'es')).toEqual([
      ['2021', value(2021)],
      ['500 m²', value(500, 'm2')],
    ]);
  });
});

describe('units in tr, it, and es', () => {
  it.each<[string, ClaimLanguage, NumberReading]>([
    ['92 m²', 'tr', value(92, 'm2')],
    ['92 metrekare', 'tr', value(92, 'm2')],
    ['92 metrekarelik', 'tr', value(92, 'm2')],
    ["92 m²'lik", 'tr', value(92, 'm2')],
    ["5 km'lik", 'tr', value(5, 'km')],
    ['10 dakika', 'tr', value(10, 'minute')],
    ['10 dakikalık', 'tr', value(10, 'minute')],
    ['2 saat', 'tr', value(2, 'hour')],
    ['15 yıl', 'tr', value(15, 'year')],
    ['15 yıllık', 'tr', value(15, 'year')],
    ['€165', 'tr', value(165, 'EUR')],
    ['165 avro', 'tr', value(165, 'EUR')],
    ['%20', 'tr', value(20, '%')],
    ['% 20', 'tr', value(20, '%')],
    ['yüzde 20', 'tr', value(20, '%')],
    ['Yüzde 20', 'tr', value(20, '%')],
    ['yüzde yirmi', 'tr', value(20, '%')],
    ['92 mq', 'it', value(92, 'm2')],
    ['92mq', 'it', value(92, 'm2')],
    ['92 metri quadri', 'it', value(92, 'm2')],
    ['92 metri quadrati', 'it', value(92, 'm2')],
    ['310 metri cubi', 'it', value(310, 'm3')],
    ['2,6 metri', 'it', value(2.6, 'm')],
    ['10 anni', 'it', value(10, 'year')],
    ['10 minuti', 'it', value(10, 'minute')],
    ['2 ore', 'it', value(2, 'hour')],
    ['40 per cento', 'it', value(40, '%')],
    ['165 euro', 'it', value(165, 'EUR')],
    ['92 metros cuadrados', 'es', value(92, 'm2')],
    ['310 metros cúbicos', 'es', value(310, 'm3')],
    ['2,6 metros', 'es', value(2.6, 'm')],
    ['10 años', 'es', value(10, 'year')],
    ['10 minutos', 'es', value(10, 'minute')],
    ['2 horas', 'es', value(2, 'hour')],
    ['40 por ciento', 'es', value(40, '%')],
    ['165 euros', 'es', value(165, 'EUR')],
    ['250.000 €', 'es', value(250_000, 'EUR')],
  ])('%s (%s)', (text, language, expected) => {
    expect(read(`Burada ${text} şimdi`, language)).toEqual([[text, expected]]);
  });

  it('reads the new spellings only in their own language', () => {
    expect(read('92 mq', 'en')).toEqual([['92', value(92)]]);
    expect(read('10 anni', 'nl')).toEqual([['10', value(10)]]);
    expect(read('92mq', 'en')).toEqual([['92mq', unreadable]]);
  });

  it('does not take the start of a word as a unit', () => {
    expect(read('3 metropolitane', 'it')).toEqual([['3', value(3)]]);
    expect(read('3 masa', 'tr')).toEqual([['3', value(3)]]);
  });
});

describe('scale words and fractions in tr, it, and es', () => {
  it.each<[string, ClaimLanguage, string]>([
    ['iki yüz metre', 'tr', 'iki yüz'],
    ['250 bin TL', 'tr', '250 bin'],
    ['bin metre', 'tr', 'bin metre'],
    ['iki buçuk saat', 'tr', 'iki buçuk'],
    ['1,2 milyon', 'tr', '1,2 milyon'],
    ['duecento metri', 'it', 'duecento metri'],
    ['250 mila euro', 'it', '250 mila'],
    ['un milione', 'it', 'milione'],
    ['centocinquanta', 'it', 'centocinquanta'],
    ['due e mezzo', 'it', 'due e mezzo'],
    ['doscientos metros', 'es', 'doscientos metros'],
    ['dos mil', 'es', 'dos mil'],
    ['cien metros', 'es', 'cien metros'],
    ['1,2 millones', 'es', '1,2 millones'],
    ['dos y medio', 'es', 'dos y medio'],
  ])('%s (%s) is unreadable', (text, language, token) => {
    expect(read(`— ${text} —`, language)).toEqual([[token, unreadable]]);
  });

  it('never applies "bin" or "mil" outside Turkish and Spanish', () => {
    expect(read('3 bin bags', 'en')).toEqual([['3', value(3)]]);
    expect(read('3 mil thick', 'en')).toEqual([['3', value(3)]]);
    expect(read('3 mil', 'it')).toEqual([['3', value(3)]]);
  });

  it('does not read words that only contain a scale ("percento", "Milano", "millennio")', () => {
    expect(read('Milano, millennio, accento, centrale', 'it')).toEqual([]);
    expect(read('yüzme havuzu, bina, yüzde', 'tr')).toEqual([]);
  });

  it.each<[string, ClaimLanguage]>([
    ['onlarca ağaç', 'tr'],
    ['yüzlerce', 'tr'],
    ['bir düzine', 'tr'],
    ['una ventina di minuti', 'it'],
    ['una decina', 'it'],
    ['un centinaio', 'it'],
    ['un paio di minuti', 'it'],
    ['una docena de árboles', 'es'],
    ['un centenar', 'es'],
    ['decenas de', 'es'],
  ])('reads the collective "%s" (%s) as unreadable', (text, language) => {
    const tokens = read(text, language);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.[1]).toEqual(unreadable);
  });
});

describe('ordinals in tr, it, and es', () => {
  it.each<[string, ClaimLanguage, number]>([
    ["3'üncü", 'tr', 3],
    ['3’üncü', 'tr', 3],
    ["2'nci", 'tr', 2],
    ["1'inci", 'tr', 1],
    ["6'ncı", 'tr', 6],
    ['3üncü', 'tr', 3],
    ['birinci', 'tr', 1],
    ['üçüncü', 'tr', 3],
    ['on ikinci', 'tr', 12],
    ['yirminci', 'tr', 20],
    ['1º', 'it', 1],
    ['2ª', 'it', 2],
    ['3.º', 'it', 3],
    ['primo', 'it', 1],
    ['terzo', 'it', 3],
    ['seconda', 'it', 2],
    ['ventesimo', 'it', 20],
    ['1º', 'es', 1],
    ['2ª', 'es', 2],
    ['1.º', 'es', 1],
    ['3.ª', 'es', 3],
    ['3er', 'es', 3],
    ['1er', 'es', 1],
    ['2do', 'es', 2],
    ['primer', 'es', 1],
    ['tercera', 'es', 3],
    ['séptimo', 'es', 7],
    ['vigésimo', 'es', 20],
  ])('%s (%s) is the number %d', (text, language, expected) => {
    expect(read(`kat ${text} piano`, language)).toEqual([[text, value(expected)]]);
  });

  it('reads a "3. kat" ordinal as its number and leaves the dot', () => {
    expect(read('Daire 3. katta.', 'tr')).toEqual([['3', value(3)]]);
  });

  it('only reads the language’s own ordinal suffixes', () => {
    expect(read('al 3er piano', 'it')).toEqual([['3er', unreadable]]);
    expect(read('on the 1º floor', 'en')).toEqual([['1º', unreadable]]);
  });
});

describe('Turkish endings after the apostrophe', () => {
  it.each<[string, NumberReading]>([
    ["1990'da", value(1990)],
    ['1990’da', value(1990)],
    ["2021'de", value(2021)],
    ["3'ü", value(3)],
    ["92'lik", value(92)],
    ["%20'si", value(20, '%')],
    // A decade or a set is not one exact value.
    ["1990'lı", unreadable],
    ["1990'lar", unreadable],
    ["1990'larda", unreadable],
    ["90'lı", unreadable],
    ["3'lü", unreadable],
  ])('%s', (text, expected) => {
    expect(read(`Ev ${text} yapıldı`, 'tr')).toEqual([[text, expected]]);
  });
});

describe('number words in tr, it, and es', () => {
  it.each<[string, ClaimLanguage, number]>([
    ['sıfır', 'tr', 0],
    ['iki', 'tr', 2],
    ['İki', 'tr', 2],
    ['İKİ', 'tr', 2],
    ['ALTI', 'tr', 6],
    ['altı', 'tr', 6],
    ['on', 'tr', 10],
    ['on iki', 'tr', 12],
    ['yirmi bir', 'tr', 21],
    ['yirmi  bir', 'tr', 21],
    ['yirmibir', 'tr', 21],
    ['doksan dokuz', 'tr', 99],
    ['ikisi', 'tr', 2],
    ['zero', 'it', 0],
    ['due', 'it', 2],
    ['Tre', 'it', 3],
    ['diciassette', 'it', 17],
    ['venti', 'it', 20],
    ['ventuno', 'it', 21],
    ['ventun', 'it', 21],
    ['ventotto', 'it', 28],
    ['trentotto', 'it', 38],
    ['ventitré', 'it', 23],
    ['ventitre', 'it', 23],
    ['novantanove', 'it', 99],
    ['trilocale', 'it', 3],
    ['bilocali', 'it', 2],
    ['cero', 'es', 0],
    ['dos', 'es', 2],
    ['Tres', 'es', 3],
    ['dieciséis', 'es', 16],
    ['dieciseis', 'es', 16],
    ['veintiuno', 'es', 21],
    ['veintiún', 'es', 21],
    ['veintidós', 'es', 22],
    ['veintidos', 'es', 22],
    ['veintiséis', 'es', 26],
    ['treinta', 'es', 30],
    ['treinta y uno', 'es', 31],
    ['treinta y un', 'es', 31],
    ['cuarenta y dos', 'es', 42],
    ['noventa y nueve', 'es', 99],
  ])('%s (%s) is %d', (word, language, expected) => {
    expect(read(`con ${word} camere`, language)).toEqual([[word, value(expected)]]);
  });

  it('leaves out the indefinite articles "bir", "un/uno/una", which double as "one"', () => {
    expect(read('Bir balkon ve bir bahçe.', 'tr')).toEqual([]);
    expect(read('Un balcone, uno studio e una cantina.', 'it')).toEqual([]);
    expect(read('Un balcón, uno de los baños y una terraza.', 'es')).toEqual([]);
  });

  it('reads a unit after a number word', () => {
    expect(read('yirmi bir metrekare', 'tr')).toEqual([['yirmi bir metrekare', value(21, 'm2')]]);
    expect(read('trentun anni', 'it')).toEqual([['trentun anni', value(31, 'year')]]);
    expect(read('treinta y un años', 'es')).toEqual([['treinta y un años', value(31, 'year')]]);
  });

  it('reads only the segment language’s words, as whole words', () => {
    expect(read('due camere', 'es')).toEqual([]);
    expect(read('dos dormitorios', 'it')).toEqual([]);
    expect(read('iki oda', 'en')).toEqual([]);
    expect(read('Ottobre, settembre, novembre, onda, ona, onun', 'it')).toEqual([]);
    expect(read('onun, ona, onlar, ikiz, beşik, üçgen', 'tr')).toEqual([]);
  });
});

describe('homographs of number words', () => {
  it.each<[string, ClaimLanguage]>([
    // Italian "sei" = "you are"; "secondo" = "according to"; "prima" = "before" or a tax status.
    ['Se sei alla ricerca di una casa luminosa', 'it'],
    ['Sei pronto per una nuova vita?', 'it'],
    ['Secondo il catasto la casa è in classe A.', 'it'],
    ['Secondo me è perfetta.', 'it'],
    ['Prima di tutto, la luce.', 'it'],
    ['Ideale come prima casa o come seconda casa.', 'it'],
    ['Arredi di seconda mano.', 'it'],
    ['Un quarto d’ora dal centro.', 'it'],
    ['La cucina, rinnovata prima.', 'it'],
    // Spanish "cuarto de baño" is a room; "primera línea" is beachfront.
    ['El cuarto de baño tiene ducha.', 'es'],
    ['En primera línea de playa.', 'es'],
    ['Muebles de segunda mano.', 'es'],
    ['Ideal como segunda residencia.', 'es'],
  ])('"%s" (%s) holds no number', (text, language) => {
    expect(read(text, language)).toEqual([]);
  });

  it.each<[string, ClaimLanguage, string, number]>([
    ['La casa ha sei camere.', 'it', 'sei', 6],
    ['Al secondo piano.', 'it', 'secondo', 2],
    ['Al primo piano.', 'it', 'primo', 1],
    ['La prima camera da letto.', 'it', 'prima', 1],
    ['En el cuarto piso.', 'es', 'cuarto', 4],
    ['En la cuarta planta.', 'es', 'cuarta', 4],
    ['La segunda planta.', 'es', 'segunda', 2],
    ['Evde altı oda var.', 'tr', 'altı', 6],
  ])('"%s" (%s) reads "%s" as %d', (text, language, word, expected) => {
    expect(read(text, language)).toEqual([[word, value(expected)]]);
  });
});

describe('decades in it and es', () => {
  it.each<[string, ClaimLanguage, string]>([
    ["Costruita negli anni '90.", 'it', '90'],
    ['Costruita negli anni 90.', 'it', '90'],
    ['Costruita negli anni novanta.', 'it', 'novanta'],
    ['Construida en los años 80.', 'es', '80'],
    ["Construida en los años '80.", 'es', '80'],
    ['Construida en la década de los 70.', 'es', '70'],
  ])('%s (%s) reads %s as unreadable', (text, language, token) => {
    expect(read(text, language)).toEqual([[token, unreadable]]);
  });

  it('reads an elided article before a number as the number', () => {
    expect(read("Copre l'85% del fabbisogno.", 'it')).toEqual([['85%', value(85, '%')]]);
  });
});

describe('approximations and ranges in tr, it, and es', () => {
  function markers(text: string, language: ClaimLanguage) {
    return readNumbers(text, language).map((token) => ({
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
    ['yaklaşık 92 m²', 'tr', 'yaklaşık 92 m²'],
    ['Yaklaşık olarak 92 m²', 'tr', 'Yaklaşık olarak 92 m²'],
    ['en az 3 oda', 'tr', 'en az 3'],
    ['92 m² civarında', 'tr', '92 m² civarında'],
    ["10'dan fazla oda", 'tr', "10'dan fazla"],
    ['10 dakikadan fazla', 'tr', '10 dakikadan fazla'],
    ["100'e yakın", 'tr', "100'e yakın"],
    ['10 dakika kadar', 'tr', '10 dakika kadar'],
    ['200 m² altı', 'tr', '200 m² altı'],
    ['doksan küsur', 'tr', 'doksan küsur'],
    ['circa 90 mq', 'it', 'circa 90 mq'],
    ['90 mq circa', 'it', '90 mq circa'],
    ['oltre 90 mq', 'it', 'oltre 90 mq'],
    ['più di 3 camere', 'it', 'più di 3'],
    ['intorno ai 90 mq', 'it', 'intorno ai 90 mq'],
    ['fino a 4 camere', 'it', 'fino a 4'],
    ['unos 90 m²', 'es', 'unos 90 m²'],
    ['aproximadamente 90 m²', 'es', 'aproximadamente 90 m²'],
    ['más de 3 dormitorios', 'es', 'más de 3'],
    ['alrededor de 90 m²', 'es', 'alrededor de 90 m²'],
    ['treinta y pico años', 'es', 'treinta y pico'],
    ['± 92 m²', 'es', '± 92 m²'],
  ])('%s (%s) is approximate', (text, language, approximate) => {
    expect(markers(text, language)[0]?.approximate).toBe(approximate);
  });

  it.each<[string, ClaimLanguage, string]>([
    ['90-95 m²', 'tr', '90-95 m²'],
    ['90 ile 95 m²', 'tr', '90 ile 95 m²'],
    ['90 ila 95 m²', 'tr', '90 ila 95 m²'],
    ['2 veya 3 oda', 'tr', '2 veya 3'],
    ['iki üç oda', 'tr', 'iki üç'],
    ['da 2 a 3 camere', 'it', '2 a 3'],
    ['2 o 3 camere', 'it', '2 o 3'],
    ['tra 90 e 95 mq', 'it', '90 e 95 mq'],
    ['de 2 a 3 dormitorios', 'es', '2 a 3'],
    ['7 u 8 minutos', 'es', '7 u 8 minutos'],
    ['entre 90 y 95 m²', 'es', '90 y 95 m²'],
  ])('%s (%s) is a range', (text, language, range) => {
    expect(markers(text, language)[0]?.range).toBe(range);
  });

  it('does not read a list or a compound as a range', () => {
    expect(markers('34 m² e 7 m²', 'it').map((m) => m.range)).toEqual([null, null]);
    expect(markers('34 m² y 7 m²', 'es').map((m) => m.range)).toEqual([null, null]);
    expect(markers('92 m² 3 oda', 'tr').map((m) => m.range)).toEqual([null, null]);
    expect(markers('on iki oda', 'tr').map((m) => m.range)).toEqual([null]);
    // Turkish "3+1" (rooms plus living room) is two numbers, each a claim; neither is approximate.
    expect(markers('3+1 daire', 'tr')).toEqual([
      { approximate: null, range: null },
      { approximate: null, range: null },
    ]);
  });
});

describe('Italian "sei" is 6 unless a verb context is clear', () => {
  it.each<[string, [string, NumberReading][]]>([
    [
      'Da sei a otto camere.',
      [
        ['sei', value(6)],
        ['otto', value(8)],
      ],
    ],
    ['Le camere sono sei in totale.', [['sei', value(6)]]],
    ['Sono sei in tutto.', [['sei', value(6)]]],
    ['Ci sono sei camere al piano.', [['sei', value(6)]]],
    [
      'Sei camere e sei bagni.',
      [
        ['Sei', value(6)],
        ['sei', value(6)],
      ],
    ],
    ['Le sei camere hanno un balcone.', [['sei', value(6)]]],
  ])('%s', (text, expected) => {
    expect(read(text, 'it')).toEqual(expected);
  });

  it('keeps the range in "da sei a otto"', () => {
    const [first] = readNumbers('Da sei a otto camere.', 'it');
    expect(first?.rangeTo).toBe('Da sei a otto'.length);
  });

  it.each([
    'Se sei alla ricerca di una casa.',
    'Sei alla ricerca di luce?',
    'Sei pronto a trasferirti?',
    'Sei interessata a una visita?',
    'Tu sei il benvenuto.',
    'Dove sei adesso?',
  ])('reads no number in "%s"', (text) => {
    expect(read(text, 'it')).toEqual([]);
  });
});

describe('Italian elided tens', () => {
  it.each<[string, string, NumberReading]>([
    ["Ristrutturata vent'anni fa.", "vent'anni", value(20, 'year')],
    ['Ristrutturata vent’anni fa.', 'vent’anni', value(20, 'year')],
    ["Costruita trent'anni fa.", "trent'anni", value(30, 'year')],
    ["A quarant'anni dalla costruzione.", "quarant'anni", value(40, 'year')],
    ["Da cinquant'anni in famiglia.", "cinquant'anni", value(50, 'year')],
    ["Sessant'anni di storia.", "Sessant'anni", value(60, 'year')],
    ["Settant'anni.", "Settant'anni", value(70, 'year')],
    ["Ottant'anni.", "Ottant'anni", value(80, 'year')],
    ["Novant'anni.", "Novant'anni", value(90, 'year')],
    ["Un palazzo di cent'anni.", "cent'anni", unreadable],
  ])('%s', (text, token, expected) => {
    expect(read(text, 'it')).toEqual([[token, expected]]);
  });

  it('does not read other elisions', () => {
    expect(read("Dell'anno scorso, nell'ottobre, l'ottimo", 'it')).toEqual([]);
  });
});

describe('Turkish dotted and dotless i in capitals', () => {
  it.each<[string, string, number]>([
    ['YEDI oda', 'YEDI', 7],
    ['SEKIZ oda', 'SEKIZ', 8],
    ['YIRMI BIR yıl', 'YIRMI BIR yıl', 21],
    ['Iki yatak odası', 'Iki', 2],
    ['Ikinci kat', 'Ikinci', 2],
    ['İKİNCİ KAT', 'İKİNCİ', 2],
    ['ALTI oda', 'ALTI', 6],
    ['alti oda', 'alti', 6],
    ['KIRK yıl', 'KIRK yıl', 40],
  ])('%s', (text, token, expected) => {
    const [first] = read(text, 'tr');
    expect(first?.[0]).toBe(token);
    expect(first?.[1]).toMatchObject({ kind: 'value', value: expected });
  });

  it('folds the markers and units too', () => {
    expect(read('YAKLAŞIK 92 m²', 'tr')).toEqual([['92 m²', value(92, 'm2')]]);
    expect(readNumbers('YAKLAŞIK 92 m²', 'tr')[0]?.approximateFrom).toBe(0);
    expect(read('92 m² CİVARINDA', 'tr')).toEqual([['92 m² CİVARINDA', value(92, 'm2')]]);
    expect(read('15 YIL', 'tr')).toEqual([['15 YIL', value(15, 'year')]]);
  });
});

describe('joined Turkish and Spanish scale compounds', () => {
  it.each<[string, ClaimLanguage, string]>([
    ['ikiyüz metre', 'tr', 'ikiyüz metre'],
    ['yirmibeşbin TL', 'tr', 'yirmibeşbin TL'],
    ['üçyüz', 'tr', 'üçyüz'],
    ['binbeşyüz', 'tr', 'binbeşyüz'],
    ['dosmil euros', 'es', 'dosmil euros'],
    ['tresmil', 'es', 'tresmil'],
    ['miles de árboles', 'es', 'miles'],
  ])('%s (%s) is unreadable', (text, language, token) => {
    expect(read(text, language)).toEqual([[token, unreadable]]);
  });

  it('does not read words that only start like a number', () => {
    expect(read('bina, yüzme, binmek, yüzyıl, ikiz, onun', 'tr')).toEqual([]);
    expect(read('milla, Milano, diezmo, sendos, dosis', 'es')).toEqual([]);
  });
});

describe('Spanish "cuarto"', () => {
  it.each<[string, [string, NumberReading][]]>([
    ['El cuarto dormitorio da al jardín.', [['cuarto', value(4)]]],
    // Fail-closed: outside the fixed phrases "cuarto" is read, so "a room" can be a false flag.
    ['Un cuarto amplio y luminoso.', [['cuarto', value(4)]]],
    ['Un cuarto baño en la planta baja.', [['cuarto', value(4)]]],
    ['En el cuarto piso.', [['cuarto', value(4)]]],
    ['Las dos y cuarto.', [['dos', value(2)]]],
  ])('%s', (text, expected) => {
    expect(read(text, 'es')).toEqual(expected);
  });

  it.each([
    'El cuarto de baño tiene ducha.',
    'Un cuarto de estar amplio.',
    'A un cuarto de hora del centro.',
    'Hace un cuarto de siglo.',
    'Con cuarto trastero.',
    'Un cuarto de lavado.',
  ])('reads no number in "%s"', (text) => {
    expect(read(text, 'es')).toEqual([]);
  });
});

describe('more review cases', () => {
  it('reads "ó" as a Spanish range', () => {
    expect(readNumbers('2 ó 3 dormitorios', 'es')[0]?.rangeTo).toBe('2 ó 3'.length);
  });

  it('reads Turkish unit endings only from a list of real endings', () => {
    expect(read('2 yıldızlı otel', 'tr')).toEqual([['2', value(2)]]);
    expect(read('3 saatçi', 'tr')).toEqual([['3', value(3)]]);
    expect(read('15 yıllık', 'tr')).toEqual([['15 yıllık', value(15, 'year')]]);
    expect(read('10 yıldır', 'tr')).toEqual([['10 yıldır', value(10, 'year')]]);
    expect(read('10 yıllardır', 'tr')).toEqual([['10 yıllardır', value(10, 'year')]]);
    expect(read('3 saatte', 'tr')).toEqual([['3 saatte', value(3, 'hour')]]);
    expect(read('5 metreden', 'tr')).toEqual([['5 metreden', value(5, 'm')]]);
    expect(read('92 metrekareye', 'tr')).toEqual([['92 metrekareye', value(92, 'm2')]]);
    expect(read('10 dakikaya', 'tr')).toEqual([['10 dakikaya', value(10, 'minute')]]);
  });

  it.each<[string, ClaimLanguage, string]>([
    ['tre vani e mezzo', 'it', 'tre vani e mezzo'],
    ['2 bagni e mezzo', 'it', '2 bagni e mezzo'],
    ['tres habitaciones y media', 'es', 'tres habitaciones y media'],
    ['2 baños y medio', 'es', '2 baños y medio'],
  ])('reads a fraction after a noun, "%s" (%s), as unreadable', (text, language, token) => {
    expect(read(text, language)).toEqual([[token, unreadable]]);
  });

  it('reads the number when no fraction follows the noun', () => {
    expect(read('tre vani e un giardino', 'it')).toEqual([['tre', value(3)]]);
    expect(read('2 baños y medio jardín', 'es')).toEqual([['2 baños y medio', unreadable]]);
    expect(read('2 baños y mediana terraza', 'es')).toEqual([['2', value(2)]]);
  });

  it('never applies "bin" or "mil" outside the language that has them', () => {
    expect(read('3 bin', 'nl')).toEqual([['3', value(3)]]);
    expect(read('3 bin', 'es')).toEqual([['3', value(3)]]);
    expect(read('3 bin', 'it')).toEqual([['3', value(3)]]);
    expect(read('3 mil', 'nl')).toEqual([['3', value(3)]]);
    expect(read('3 mil', 'tr')).toEqual([['3', value(3)]]);
    expect(read('3 mil', 'it')).toEqual([['3', value(3)]]);
    expect(read('3 bin', 'tr')).toEqual([['3 bin', unreadable]]);
    expect(read('3 mil', 'es')).toEqual([['3 mil', unreadable]]);
  });

  it('reads long text in linear time (homograph context looks back a short window)', () => {
    const text = 'sei '.repeat(20_000);
    const started = performance.now();
    expect(readNumbers(text, 'it')).toHaveLength(20_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
