// Reading number claims out of copy text for the claim validator (docs/architecture.md §5
// "Claim validator (P3-02)"). Every number a buyer could read as a fact is a token: digits
// (with the language's separators, a currency sign, a unit, an ordinal suffix), number words
// and ordinal words, and dates and times. Anything that cannot be read as one exact value is a
// token too (`unreadable`), so the validator fails it instead of skipping it. The only spans
// that are not claims are on an explicit allowlist below. The reader is language-aware and
// deliberately strict: a false pass would put an unsupported number in front of a buyer, a
// false flag costs one revision or one Gate 2 decision.
//
// Turkish, Italian, and Spanish (tr, it, es) were added after en and nl without changing how en
// and nl text is read: every rule they need beyond the original two (their own unit spellings,
// scale words, apostrophe suffixes, space-grouped digits, homographs) lives in their own
// `LanguageRules`, and the en and nl rules point at the original shared patterns.

/** Languages with number rules. Copy in any other language cannot be validated. */
export const CLAIM_LANGUAGES = ['en', 'nl', 'tr', 'it', 'es'] as const;
export type ClaimLanguage = (typeof CLAIM_LANGUAGES)[number];

export function isClaimLanguage(language: string): language is ClaimLanguage {
  return CLAIM_LANGUAGES.some((supported) => supported === language);
}

export type NumberReading =
  /** An exact value; `unit` is canonical (see {@link canonicalUnit}) or null when none is written. */
  | { readonly kind: 'value'; readonly value: number; readonly unit: string | null }
  /** A date or time ("12-03-2024", "10:30"): supported only by a fact whose text contains it. */
  | { readonly kind: 'datetime' }
  /** Not one exact value in this language ("1,5" in English, "165k", "1980s", "2 million"). */
  | { readonly kind: 'unreadable' };

export interface NumberToken {
  /** Offsets into the text; `text.slice(start, end)` is the number with its unit and markers. */
  readonly start: number;
  readonly end: number;
  readonly reading: NumberReading;
  /** Offset of the approximation marker before the number ("about", "ca."), else null. */
  readonly approximateFrom: number | null;
  /** A trailing approximation marker ("95+", "90-ish") is part of the token. */
  readonly approximateSuffix: boolean;
  /** End offset of the second number when this one opens a range ("90-95"), else null. */
  readonly rangeTo: number | null;
}

// --- Units -----------------------------------------------------------------------------------

/**
 * Canonical unit → the ways copy and facts write it. Matching is case-insensitive; a unit
 * written in the text must have the cited fact's canonical unit.
 */
const UNIT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  m2: [
    'm2',
    'm²',
    'm^2',
    'sqm',
    'sq m',
    'sq. m',
    'square metre',
    'square metres',
    'square meter',
    'square meters',
    'vierkante meter',
    'vierkante meters',
  ],
  m3: [
    'm3',
    'm³',
    'm^3',
    'cubic metre',
    'cubic metres',
    'cubic meter',
    'cubic meters',
    'kubieke meter',
    'kubieke meters',
  ],
  m: ['m', 'metre', 'metres', 'meter', 'meters'],
  km: ['km', 'kilometre', 'kilometres', 'kilometer', 'kilometers'],
  cm: ['cm', 'centimetre', 'centimetres', 'centimeter', 'centimeters'],
  kWh: ['kwh'],
  kWp: ['kwp'],
  EUR: ['€', 'eur', 'euro', 'euros'],
  '%': ['%', 'percent', 'per cent', 'procent'],
  year: ['year', 'years', 'yr', 'yrs', 'jaar', 'jaren'],
  minute: ['minute', 'minutes', 'min', 'mins', 'minuut', 'minuten'],
  hour: ['hour', 'hours', 'hr', 'hrs', 'uur'],
};

function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/\s+/g, ' ');
}

const UNIT_BY_ALIAS: ReadonlyMap<string, string> = new Map(
  Object.entries(UNIT_ALIASES).flatMap(([canonical, aliases]) =>
    aliases.map((alias) => [alias, canonical] as const),
  ),
);

/**
 * A fact's or the text's unit in canonical form: a known alias maps to its canonical unit, any
 * other unit is compared as written (lowercased), so an unknown fact unit never matches a known
 * text unit by accident.
 */
export function canonicalUnit(unit: string): string {
  const normalized = normalizeUnit(unit);
  return (
    UNIT_BY_ALIAS.get(normalized) ?? FACT_UNIT_BY_ALIAS.get(normalized) ?? `other:${normalized}`
  );
}

/**
 * Fact units outside the shared table that still have a canonical form. They are kept apart from
 * `UNIT_ALIASES` because that table also decides how en and nl text is read; a text unit in
 * these spellings only exists in the language that writes it (Turkish "TL", "₺").
 */
const FACT_UNIT_BY_ALIAS: ReadonlyMap<string, string> = new Map([
  ['try', 'TRY'],
  ['tl', 'TRY'],
  ['₺', 'TRY'],
  ['türk lirası', 'TRY'],
]);

/**
 * The unit a fact without a unit field carries in its key's last word
 * (`other:station_cycling_time_minutes` → `minute`), else null. Extraction often puts the unit
 * into free-text keys; without this, "10 minutes" against such a fact would be a unit mismatch.
 */
