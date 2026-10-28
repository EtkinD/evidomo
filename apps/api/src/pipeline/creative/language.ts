import type { CopyLanguageCheck } from '@evidomo/shared';

// A deliberately small language check for generated copy (docs/architecture.md §5 Creative):
// counts function words that occur in one language and not the other. It answers one question,
// "is this text in the output language or clearly in another known one?", and stays
// inconclusive rather than guessing on short or mixed text, so it never fails good copy for
// lack of evidence. Words both languages share ("in", "is", "over", "door", "op") are left out.

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
};

/** Function-word hits a language needs before the check decides anything. */
const MIN_HITS = 4;
/** How far the leading language must be ahead of the runner-up. */
const MIN_LEAD = 2;

/** Languages the check knows; for others every text is `unchecked`. */
export const CHECKED_LANGUAGES: readonly string[] = Object.keys(FUNCTION_WORDS);

export type LanguageCheckResult = CopyLanguageCheck | 'mismatch';

export function checkLanguage(text: string, language: string): LanguageCheckResult {
  if (FUNCTION_WORDS[language] === undefined) return 'unchecked';
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const hits = Object.entries(FUNCTION_WORDS).map(
    ([code, list]) => [code, words.filter((word) => list.has(word)).length] as const,
  );
  hits.sort((a, b) => b[1] - a[1]);
  const [first, second] = hits;
  if (first === undefined || first[1] < MIN_HITS) return 'inconclusive';
  if (second !== undefined && first[1] < MIN_LEAD * second[1]) return 'inconclusive';
  return first[0] === language ? 'match' : 'mismatch';
}
