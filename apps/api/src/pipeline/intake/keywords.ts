import { TRANSCRIPTION_KEYWORD_LIMITS, type JsonObject, type MarketProfile } from '@evidomo/shared';

// Keyword biasing for Voice Transcribe (docs/architecture.md §5 step 1). The list is built
// deterministically, so the same project and profile always send the same request (which is
// also what lets replay fixtures match). Keyword values can carry personal data (street and
// place names): never log them.

export interface KeywordSources {
  /** `projects.fact_form`: values keyed by field. */
  readonly factForm: JsonObject;
  readonly market: MarketProfile;
}

/** Collapses whitespace and applies NFC, so visually equal terms compare equal. */
export function normalizeKeyword(term: string): string {
  return term.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

const LETTER = /\p{L}/gu;

/**
 * A term worth biasing toward: at least two letters (so energy-label classes such as "A" or
 * "A++", bare numbers, and house numbers are skipped) and within the length bound. Longer text,
 * such as a free-text note, is skipped rather than truncated: a cut-off phrase is never spoken.
 */
function isUsefulTerm(term: string): boolean {
  return (
    term.length <= TRANSCRIPTION_KEYWORD_LIMITS.maxKeywordLength &&
    (term.match(LETTER)?.length ?? 0) >= 2
  );
}

/**
 * Text values of the fact form that are not typed market facts: those are numbers, booleans,
 * and closed enums, whose values carry no vocabulary. What remains are free-text fields such as
 * street and place names. Keys are visited in code-point order because jsonb does not keep
 * insertion order.
 */
function formTerms(factForm: JsonObject, market: MarketProfile): string[] {
  const typedFacts = new Set(market.facts.map((fact) => fact.key));
  return Object.keys(factForm)
    .filter((key) => !typedFacts.has(key))
    .sort()
    .flatMap((key) => {
      const value = factForm[key];
      return typeof value === 'string' ? [value] : [];
    });
}

/**
 * The local terms of the fact labels: the parenthesised part, by the labels' convention
 * ("Living area (woonoppervlakte)", "Owners' association (VvE) monthly contribution"). A list in
 * parentheses ("garden, balcony, or terrace") yields each item. The English part is not used:
 * common words need no biasing and labels are not spoken verbatim.
 */
export function labelTerms(market: MarketProfile): string[] {
  return market.facts.flatMap((fact) =>
    [...fact.label.matchAll(/\(([^()]+)\)/gu)].flatMap((match) =>
      (match[1] ?? '').split(/[,/]/u).map((part) => part.trim().replace(/^(?:or|and)\s+/iu, '')),
    ),
  );
}

/**
 * Builds the keyword list in priority order, then normalizes, de-duplicates case-insensitively
 * (the first spelling wins), and caps it at {@link TRANSCRIPTION_KEYWORD_LIMITS}:
 *
 * 1. free-text fact-form values (property-specific names the model cannot know),
 * 2. the local terms of the market profile's fact labels (the facts we extract),
 * 3. the profile's `transcription_keywords` (room and building terms).
 */
export function buildTranscriptionKeywords({ factForm, market }: KeywordSources): string[] {
  const candidates = [
    ...formTerms(factForm, market),
    ...labelTerms(market),
    ...market.transcription_keywords,
  ];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const candidate of candidates) {
    const term = normalizeKeyword(candidate);
    if (!isUsefulTerm(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(term);
    if (keywords.length === TRANSCRIPTION_KEYWORD_LIMITS.maxKeywords) break;
  }
  return keywords;
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

/**
 * `languageBias` takes English language names (`["Dutch"]`, P1-04), so the profile's ISO 639-1
 * source languages are mapped through ICU. The profile schema already rejects codes ICU does not
 * know.
 */
export function languageBiasFor(market: MarketProfile): string[] {
  return market.source_languages.map((code) => {
    const name = languageNames.of(code);
    if (name === undefined) throw new Error(`No English name for language code "${code}"`);
    return name;
  });
}