export function unitOfKey(key: string): string | null {
  const name = key.startsWith('other:') ? key.slice('other:'.length) : key;
  const last = name.split('_').at(-1) ?? '';
  return UNIT_BY_ALIAS.get(last.toLowerCase()) ?? null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SPACED_UNIT = new RegExp(
  `^\\s*(${[...UNIT_BY_ALIAS.keys()]
    .sort((a, b) => b.length - a.length)
    .map((alias) => escapeRegExp(alias).replace(/ /g, '\\s+'))
    .join('|')})(?![\\p{L}\\p{N}])`,
  'iu',
);

// --- Language rules --------------------------------------------------------------------------

/** How a language reads letters or a symbol glued to digits ("2nd", "92m²", "1990'lı"). */
type GluedReading =
  | { readonly kind: 'ordinal' }
  | { readonly kind: 'unit'; readonly unit: string }
  /** A grammatical ending that leaves the number as it is (Turkish "1990'da", "3'ü"). */
  | { readonly kind: 'value' }
  | { readonly kind: 'unreadable' };

interface LanguageRules {
  readonly group: string;
  readonly decimal: string;
  readonly ordinalSuffixes: ReadonlySet<string>;
  /** Lowercase word → value (cardinals, ordinals, and a few fixed quantities). */
  readonly words: ReadonlyMap<string, number>;
  /** Approximate wording directly before a number (anchored at the end of the preceding text). */
  readonly approximateBefore: RegExp;
  readonly approximateAfter: RegExp;
  /** The text between two numbers that makes them a range. */
  readonly rangeGap: RegExp;
  /** "between X and Y" / "tussen X en Y": the gap word and the word before X. */
  readonly betweenGap: RegExp;
  readonly betweenBefore: RegExp;
  /** Lowercase unit spelling in this language's text → canonical unit. */
  readonly units: ReadonlyMap<string, string>;
  /** A unit after whitespace; group 1 (or 2) is the spelling as written. */
  readonly spacedUnit: RegExp;
  /**
   * Digits: a unit written before them (group 1), a stray leading separator (2), the digits
   * (3), and the Dutch ",-" (4).
   */
  readonly digits: RegExp;
  /** The canonical unit of a prefix captured by `digits` ("€", "%", "yüzde"). */
  readonly prefixUnit: (prefix: string) => string;
  /** Letters or a symbol glued to the digits, read by `readGlued`. */
  readonly gluedTail: RegExp;
  readonly readGlued: (glued: string, rules: LanguageRules) => GluedReading;
  /** A scale or fraction word after a number ("2 million", "due e mezzo") makes it unreadable. */
  readonly multiplierAfter: RegExp;
  /** Thousands grouped with a space ("250 000") are one number. */
  readonly spaceGroups: boolean;
  /**
   * A length-preserving case fold applied before reading (Turkish dotted and dotless i: "İki"
   * must read as "iki", which the regex `i` flag does not do).
   */
  readonly fold?: (text: string) => string;
  /** A unit written before a number word ("yüzde yirmi"); digits take theirs from `digits`. */
  readonly wordPrefix?: { readonly pattern: RegExp; readonly unit: string };
  /** Wording before a number that makes it a decade ("anni '90", "años 80"): unreadable. */
  readonly decadeBefore?: RegExp;
  /**
   * A word from `words` that is another word here (Italian "se sei" = "if you are"). `before`
   * and `after` have allowlisted names and digits blanked; `named` is `after` with them kept.
   */
  readonly skipWord?: (word: string, before: string, after: string, named: string) => boolean;
  /** Two number words with only a space between them are a range (Turkish "iki üç oda"). */
  readonly juxtaposedWordRange?: boolean;
  /** A fraction after the counted noun makes the number unreadable ("tre vani e mezzo"). */
  readonly fractionAfterNoun?: RegExp;
}

const SYMBOL_APPROXIMATION = String.raw`(?:±|~|≈|\+\/-|\+-)\s*$`;

interface WordTableSpec {
  /** 0–19, with '' for words left out on purpose (see the language tables). */
  readonly units: readonly string[];
  /** 20, 30, ..., 90. */
  readonly tens: readonly string[];
  /** The words for 1–9 inside a compound (index 0 unused). */
  readonly compoundUnits: readonly string[];
  readonly compound: (unit: string, ten: string) => readonly string[];
  /** first, second, ...: ordinal words read as their cardinal value. */
  readonly ordinals: readonly string[];
  readonly extra: Readonly<Record<string, number>>;
}

function wordTable(spec: WordTableSpec): ReadonlyMap<string, number> {
  const { units, tens, compoundUnits, compound, ordinals, extra } = spec;
  const table = new Map<string, number>();
  units.forEach((word, value) => {
    if (word !== '') table.set(word, value);
  });
  tens.forEach((ten, i) => {
    const tenValue = (i + 2) * 10;
    table.set(ten, tenValue);
    for (let unit = 1; unit <= 9; unit += 1) {
      for (const form of compound(compoundUnits[unit] ?? '', ten)) {
        table.set(form, tenValue + unit);
      }
    }
  });
  ordinals.forEach((word, i) => table.set(word, i + 1));
  for (const [word, value] of Object.entries(extra)) table.set(word, value);
  return table;
}

/** Gendered ordinal forms: `forms[i]` are the words for i + 1. */
function ordinalWords(forms: readonly (readonly string[])[]): Record<string, number> {
  return Object.fromEntries(forms.flatMap((words, i) => words.map((word) => [word, i + 1])));
}

const EN_UNITS = [
  'zero',
  '', // "one" is left out: it is mostly a pronoun ("one of the bedrooms", "no one")
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const EN_TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const EN_ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
  'fifteenth',
  'sixteenth',
  'seventeenth',
  'eighteenth',
  'nineteenth',
  'twentieth',
];
const EN_WORDS = wordTable({
  units: EN_UNITS,
  tens: EN_TENS,
  compoundUnits: ['', 'one', ...EN_UNITS.slice(2, 10)],
  compound: (unit, ten) => [`${ten}-${unit}`],
  ordinals: EN_ORDINALS,
  extra: { pair: 2, dozen: 12 },
});

const NL_UNITS = [
  'nul',
  '', // "een" is left out: it is the indefinite article; the stressed "één"/"eén" is read
  'twee',
  'drie',
  'vier',
  'vijf',
  'zes',
  'zeven',
  'acht',
  'negen',
  'tien',
  'elf',
  'twaalf',
  'dertien',
  'veertien',
  'vijftien',
  'zestien',
  'zeventien',
  'achttien',
  'negentien',
];
const NL_TENS = [
  'twintig',
  'dertig',
  'veertig',
  'vijftig',
  'zestig',
  'zeventig',
  'tachtig',
  'negentig',
];
const NL_ORDINALS = [
  'eerste',
  'tweede',
  'derde',
  'vierde',
  'vijfde',
  'zesde',
  'zevende',
  'achtste',
  'negende',
  'tiende',
  'elfde',
  'twaalfde',
  'dertiende',
  'veertiende',
  'vijftiende',
  'zestiende',
  'zeventiende',
  'achttiende',
  'negentiende',
  'twintigste',
];
const NL_WORDS = wordTable({
  units: NL_UNITS,
  tens: NL_TENS,
  compoundUnits: ['', 'een', ...NL_UNITS.slice(2, 10)],
  // "eenentwintig", "tweeëntwintig" (the diaeresis is standard after -e; both spellings read).
  compound: (unit, ten) => [`${unit}en${ten}`, `${unit}ën${ten}`],
  ordinals: NL_ORDINALS,
  extra: { één: 1, eén: 1, anderhalf: 1.5, anderhalve: 1.5, dozijn: 12 },
});

const TR_UNITS = [
  'sıfır',
  '', // "bir" is left out: it is also the indefinite article ("bir balkon")
  'iki',
  'üç',
  'dört',
  'beş',
  'altı', // also "bottom"/"under": read as 6, and as an approximation after a number ("200 m² altı")
  'yedi',
  'sekiz',
  'dokuz',
  'on',
];
const TR_TENS = ['yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'];
const TR_DIGIT_WORDS = ['', 'bir', ...TR_UNITS.slice(2, 10)];
const TR_DIGIT_ORDINALS = [
  '',
  'birinci',
  'ikinci',
  'üçüncü',
  'dördüncü',
  'beşinci',
  'altıncı',
  'yedinci',
  'sekizinci',
  'dokuzuncu',
];
const TR_WORDS = wordTable({
  units: TR_UNITS,
  tens: TR_TENS,
  compoundUnits: TR_DIGIT_WORDS,
  // Compounds are written apart ("yirmi bir"); the joined form ("yirmibir") is common too.
  compound: (unit, ten) => [`${ten} ${unit}`, `${ten}${unit}`],
  ordinals: [],
  extra: {
    ...Object.fromEntries(
      TR_DIGIT_WORDS.slice(1).flatMap((unit, i) => [
        [`on ${unit}`, 11 + i],
        [`on${unit}`, 11 + i],
      ]),
    ),
    ...Object.fromEntries(TR_DIGIT_ORDINALS.slice(1).map((word, i) => [word, i + 1])),
    onuncu: 10,
    ...Object.fromEntries(TR_DIGIT_ORDINALS.slice(1).map((word, i) => [`on ${word}`, 11 + i])),
    yirminci: 20,
    // Possessive forms that state a count ("banyoların ikisi"); "onu" is left out (a pronoun).
    ikisi: 2,
    üçü: 3,
    dördü: 4,
    beşi: 5,
    altısı: 6,
    yedisi: 7,
    sekizi: 8,
    dokuzu: 9,
  },
});

const IT_UNITS = [
  'zero',
  '', // "un", "uno", "una" are left out: they are the indefinite article
  'due',
  'tre',
  'quattro',
  'cinque',
  'sei', // also "you are": see `skipItalian`
  'sette',
  'otto',
  'nove',
  'dieci',
  'undici',
  'dodici',
  'tredici',
  'quattordici',
  'quindici',
  'sedici',
  'diciassette',
  'diciotto',
  'diciannove',
];
const IT_TENS = [
  'venti',
  'trenta',
  'quaranta',
  'cinquanta',
  'sessanta',
  'settanta',
  'ottanta',
  'novanta',
];
/** Singular forms only: plurals ("i primi anni", "diritti di terzi") rarely state one number. */
const IT_ORDINALS = [
  ['primo', 'prima'],
  ['secondo', 'seconda'],
  ['terzo', 'terza'],
  ['quarto', 'quarta'],
  ['quinto', 'quinta'],
  ['sesto', 'sesta'],
  ['settimo', 'settima'],
  ['ottavo', 'ottava'],
  ['nono', 'nona'],
  ['decimo', 'decima'],
  ['undicesimo', 'undicesima'],
  ['dodicesimo', 'dodicesima'],
  ['tredicesimo', 'tredicesima'],
  ['quattordicesimo', 'quattordicesima'],
  ['quindicesimo', 'quindicesima'],
  ['sedicesimo', 'sedicesima'],
  ['diciassettesimo', 'diciassettesima'],
  ['diciottesimo', 'diciottesima'],
  ['diciannovesimo', 'diciannovesima'],
  ['ventesimo', 'ventesima'],
];
const IT_WORDS = wordTable({
  units: IT_UNITS,
  tens: IT_TENS,
  compoundUnits: ['', 'uno', ...IT_UNITS.slice(2, 10)],
  // A ten drops its last vowel before "uno" and "otto" ("ventuno", "ventotto"); "ventun" stands
  // before a noun; "ventitré" is often written without the accent.
  compound: (unit, ten) => {
    const elided = ten.slice(0, -1);
    if (unit === 'uno') return [`${elided}uno`, `${elided}un`, `${elided}una`];
    if (unit === 'otto') return [`${elided}otto`];
    if (unit === 'tre') return [`${ten}tré`, `${ten}tre`];
    return [`${ten}${unit}`];
  },
  ordinals: [],
  extra: {
    ...ordinalWords(IT_ORDINALS),
    // The listing terms for an apartment's room count state that count.
    monolocale: 1,
    monolocali: 1,
    bilocale: 2,
    bilocali: 2,
    trilocale: 3,
    trilocali: 3,
    quadrilocale: 4,
    quadrilocali: 4,
    pentalocale: 5,
    pentalocali: 5,
    // Tens elided before a vowel ("vent'anni", "trent'anni"): the apostrophe ends the word.
    ...Object.fromEntries(
      IT_TENS.flatMap((ten, i) => [
        [`${ten.slice(0, -1)}'`, (i + 2) * 10],
        [`${ten.slice(0, -1)}’`, (i + 2) * 10],
      ]),
    ),
  },
});

const ES_UNITS = [
  'cero',
  '', // "un", "uno", "una" are left out: they are the indefinite article
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
];
const ES_TENS = [
  'veinte',
  'treinta',
  'cuarenta',
  'cincuenta',
  'sesenta',
  'setenta',
  'ochenta',
  'noventa',
];
const ES_VEINTI: Readonly<Record<string, readonly string[]>> = {
  uno: ['veintiuno', 'veintiún', 'veintiun', 'veintiuna'],
  dos: ['veintidós', 'veintidos'],
  tres: ['veintitrés', 'veintitres'],
  seis: ['veintiséis', 'veintiseis'],
};
const ES_ORDINALS = [
  ['primero', 'primera', 'primer'],
  ['segundo', 'segunda'],
  ['tercero', 'tercera', 'tercer'],
  ['cuarto', 'cuarta'], // "cuarto" is mostly "room": see `skipSpanish`
  ['quinto', 'quinta'],
  ['sexto', 'sexta'],
  ['séptimo', 'séptima', 'septimo', 'septima'],
  ['octavo', 'octava'],
  ['noveno', 'novena'],
  ['décimo', 'décima', 'decimo', 'decima'],
  ['undécimo', 'undécima', 'undecimo', 'undecima'],
  ['duodécimo', 'duodécima', 'duodecimo', 'duodecima'],
  ['decimotercero', 'decimotercera', 'decimotercer'],
  ['decimocuarto', 'decimocuarta'],
  ['decimoquinto', 'decimoquinta'],
  ['decimosexto', 'decimosexta'],
  ['decimoséptimo', 'decimoséptima', 'decimoseptimo', 'decimoseptima'],
  ['decimoctavo', 'decimoctava'],
  ['decimonoveno', 'decimonovena'],
  ['vigésimo', 'vigésima', 'vigesimo', 'vigesima'],
];
const ES_WORDS = wordTable({
  units: ES_UNITS,
  tens: ES_TENS,
  compoundUnits: ['', 'uno', ...ES_UNITS.slice(2, 10)],
  // 21–29 are one word ("veintidós"); from 31 on "treinta y uno", with "un"/"una" before a noun.
  compound: (unit, ten) => {
    if (ten === 'veinte') return ES_VEINTI[unit] ?? [`veinti${unit}`];
    if (unit === 'uno') return [`${ten} y uno`, `${ten} y un`, `${ten} y una`];
    return [`${ten} y ${unit}`];
  },
  ordinals: [],
  extra: { ...ordinalWords(ES_ORDINALS), dieciseis: 16 },
});

// --- Patterns shared by en and nl, and per-language variants ----------------------------------

/** Words that scale a number ("2 million", "honderd"): the copy must write the full value. */
const MULTIPLIER = String.raw`(?:hundred|thousand|million|billion|honderd|duizend|miljoen|miljard|mln\.?|mrd\.?)`;
const MULTIPLIER_AFTER = new RegExp(String.raw`^\s*${MULTIPLIER}(?![\p{L}\p{N}])`, 'iu');

/**
 * Italian writes numbers as one word ("duecento", "tremila", "centocinquanta"): any word built
 * from number stems that contains a scale is a scale word.
 */
const IT_NUMBER_STEMS = String.raw`(?:un|uno|una|due|tre|tré|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove|venti|vent|trenta|trent|quaranta|quarant|cinquanta|cinquant|sessanta|sessant|settanta|settant|ottanta|ottant|novanta|novant)`;
const IT_SCALES = String.raw`(?:cento|cent['’]|mille|mila|milioni|milione|miliardi|miliardo)`;
/** Turkish and Spanish one-word compounds ("ikiyüz", "yirmibeşbin", "dosmil") likewise. */
const TR_NUMBER_STEMS = String.raw`(?:bir|iki|üç|dört|beş|altı|yedi|sekiz|dokuz|on|yirmi|otuz|kırk|elli|altmış|yetmiş|seksen|doksan)`;
const TR_SCALES = String.raw`(?:yüz|bin|milyon|milyar|trilyon)`;
const ES_NUMBER_STEMS = String.raw`(?:un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieci(?:séis|seis|siete|ocho|nueve)|veinte|veinti(?:uno|ún|un|una|dós|dos|trés|tres|cuatro|cinco|séis|seis|siete|ocho|nueve)|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)`;
const ES_SCALES = String.raw`(?:mil|millón|millon|millones|millardos?|billón|billones|cien|cientos?|(?:dos|tres|cuatro|seis|sete|ocho|nove)cient[oa]s|quinient[oa]s)`;
function stacked(stems: string, scales: string): string {
  return String.raw`${stems}*${scales}(?:${stems}|${scales})*`;
}
const MULTIPLIERS: Readonly<Record<'tr' | 'it' | 'es', string>> = {
  tr: String.raw`(?:${MULTIPLIER}|${stacked(TR_NUMBER_STEMS, TR_SCALES)})`,
  it: String.raw`(?:${MULTIPLIER}|${stacked(IT_NUMBER_STEMS, IT_SCALES)}|mld\.?)`,
  es: String.raw`(?:${MULTIPLIER}|${stacked(ES_NUMBER_STEMS, ES_SCALES)}|mill\.)`,
};
/** Fractions after a number ("iki buçuk", "due e mezzo", "dos y medio"): not one exact value. */
const FRACTIONS_AFTER: Readonly<Record<'tr' | 'it' | 'es', string>> = {
  tr: 'buçuk',
  it: String.raw`e\s+mezz[oa]`,
  es: String.raw`y\s+medi[oa]`,
};
/** The same fraction after the counted noun ("tre vani e mezzo", "2 baños y medio"). */
const FRACTIONS_AFTER_NOUN: Readonly<Record<'it' | 'es', RegExp>> = {
  it: /^\s+\p{L}+\s+e\s+mezz[oa](?![\p{L}\p{N}])/iu,
  es: /^\s+\p{L}+\s+y\s+medi[oa](?![\p{L}\p{N}])/iu,
};
/**
 * Collective and vague quantity words, read as unreadable wherever they stand ("una ventina",
 * "una docena", "onlarca"): they put a number in front of a buyer without stating it.
 */
const COLLECTIVES: Readonly<Record<'tr' | 'it' | 'es', string>> = {
  tr: '(?:onlarca|yüzlerce|binlerce|milyonlarca|düzinelerce|düzine|buçuk)',
  it: '(?:decin[ae]|dozzin[ae]|quindicin[ae]|ventin[ae]|trentin[ae]|quarantin[ae]|cinquantin[ae]|sessantin[ae]|settantin[ae]|ottantin[ae]|novantin[ae]|centinai[oa]|migliai[oa]|pai[oa]|plurilocal[ei])',
  es: '(?:decenas?|docenas?|veintenas?|treintenas?|quincenas?|centenar(?:es)?|millar(?:es)?|miles)',
};

function multiplierAfter(language: 'tr' | 'it' | 'es'): RegExp {
  return new RegExp(
    String.raw`^\s*(?:${MULTIPLIERS[language]}|${FRACTIONS_AFTER[language]})(?![\p{L}\p{N}])`,
    'iu',
  );
}

/** Digits, with an optional leading currency, a leading stray separator, and the Dutch ",-". */
const DIGITS =
  /(?<![\p{L}\p{N}])(?:(€|eur(?:os?)?)\s?)?([.,])?(\d+(?:[.,]\d+)*)(,[-–—](?![\p{N}]))?/giu;

/** The space characters that group thousands: space, no-break space, narrow and thin space. */
const GROUP_SPACE = /[ \u00A0\u202F\u2009]/gu;

/**
 * `DIGITS` with more prefixes, and with space-grouped thousands ("250 000", the form the RAE
 * and SI recommend) read as one number instead of two.
 */
function digitsPattern(prefixes: string): RegExp {
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:(${prefixes})\s?)?([.,])?(\d{1,3}(?:[ \u00A0\u202F\u2009]\d{3})+(?:[.,]\d+)?(?![\p{N}])|\d+(?:[.,]\d+)*)(,[-–—](?![\p{N}]))?`,
    'giu',
  );
}

const GLUED_TAIL = /^(?:\p{L}[\p{L}\p{N}²³]*|[²³€%])/u;
/** Spanish and Italian also write the ordinal indicator after a dot ("1.º", "3.ª"). */
const GLUED_TAIL_ORDINAL_DOT = /^(?:\.[ºª]|\p{L}[\p{L}\p{N}²³]*|[²³€%])/u;
/** Turkish puts endings after an apostrophe ("1990'da", "3'üncü", "m²'lik"). */
const GLUED_TAIL_TR = /^(?:['’]\p{L}+|\p{L}[\p{L}\p{N}²³]*(?:['’]\p{L}+)?|[²³€%₺](?:['’]\p{L}+)?)/u;

function readGluedDefault(glued: string, rules: LanguageRules): GluedReading {
  const lower = glued.toLowerCase();
  const alias = rules.units.get(lower);
  if (rules.ordinalSuffixes.has(lower)) return { kind: 'ordinal' };
  if (alias !== undefined) return { kind: 'unit', unit: alias };
  return { kind: 'unreadable' };
}

function readGluedOrdinalDot(glued: string, rules: LanguageRules): GluedReading {
  return readGluedDefault(glued.startsWith('.') ? glued.slice(1) : glued, rules);
}

/**
 * A Turkish ending after the apostrophe: ordinal ("3'üncü", "2'nci"), a set or a decade
 * ("1990'lı", "1990'lar", "3'lü") is not one exact value, anything else is a case ending that
 * leaves the number as written ("1990'da", "10'dan", "92'lik").
 */
function readGluedTurkish(glued: string, rules: LanguageRules): GluedReading {
  const apostrophe = /['’]/u.exec(glued);
  if (apostrophe === null) return readGluedDefault(glued, rules);
  if (apostrophe.index > 0) return readGluedDefault(glued.slice(0, apostrophe.index), rules);
  const suffix = glued.slice(1).toLowerCase();
  if (/^[ıiuü]?nc[ıiuü]/u.test(suffix)) return { kind: 'ordinal' };
  if (/^l[ıiuü]k/u.test(suffix)) return { kind: 'value' };
  if (/^l[ıiuü]|^l[ae]r/u.test(suffix)) return { kind: 'unreadable' };
  return { kind: 'value' };
}

/**
 * Unit spellings per language on top of the shared ones. They change only how that language's
 * text is read; fact units and key words keep the shared table. The Turkish lira is `TRY`, as
 * `canonicalUnit` reads a fact's `TRY`, `TL`, or `₺`. Turkish spellings are written in their
 * folded form (see {@link foldTurkish}).
 */
const LANGUAGE_UNIT_ALIASES: Readonly<
  Record<'tr' | 'it' | 'es', Readonly<Record<string, readonly string[]>>>
> = {
  tr: {
    m2: ['metrekare', 'metre kare'],
    m3: ['metreküp', 'metre küp'],
    cm: ['santimetre', 'santim'],
    EUR: ['avro'],
    TRY: ['try', 'tl', '₺', 'lira', 'türk lirasi'],
    year: ['yil', 'sene'],
    minute: ['dakika', 'dk'],
    hour: ['saat'],
  },
  it: {
    m2: ['mq', 'm.q.', 'metro quadro', 'metro quadrato', 'metri quadri', 'metri quadrati'],
    m3: ['mc', 'metro cubo', 'metri cubi'],
    m: ['metro', 'metri'],
    km: ['chilometro', 'chilometri'],
    cm: ['centimetro', 'centimetri'],
    '%': ['per cento', 'percento'],
    year: ['anno', 'anni'],
    minute: ['minuto', 'minuti'],
    hour: ['ora', 'ore'],
  },
  es: {
    m2: ['metro cuadrado', 'metros cuadrados'],
    m3: ['metro cúbico', 'metros cúbicos', 'metro cubico', 'metros cubicos'],
    m: ['metro', 'metros'],
    km: ['kilómetro', 'kilómetros'],
    cm: ['centímetro', 'centímetros'],
    '%': ['por ciento'],
    year: ['año', 'años'],
    minute: ['minuto', 'minutos'],
    hour: ['hora', 'horas'],
  },
};

function unitAlternatives(aliases: readonly string[]): string {
  return [...aliases]
    .sort((a, b) => b.length - a.length)
    .map((alias) => escapeRegExp(alias).replace(/ /g, '\\s+'))
    .join('|');
}

/**
 * Turkish endings a unit word takes (folded: "ı" is "i"), up to three in a row: "-lık"
 * (`dakikalık`), case endings (`metreden`, `saatte`, `metrekareye`), plural and possessive
 * (`yıllardır`, `senesi`), "-ki" (`yıldaki`). A listed ending, not any letters: `yıldızlı`
 * (starred) is not a year.
 */
const TR_UNIT_ENDING = String.raw`(?:l[iuü]k|l[iuü]ğ[iuü]|l[ae]r|[dt][ae]n?|[dt][iuü]r|y?[ae]|y?[iuü]|n?[iuü]n|n[ae]|s[iuü]|y?l[ae]|k[iuü])`;

/**
 * The language's unit table and spaced-unit pattern. With `suffixed`, those spellings may carry
 * Turkish endings (`TR_UNIT_ENDING`), and every spelling one after an apostrophe ("km'lik",
 * "m²'den"), so a Turkish unit with an ending is still read as that unit.
 */
function unitRules(
  language: 'tr' | 'it' | 'es',
  suffixed?: (alias: string) => boolean,
): Pick<LanguageRules, 'units' | 'spacedUnit'> {
  const units = new Map(UNIT_BY_ALIAS);
  for (const [canonical, aliases] of Object.entries(LANGUAGE_UNIT_ALIASES[language])) {
    for (const alias of aliases) units.set(alias, canonical);
  }
  const all = [...units.keys()];
  if (suffixed === undefined) {
    return {
      units,
      spacedUnit: new RegExp(`^\\s*(${unitAlternatives(all)})(?![\\p{L}\\p{N}])`, 'iu'),
    };
  }
  const words = all.filter(suffixed);
  const others = all.filter((alias) => !suffixed(alias));
  return {
    units,
    spacedUnit: new RegExp(
      String.raw`^\s*(?:(${unitAlternatives(words)})(?:['’]\p{L}+|${TR_UNIT_ENDING}{0,3})|(${unitAlternatives(others)})(?:['’]\p{L}+)?)(?![\p{L}\p{N}])`,
      'iu',
    ),
  };
}

/** Unit words that take a glued Turkish ending (folded spellings). */
const TR_SUFFIXED_UNITS: ReadonlySet<string> = new Set([
  'metrekare',
  'metre kare',
  'metreküp',
  'metre küp',
  'metre',
  'kilometre',
  'santimetre',
  'santim',
  'euro',
  'avro',
  'lira',
  'türk lirasi',
  'yil',
  'sene',
  'dakika',
  'saat',
]);

function turkishSuffixedUnit(alias: string): boolean {
  return TR_SUFFIXED_UNITS.has(alias);
}

const NEVER = /(?!)/u;

/** The word that ends `before`, lowercased; '' after punctuation or at the start. */
function previousWord(before: string): string {
  return /(\p{L}+)\s*$/u.exec(before)?.[1]?.toLowerCase() ?? '';
}

/** The word that starts `after` (with an elision apostrophe: "d'"), lowercased; '' if none. */
function nextWord(after: string): string {
  return /^\s*(\p{L}+['’]?)/u.exec(after)?.[1]?.toLowerCase().replace('’', "'") ?? '';
}

/**
 * "se sei", "tu sei", "dove sei": the verb "you are", not 6. Fail-closed: "sei" is 6 unless one
 * of these words stands right before it or a fixed verb phrase follows it.
 */
const IT_SEI_VERB_BEFORE = new Set([
  'se',
  'tu',
  'non',
  'ci',
  'dove',
  'come',
  'quando',
  'perché',
  'mai',
]);
/** "sei alla ricerca", "sei pronto", "sei interessata": phrases only the verb starts. */
const IT_SEI_VERB_PHRASE =
  /^\s+(?:alla\s+ricerca|in\s+cerca|pront[oaie]|interessat[oaie]|stanc[oa]|stanch[ie]|sicur[oaie]|curios[oaie]|appassionat[oaie]|innamorat[oaie]|benvenut[oaie]|un\s+amante|un['’]amante|nel\s+posto\s+giusto)(?![\p{L}\p{N}])/iu;
/** "secondo il catasto", "secondo me", "secondo norma": the preposition "according to". */
const IT_SECONDO_PREPOSITION_AFTER = new Set([
  'norma',
  'norme',
  'normativa',
  'il',
  'lo',
  'la',
  "l'",
  'i',
  'gli',
  'le',
  'un',
  "un'",
  'uno',
  'una',
  'me',
  'te',
  'noi',
  'voi',
  'lui',
  'lei',
  'loro',
  'quanto',
  'cui',
  'questo',
  'questa',
  'quello',
  'quella',
  'alcuni',
  'molti',
  'tutti',
]);
/**
 * "secondo NEN 2580", "secondo UNI 10750": "according to" before a standard's name, never an
 * ordinal (Spark wrote "92 m² secondo NEN 2580" in the first recorded Italian Q&A cards). Read
 * from the text with names kept: the allowlist blanks "NEN 2580" out of `after`.
 */
const IT_SECONDO_STANDARD_AFTER = /^\s+(?:NEN|ISO|UNI|EN|DIN)(?:[\s-]|$)/u;
/** "prima di", "prima che", "prima casa" (a tax status), "prima volta": not a stated count. */
const IT_PRIMA_OTHER_AFTER = new Set([
  'di',
  "d'",
  'del',
  'dello',
  'della',
  'dei',
  'degli',
  'delle',
  "dell'",
  'che',
  'o',
  'ancora',
  'casa',
  'mano',
  'volta',
]);

/** Italian homographs of number words; everything else in the table is read. */
function skipItalian(word: string, before: string, after: string, named: string): boolean {
  const next = nextWord(after);
  switch (word) {
    case 'sei':
      return IT_SEI_VERB_BEFORE.has(previousWord(before)) || IT_SEI_VERB_PHRASE.test(after);
    case 'secondo':
      return IT_SECONDO_PREPOSITION_AFTER.has(next) || IT_SECONDO_STANDARD_AFTER.test(named);
    case 'prima':
      // At the end of a clause "prima" is the adverb "before".
      return next === '' || IT_PRIMA_OTHER_AFTER.has(next);
    case 'seconda':
      return next === 'casa' || next === 'mano';
    case 'quarto':
      return next === "d'"; // "un quarto d'ora"
    default:
      return false;
  }
}

/** "primera línea (de playa)", "primera vivienda", "de segunda mano": names, not a count. */
const ES_PRIMERA_IDIOM_AFTER = new Set([
  'línea',
  'linea',
  'vivienda',
  'residencia',
  'mano',
  'vista',
  'calidad',
]);
const ES_SEGUNDA_IDIOM_AFTER = new Set(['mano', 'vivienda', 'residencia']);
/**
 * "cuarto" is 4 ("cuarto dormitorio", "cuarto piso") except in the fixed phrases where it is a
 * room or a quarter: "cuarto de baño", "cuarto de estar", "cuarto de hora", "cuarto trastero",
 * and "y cuarto" / "menos cuarto" in a time.
 */
const ES_CUARTO_PHRASE =
  /^\s+(?:de\s+(?:baño|baños|aseo|estar|hora|siglo|lavado|plancha|servicio|juegos|invitados|huéspedes|huespedes|máquinas|maquinas|calderas|contadores|herramientas|basuras|instalaciones)|trastero|oscuro)(?![\p{L}\p{N}])/iu;
const ES_CUARTO_TIME_BEFORE = new Set(['y', 'menos']);

/** Spanish homographs of number words; everything else in the table is read. */
function skipSpanish(word: string, before: string, after: string): boolean {
  const next = nextWord(after);
  switch (word) {
    case 'primera':
      return ES_PRIMERA_IDIOM_AFTER.has(next);
    case 'segunda':
      return ES_SEGUNDA_IDIOM_AFTER.has(next);
    case 'cuarto':
      return ES_CUARTO_PHRASE.test(after) || ES_CUARTO_TIME_BEFORE.has(previousWord(before));
    default:
      return false;
  }
}

/**
 * Turkish fold for matching, keeping every offset: "İ", "I", and "ı" all read as "i". Copy and
 * capitals mix them ("YEDI", "Iki", "İKİNCİ", "alti"), and no number word or marker differs from
 * another only in the dot. Every Turkish word list and pattern is folded the same way.
 */
export function foldTurkish(text: string): string {
  return text.replace(/[İIı]/g, 'i');
}

/** A Turkish pattern with its spellings folded like the text. */
function turkishPattern(pattern: RegExp): RegExp {
  return new RegExp(foldTurkish(pattern.source), pattern.flags);
}

/** Folds a word table's keys. */
function foldedWords(words: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  return new Map([...words].map(([word, value]) => [foldTurkish(word), value]));
}

const EUR_PREFIX = String.raw`€|eur(?:os?)?`;

const TR_FOLDED_WORDS = foldedWords(TR_WORDS);

const RULES: Readonly<Record<ClaimLanguage, LanguageRules>> = {
  en: {
    group: ',',
    decimal: '.',
    ordinalSuffixes: new Set(['st', 'nd', 'rd', 'th']),
    words: EN_WORDS,
    approximateBefore: new RegExp(
      String.raw`(?:(?<![\p{L}\p{N}])(?:about|approximately|approx\.?|around|roughly|circa|ca\.?|nearly|almost|some|close\s+to|more\s+than|less\s+than|fewer\s+than|at\s+least|at\s+most|up\s+to|just\s+over|just\s+under|well\s+over|upwards\s+of|in\s+excess\s+of)\s*$)|${SYMBOL_APPROXIMATION}`,
      'iu',
    ),
    approximateAfter: /^(?:\+(?![\p{N}])|-ish(?![\p{L}])|\s+or\s+so(?![\p{L}]))/iu,
    rangeGap: /^\s*(?:-|–|—|to|or)\s*$/iu,
    betweenGap: /^\s+and\s+$/iu,
    betweenBefore: /(?<![\p{L}\p{N}])between\s+$/iu,
    units: UNIT_BY_ALIAS,
    spacedUnit: SPACED_UNIT,
    digits: DIGITS,
    prefixUnit: () => 'EUR',
    gluedTail: GLUED_TAIL,
    readGlued: readGluedDefault,
    multiplierAfter: MULTIPLIER_AFTER,
    spaceGroups: false,
  },
  nl: {
    group: '.',
    decimal: ',',
    ordinalSuffixes: new Set(['e', 'de', 'ste']),
    words: NL_WORDS,
    approximateBefore: new RegExp(
      String.raw`(?:(?<![\p{L}\p{N}])(?:ongeveer|circa|ca\.?|zo['’]n|bijna|ruim|rond(?:\s+de)?|rondom|plusminus|pakweg|krap|dik|meer\s+dan|minder\s+dan|minimaal|maximaal|ten\s*minste|minstens|hooguit|tot\s+wel|nagenoeg|bijkans)\s*$)|${SYMBOL_APPROXIMATION}`,
      'iu',
    ),
    approximateAfter: /^(?:\+(?![\p{N}])|\s+of\s+zo(?![\p{L}]))/iu,
    rangeGap: /^\s*(?:-|–|—|tot(?:\s+en\s+met)?|t\/m|à|a|of)\s*$/iu,
    betweenGap: /^\s+en\s+$/iu,
    betweenBefore: /(?<![\p{L}\p{N}])tussen\s+$/iu,
    units: UNIT_BY_ALIAS,
    spacedUnit: SPACED_UNIT,
    digits: DIGITS,
    prefixUnit: () => 'EUR',
    gluedTail: GLUED_TAIL,
    readGlued: readGluedDefault,
    multiplierAfter: MULTIPLIER_AFTER,
    spaceGroups: false,
  },
  tr: {
    group: '.',
    decimal: ',',
    // Ordinals glued without the apostrophe ("3üncü"); "3. kat" leaves the dot outside.
    ordinalSuffixes: new Set(['inci', 'uncu', 'üncü', 'nci', 'ncu', 'ncü']),
    words: TR_FOLDED_WORDS,
    approximateBefore: turkishPattern(
      new RegExp(
        String.raw`(?:(?<![\p{L}\p{N}])(?:yaklaşık(?:\s+olarak)?|yakl\.?|takriben|tahminen|aşağı\s+yukarı|ortalama|neredeyse|hemen\s+hemen|en\s+az|en\s+fazla|en\s+çok|asgari|azami|ca\.?)\s*$)|${SYMBOL_APPROXIMATION}`,
        'iu',
      ),
    ),
    // Turkish puts most of them after the number: "92 m² civarında", "10'dan fazla", "100'e yakın".
    approximateAfter: turkishPattern(
      /^(?:\+(?![\p{N}])|\s+(?:civarında|civarı|dolayında|dolaylarında|kadar|küsur|üzeri|üzerinde|üstü|aşkın|fazla|az|altı|altında|yakın|gibi|ve\s+üzeri|ve\s+üstü|ya\s+da\s+daha\s+fazla|veya\s+daha\s+fazla)(?![\p{L}]))/iu,
    ),
    rangeGap: /^\s*(?:-|–|—|ile|ila|veya|ya\s+da)\s*$/iu,
    betweenGap: NEVER,
    betweenBefore: NEVER,
    ...unitRules('tr', turkishSuffixedUnit),
    digits: digitsPattern(String.raw`${EUR_PREFIX}|₺|%|yüzde`),
    prefixUnit: (prefix) => {
      const lower = prefix.toLowerCase();
      if (lower === '%' || lower === 'yüzde') return '%';
      return lower === '₺' ? 'TRY' : 'EUR';
    },
    gluedTail: GLUED_TAIL_TR,
    readGlued: readGluedTurkish,
    multiplierAfter: turkishPattern(multiplierAfter('tr')),
    spaceGroups: true,
    fold: foldTurkish,
    wordPrefix: { pattern: /(?:(?<![\p{L}\p{N}])yüzde\s+|%\s*)$/iu, unit: '%' },
    juxtaposedWordRange: true,
  },
  it: {
    group: '.',
    decimal: ',',
    ordinalSuffixes: new Set(['º', 'ª']),
    words: IT_WORDS,
    approximateBefore: new RegExp(
      String.raw`(?:(?<![\p{L}\p{N}])(?:circa|ca\.?|c\.a\.?|quasi|oltre|più\s+di|meno\s+di|almeno|al\s+massimo|al\s+minimo|fino\s+ad?|intorno\s+a(?:i|gli|lle|l)?|attorno\s+a(?:i|gli|lle|l)?|approssimativamente|all['’]incirca|pressoché|poco\s+più\s+di|poco\s+meno\s+di|non\s+meno\s+di|più\s+o\s+meno|superiore\s+a(?:i|l)?|inferiore\s+a(?:i|l)?)\s*$)|${SYMBOL_APPROXIMATION}`,
      'iu',
    ),
    approximateAfter:
      /^(?:\+(?![\p{N}])|\s+(?:circa|ca\.?|c\.a\.?|abbondanti|scarsi|e\s+oltre|o\s+più|o\s+giù\s+di\s+lì|più\s+o\s+meno)(?![\p{L}]))/iu,
    rangeGap: /^\s*(?:-|–|—|a|o|oppure|fino\s+a)\s*$/iu,
    betweenGap: /^\s+e\s+$/iu,
    betweenBefore: /(?<![\p{L}\p{N}])(?:tra|fra)\s+$/iu,
    ...unitRules('it'),
    digits: digitsPattern(EUR_PREFIX),
    prefixUnit: () => 'EUR',
    gluedTail: GLUED_TAIL_ORDINAL_DOT,
    readGlued: readGluedOrdinalDot,
    multiplierAfter: multiplierAfter('it'),
    spaceGroups: true,
    decadeBefore: /(?:(?<![\p{L}\p{N}])(?:anni|decennio)\s+|(?<![\p{L}\p{N}])['’])$/iu,
    skipWord: skipItalian,
    fractionAfterNoun: FRACTIONS_AFTER_NOUN.it,
  },
  es: {
    group: '.',
    decimal: ',',
    ordinalSuffixes: new Set([
      'º',
      'ª',
      'er',
      'ero',
      'era',
      'ro',
      'ra',
      'do',
      'da',
      'to',
      'ta',
      'vo',
      'va',
      'no',
      'na',
      'mo',
      'ma',
    ]),
    words: ES_WORDS,
    approximateBefore: new RegExp(
      String.raw`(?:(?<![\p{L}\p{N}])(?:aproximadamente|aprox\.?|unos|unas|alrededor\s+de(?:\s+l[oa]s)?|cerca\s+de|casi|más\s+de|menos\s+de|al\s+menos|por\s+lo\s+menos|como\s+mínimo|como\s+máximo|como\s+mucho|hasta|mínimo|máximo|en\s+torno\s+a(?:\s+l[oa]s)?|poco\s+más\s+de|poco\s+menos\s+de|más\s+o\s+menos|rondando|sobre\s+l[oa]s|superior\s+a|inferior\s+a|ca\.?)\s*$)|${SYMBOL_APPROXIMATION}`,
      'iu',
    ),
    approximateAfter:
      /^(?:\+(?![\p{N}])|\s+(?:aproximadamente|aprox\.?|o\s+más|más\s+o\s+menos|y\s+pico)(?![\p{L}]))/iu,
    rangeGap: /^\s*(?:-|–|—|a|o|ó|u|hasta)\s*$/iu,
    betweenGap: /^\s+y\s+$/iu,
    betweenBefore: /(?<![\p{L}\p{N}])entre\s+$/iu,
    ...unitRules('es'),
    digits: digitsPattern(EUR_PREFIX),
    prefixUnit: () => 'EUR',
    gluedTail: GLUED_TAIL_ORDINAL_DOT,
    readGlued: readGluedOrdinalDot,
    multiplierAfter: multiplierAfter('es'),
    spaceGroups: true,
    decadeBefore:
      /(?:(?<![\p{L}\p{N}])(?:años|década\s+de(?:\s+los)?)\s+|(?<![\p{L}\p{N}])['’])$/iu,
    skipWord: skipSpanish,
    fractionAfterNoun: FRACTIONS_AFTER_NOUN.es,
  },
};

/**
 * The allowlist: spans with digits that are names, not claims. Kept minimal on purpose; a
 * number not listed here is a claim. Digits glued to a preceding letter ("m2", "CO2", "A0",
 * "HR107") are never read as numbers either: they are units or names. Energy label classes
 * ("A++", "B") contain no digits and are never tokens.
 */
const NOT_A_CLAIM: readonly RegExp[] = [
  // Measurement standards: "NEN 2580", "NEN-2580", "NEN 2580:2007", "NEN-EN 13829".
  /(?<![\p{L}\p{N}])NEN(?:[\s-]EN)?[\s-]?\d{3,5}(?::\d{4})?(?![\p{N}])/giu,
  // The Dutch house type "2-onder-1-kap" (semi-detached): a name, not a count.
  /(?<![\p{L}\p{N}])(?:2|twee)-onder-(?:1|een|één)-kap/giu,
];

const DATETIME =
  /(?<![\p{L}\p{N}])(?:\d{1,2}[-/.]\d{1,2}[-/.](?:\d{4}|\d{2})|\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}\.\d{2}(?=\s?uur))(?![\p{N}])/gu;

const WORD_PATTERNS: Readonly<Record<ClaimLanguage, RegExp>> = {
  en: wordPattern(EN_WORDS),
  nl: wordPattern(NL_WORDS),
  tr: wordPattern(TR_FOLDED_WORDS, foldTurkish(MULTIPLIERS.tr), foldTurkish(COLLECTIVES.tr)),
  it: wordPattern(IT_WORDS, MULTIPLIERS.it, COLLECTIVES.it),
  es: wordPattern(ES_WORDS, MULTIPLIERS.es, COLLECTIVES.es),
};

/**
 * Number words (group 1), or a scale word or collective (no group: unreadable). A space inside
 * a word ("yirmi bir", "treinta y dos") matches any whitespace.
 */
function wordPattern(
  words: ReadonlyMap<string, number>,
  multiplier: string = MULTIPLIER,
  collectives?: string,
): RegExp {
  const alternatives = [...words.keys()]
    .sort((a, b) => b.length - a.length)
    .map((word) => escapeRegExp(word).replace(/ /g, String.raw`\s+`))
    .join('|');
  const unreadable = collectives === undefined ? multiplier : `${multiplier}|${collectives}`;
  // An elided word ("vent'") ends at its apostrophe, with the next word glued on ("vent'anni").
  const elided = [...words.keys()].some((word) => /['’]$/u.test(word));
  const end = elided ? String.raw`(?:(?<=['’])|(?![\p{L}\p{N}]))` : String.raw`(?![\p{L}\p{N}])`;
  return new RegExp(String.raw`(?<![\p{L}\p{N}])(?:(${alternatives})|${unreadable})${end}`, 'giu');
}

function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => ' '.repeat(match.length));
}

function parseDigits(digits: string, rules: LanguageRules): number | null {
  const written = rules.spaceGroups ? digits.replace(GROUP_SPACE, '') : digits;
  const group = escapeRegExp(rules.group);
  const decimal = escapeRegExp(rules.decimal);
  const match = new RegExp(String.raw`^(\d{1,3}(?:${group}\d{3})+|\d+)(?:${decimal}(\d+))?$`).exec(
    written,
  );
  if (match === null) return null;
  const integer = (match[1] ?? '').split(rules.group).join('');
  const fraction = match[2];
  return Number(fraction === undefined ? integer : `${integer}.${fraction}`);
}

interface Tail {
  readonly end: number;
  readonly unit: string | null;
  readonly unreadable: boolean;
  readonly approximateSuffix: boolean;
}

/** What follows a number: a unit (glued or spaced), a multiplier, a trailing "+"/"or so". */
function readTail(
  text: string,
  from: number,
  rules: LanguageRules,
  options: { readonly glued: boolean },
): Tail & { readonly ordinal: boolean } {
  let end = from;
  let unit: string | null = null;
  let unreadable = false;
  let ordinal = false;
  const glued = options.glued ? rules.gluedTail.exec(text.slice(end))?.[0] : undefined;
  if (glued !== undefined) {
    const reading = rules.readGlued(glued, rules);
    switch (reading.kind) {
      case 'ordinal':
        ordinal = true;
        break;
      case 'unit':
        unit = reading.unit;
        break;
      case 'value':
        break;
      case 'unreadable':
        unreadable = true; // "165k", "1980s", "2x", "3D": not one exact value
        break;
      default: {
        const unreachable: never = reading;
        throw new Error(`Unknown glued reading ${JSON.stringify(unreachable)}`);
      }
    }
    end += glued.length;
  } else {
    const spaced = rules.spacedUnit.exec(text.slice(end));
    if (spaced !== null) {
      unit = rules.units.get(normalizeUnit(spaced[1] ?? spaced[2] ?? '')) ?? null;
      end += spaced[0].length;
    }
  }
  const multiplier = rules.multiplierAfter.exec(text.slice(end));
  if (multiplier !== null) {
    unreadable = true;
    end += multiplier[0].length;
  }
  const fraction = rules.fractionAfterNoun?.exec(text.slice(end));
  if (fraction !== null && fraction !== undefined) {
    unreadable = true;
    end += fraction[0].length;
  }
  const after = rules.approximateAfter.exec(text.slice(end));
  if (after !== null) end += after[0].length;
  return { end, unit, unreadable, ordinal, approximateSuffix: after !== null };
}

interface RawToken {
  readonly start: number;
  readonly end: number;
  readonly reading: NumberReading;
  readonly approximateSuffix: boolean;
  /** Read from a number word, not from digits. */
  readonly word: boolean;
}

function readDigits(text: string, rules: LanguageRules): RawToken[] {
  const tokens: RawToken[] = [];
  const pattern = new RegExp(rules.digits.source, rules.digits.flags);
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const [whole, prefix, straySeparator, digits = ''] = match;
    const tail = readTail(text, match.index + whole.length, rules, { glued: true });
    const value = parseDigits(digits, rules);
    const prefixUnit = prefix === undefined ? null : rules.prefixUnit(prefix);
    const conflictingUnits = prefixUnit !== null && tail.unit !== null && tail.unit !== prefixUnit;
    const unreadable =
      value === null ||
      straySeparator !== undefined ||
      tail.unreadable ||
      conflictingUnits ||
      (tail.ordinal && prefixUnit !== null);
    tokens.push({
      start: match.index,
      end: tail.end,
      reading: unreadable
        ? { kind: 'unreadable' }
        : { kind: 'value', value, unit: prefixUnit ?? tail.unit },
      approximateSuffix: tail.approximateSuffix,
      word: false,
    });
    pattern.lastIndex = tail.end;
  }
  return tokens;
}

/** How far homograph rules and word prefixes look around a number word. */
const CONTEXT_WINDOW = 40;

/** `named` is `text` before allowlisted names and digits were blanked (same offsets). */
function readWords(text: string, language: ClaimLanguage, named: string): RawToken[] {
  const rules = RULES[language];
  const tokens: RawToken[] = [];
  const pattern = new RegExp(WORD_PATTERNS[language].source, WORD_PATTERNS[language].flags);
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const word = match[1]?.toLowerCase().replace(/\s+/g, ' ');
    const matchEnd = match.index + match[0].length;
    // Context is read from a short window: slicing to the start of the text made the
    // end-anchored look-back quadratic in the text length.
    if (
      word !== undefined &&
      rules.skipWord?.(
        word,
        text.slice(Math.max(0, match.index - CONTEXT_WINDOW), match.index),
        text.slice(matchEnd, matchEnd + CONTEXT_WINDOW),
        named.slice(matchEnd, matchEnd + CONTEXT_WINDOW),
      ) === true
    ) {
      continue;
    }
    const value = word === undefined ? undefined : rules.words.get(word);
    const tail = readTail(text, matchEnd, rules, { glued: false });
    let start = match.index;
    let unit = tail.unit;
    let unreadable = value === undefined || tail.unreadable;
    const windowStart = Math.max(0, start - CONTEXT_WINDOW);
    const prefix = rules.wordPrefix?.pattern.exec(text.slice(windowStart, start));
    if (rules.wordPrefix !== undefined && prefix !== null && prefix !== undefined) {
      start = windowStart + prefix.index;
      if (unit !== null && unit !== rules.wordPrefix.unit) unreadable = true;
      unit = rules.wordPrefix.unit;
    }
    tokens.push({
      start,
      end: tail.end,
      reading:
        value === undefined || unreadable ? { kind: 'unreadable' } : { kind: 'value', value, unit },
      approximateSuffix: tail.approximateSuffix,
      word: true,
    });
    pattern.lastIndex = tail.end;
  }
  return tokens;
}

/**
 * Every number claim in `text`, in text order, read with the language's separators and words.
 * Throws for a language without rules (callers check {@link isClaimLanguage} first).
 */
export function readNumbers(text: string, language: ClaimLanguage): NumberToken[] {
  const rules = RULES[language];
  // The fold keeps every offset, so tokens index into `text` itself.
  const source = rules.fold === undefined ? text : rules.fold(text);
  let scan = source;
  for (const pattern of NOT_A_CLAIM) scan = blank(scan, pattern);

  const raw: RawToken[] = [];
  const datetime = new RegExp(DATETIME.source, DATETIME.flags);
  for (let match = datetime.exec(scan); match !== null; match = datetime.exec(scan)) {
    raw.push({
      start: match.index,
      end: match.index + match[0].length,
      reading: { kind: 'datetime' },
      approximateSuffix: false,
      word: false,
    });
  }
  scan = blank(scan, datetime);
  const digits = readDigits(scan, rules);
  for (const token of digits) {
    scan = scan.slice(0, token.start) + ' '.repeat(token.end - token.start) + scan.slice(token.end);
  }
  raw.push(...digits, ...readWords(scan, language, source));
  raw.sort((a, b) => a.start - b.start);

  // Markers and range gaps are read from the text with allowlisted names blanked out.
  let markers = source;
  for (const pattern of NOT_A_CLAIM) markers = blank(markers, pattern);
  return raw.map((token, i): NumberToken => {
    const before = markers.slice(Math.max(0, token.start - 40), token.start);
    const approximate = rules.approximateBefore.exec(before);
    const next = raw[i + 1];
    let rangeTo: number | null = null;
    if (next !== undefined) {
      const gap = markers.slice(token.end, next.start);
      const between =
        rules.betweenGap.test(gap) && rules.betweenBefore.test(markers.slice(0, token.start));
      const juxtaposed =
        rules.juxtaposedWordRange === true && token.word && next.word && /^\s+$/u.test(gap);
      if (rules.rangeGap.test(gap) || between || juxtaposed) rangeTo = next.end;
    }
    const decade = rules.decadeBefore?.test(before) === true;
    return {
      start: token.start,
      end: token.end,
      reading: decade ? { kind: 'unreadable' } : token.reading,
      approximateFrom:
        approximate === null ? null : token.start - before.length + approximate.index,
      approximateSuffix: token.approximateSuffix,
      rangeTo,
    };
  });
}
