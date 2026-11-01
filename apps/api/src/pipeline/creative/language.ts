import type { CopyLanguageCheck } from '@evidomo/shared';

// A deliberately small language check for generated copy (docs/architecture.md §5 Creative):
// counts function words that occur in one language and not the other. It answers one question,
// "is this text in the output language or clearly in another known one?", and stays
// inconclusive rather than guessing on short or mixed text, so it never fails good copy for
// lack of evidence. Words both languages share ("in", "is", "over", "door", "op") are left out.
//
// Turkish, Italian, and Spanish words were chosen so no list shares a word with another, and so
// that none is likely in English or Dutch copy: "de", "en", "met", "per", "her", "non", "con",
// "la", "un", "una", "su", "del", "al", "lo", "si" are left out. An English or Dutch text that
// matched before still matches unless it holds more of these words than of the runner-up list.

const FUNCTION_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  en: new Set([
    'the',
    'and',
    'with',
    'for',
    'to',
    'this',
    'that',
    'these',
    'are',
    'has',
    'have',
    'from',
    'on',
    'a',
    'by',
    'at',
    'its',
    'which',
    'while',
    'into',
    'your',
    'you',
    'there',
    'their',
    'both',
    'just',
    'within',
    'offers',
    'features',
    'includes',
    'where',
    'every',
    'each',
  ]),
  nl: new Set([
    'de',
    'het',
    'een',
    'en',
    'van',
    'met',
    'voor',
    'naar',
    'zijn',
    'dit',
    'deze',
    'wordt',
    'bij',
    'ook',
    'aan',
    'uit',
    'je',
    'u',
    'er',
    'niet',
    'maar',
    'als',
    'nog',
    'heeft',
    'hebben',
    'tot',
    'onder',
    'waar',
    'beschikt',
    'biedt',
    'elke',
    'jouw',
    'uw',
    'ligt',
  ]),
  tr: new Set([
    've',
    'bu',
    'bir',
    'ile',
    'için',
    'olan',
    'olarak',
    'çok',
    'daha',
    'ayrıca',
    'sahip',
    'gibi',
    'veya',
    'ama',
    'ise',
    'sunar',
    'sunuyor',
    'bulunan',
    'bulunuyor',
    'yer',
    'alır',
    'var',
    'olup',
    'şekilde',
    'oldukça',
  ]),
  it: new Set([
    'il',
    'di',
    'che',
    'è',
    'sono',
    'della',
    'delle',
    'degli',
    'dei',
    'nella',
    'nel',
    'nelle',
    'alla',
    'alle',
    'gli',
    'questo',
    'questa',
    'anche',
    'molto',
    'più',
    'ogni',
    'dove',
    'dal',
    'dalla',
    'sul',
    'sulla',
    'cui',
    'ed',
    'offre',
    'tutti',
    'tutto',
    'vostra',
    'vostro',
    'sua',
    'suo',
    'ma',
  ]),
  es: new Set([
    'el',
    'los',
    'las',
    'que',
    'y',
    'es',
    'para',
    'por',
    'más',
    'muy',
    'está',
    'están',
    'son',
    'este',
    'esta',
    'estos',
    'estas',
    'también',
    'pero',
    'cada',
    'donde',
    'sus',
    'cuenta',
    'ofrece',
    'desde',
    'como',
    'hay',
    'todo',
    'toda',
    'todos',
    'todas',
  ]),
};

/**
 * Words on another language's list that are also ordinary words of the checked language, so they
 * are no evidence against it: Spanish "de", "en" ("of", "in"), "a", "u" ("or"), and "van" ("they
 * go"), Italian "a", and Turkish "de"/"da" written apart and "en" ("most", "width"). Without this,
 * plain Spanish copy ("Apartamento de 92 m² en Zandmeer con ...") counted as Dutch and failed.
 * Only the checked language's own homographs are dropped, so en and nl results are unchanged.
 */
const NOT_EVIDENCE_AGAINST: Readonly<Record<string, ReadonlySet<string>>> = {
  tr: new Set(['de', 'en']),
  it: new Set(['a']),
  es: new Set(['de', 'en', 'a', 'u', 'van']),
};

/**
 * Turkish case endings after an apostrophe ("Zandmeer'de", "1987'de", "İstasyon'a") belong to
 * the word before them; split off, they would read as Dutch "de" or English "a".
 */
const TURKISH_APOSTROPHE_ENDING = /['’]\p{L}+/gu;

/** Function-word hits a language needs before the check decides anything. */
const MIN_HITS = 4;
/** How far the leading language must be ahead of the runner-up. */
const MIN_LEAD = 2;

/** Languages the check knows; for others every text is `unchecked`. */
export const CHECKED_LANGUAGES: readonly string[] = Object.keys(FUNCTION_WORDS);

export type LanguageCheckResult = CopyLanguageCheck | 'mismatch';

export function checkLanguage(text: string, language: string): LanguageCheckResult {
  if (FUNCTION_WORDS[language] === undefined) return 'unchecked';
  // "İ" lowercases to "i" plus a combining dot, which would split Turkish words ("İçin").
  const normalized = text.replace(/İ/g, 'i').toLowerCase();
  const words =
    (language === 'tr' ? normalized.replace(TURKISH_APOSTROPHE_ENDING, '') : normalized).match(
      /\p{L}+/gu,
    ) ?? [];
  const ignored = NOT_EVIDENCE_AGAINST[language];
  const hits = Object.entries(FUNCTION_WORDS).map(
    ([code, list]) =>
      [
        code,
        words.filter((word) => list.has(word) && (code === language || ignored?.has(word) !== true))
          .length,
      ] as const,
  );
  hits.sort((a, b) => b[1] - a[1]);
  const [first, second] = hits;
  if (first === undefined || first[1] < MIN_HITS) return 'inconclusive';
  if (second !== undefined && first[1] < MIN_LEAD * second[1]) return 'inconclusive';
  return first[0] === language ? 'match' : 'mismatch';
}
