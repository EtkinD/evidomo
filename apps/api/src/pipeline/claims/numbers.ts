// Reading number claims out of copy text for the claim validator (docs/architecture.md §5
// "Claim validator (P3-02)"). Every number a buyer could read as a fact is a token: digits
// (with the language's separators, a currency sign, a unit, an ordinal suffix), number words
// and ordinal words, and dates and times. Anything that cannot be read as one exact value is a
// token too (`unreadable`), so the validator fails it instead of skipping it. The only spans
// that are not claims are on an explicit allowlist below. The reader is language-aware and
// deliberately strict: a false pass would put an unsupported number in front of a buyer, a
// false flag costs one revision or one Gate 2 decision.

/** Languages with number rules. Copy in any other language cannot be validated. */
export const CLAIM_LANGUAGES = ['en', 'nl'] as const;
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
  return UNIT_BY_ALIAS.get(normalized) ?? `other:${normalized}`;
}

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
  },
};

/** Words that scale a number ("2 million", "honderd"): the copy must write the full value. */
const MULTIPLIER = String.raw`(?:hundred|thousand|million|billion|honderd|duizend|miljoen|miljard|mln\.?|mrd\.?)`;
const MULTIPLIER_AFTER = new RegExp(String.raw`^\s*${MULTIPLIER}(?![\p{L}\p{N}])`, 'iu');

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

/** Digits, with an optional leading currency, a leading stray separator, and the Dutch ",-". */
const DIGITS =
  /(?<![\p{L}\p{N}])(?:(€|eur(?:os?)?)\s?)?([.,])?(\d+(?:[.,]\d+)*)(,[-–—](?![\p{N}]))?/giu;

const WORD_PATTERNS: Readonly<Record<ClaimLanguage, RegExp>> = {
  en: wordPattern(EN_WORDS),
  nl: wordPattern(NL_WORDS),
};

function wordPattern(words: ReadonlyMap<string, number>): RegExp {
  const alternatives = [...words.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:(${alternatives})|${MULTIPLIER})(?![\p{L}\p{N}])`,
    'giu',
  );
}

function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => ' '.repeat(match.length));
}

function parseDigits(digits: string, rules: LanguageRules): number | null {
  const group = escapeRegExp(rules.group);
  const decimal = escapeRegExp(rules.decimal);
  const match = new RegExp(String.raw`^(\d{1,3}(?:${group}\d{3})+|\d+)(?:${decimal}(\d+))?$`).exec(
    digits,
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
  const glued = options.glued
    ? /^(?:\p{L}[\p{L}\p{N}²³]*|[²³€%])/u.exec(text.slice(end))?.[0]
    : undefined;
  if (glued !== undefined) {
    const lower = glued.toLowerCase();
    const alias = UNIT_BY_ALIAS.get(lower);
    if (rules.ordinalSuffixes.has(lower)) ordinal = true;
    else if (alias !== undefined) unit = alias;
    else unreadable = true; // "165k", "1980s", "2x", "3D": not one exact value
    end += glued.length;
  } else {
    const spaced = SPACED_UNIT.exec(text.slice(end));
    if (spaced !== null) {
      unit = UNIT_BY_ALIAS.get(normalizeUnit(spaced[1] ?? '')) ?? null;
      end += spaced[0].length;
    }
  }
  const multiplier = MULTIPLIER_AFTER.exec(text.slice(end));
  if (multiplier !== null) {
    unreadable = true;
    end += multiplier[0].length;
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
}

function readDigits(text: string, rules: LanguageRules): RawToken[] {
  const tokens: RawToken[] = [];
  const pattern = new RegExp(DIGITS.source, DIGITS.flags);
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const [whole, currency, straySeparator, digits = ''] = match;
    const tail = readTail(text, match.index + whole.length, rules, { glued: true });
    const value = parseDigits(digits, rules);
    const prefixUnit = currency === undefined ? null : 'EUR';
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
    });
    pattern.lastIndex = tail.end;
  }
  return tokens;
}

function readWords(text: string, language: ClaimLanguage): RawToken[] {
  const rules = RULES[language];
  const tokens: RawToken[] = [];
  const pattern = new RegExp(WORD_PATTERNS[language].source, WORD_PATTERNS[language].flags);
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const word = match[1];
    const value = word === undefined ? undefined : rules.words.get(word.toLowerCase());
    const tail = readTail(text, match.index + match[0].length, rules, { glued: false });
    tokens.push({
      start: match.index,
      end: tail.end,
      reading:
        value === undefined || tail.unreadable
          ? { kind: 'unreadable' }
          : { kind: 'value', value, unit: tail.unit },
      approximateSuffix: tail.approximateSuffix,
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
  let scan = text;
  for (const pattern of NOT_A_CLAIM) scan = blank(scan, pattern);

  const raw: RawToken[] = [];
  const datetime = new RegExp(DATETIME.source, DATETIME.flags);
  for (let match = datetime.exec(scan); match !== null; match = datetime.exec(scan)) {
    raw.push({
      start: match.index,
      end: match.index + match[0].length,
      reading: { kind: 'datetime' },
      approximateSuffix: false,
    });
  }
  scan = blank(scan, datetime);
  const digits = readDigits(scan, rules);
  for (const token of digits) {
    scan = scan.slice(0, token.start) + ' '.repeat(token.end - token.start) + scan.slice(token.end);
  }
  raw.push(...digits, ...readWords(scan, language));
  raw.sort((a, b) => a.start - b.start);

  // Markers and range gaps are read from the text with allowlisted names blanked out.
  let markers = text;
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
      if (rules.rangeGap.test(gap) || between) rangeTo = next.end;
    }
    return {
      start: token.start,
      end: token.end,
      reading: token.reading,
      approximateFrom:
        approximate === null ? null : token.start - before.length + approximate.index,
      approximateSuffix: token.approximateSuffix,
      rangeTo,
    };
  });
}
