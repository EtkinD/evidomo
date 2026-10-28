import type { MarketProfile, StoredTranscriptTurn } from '@evidomo/shared';
import { OTHER_KEY, UNSPECIFIED_BASIS } from './schema.ts';

// Fact extraction prompt (docs/model-notes.md, P2-07). Changing the wording or serialization
// changes the request hash: re-record `fixtures/meta/p2-07/fact-extraction.json` and bump
// FACT_EXTRACTION_PROMPT_VERSION when the meaning changes.
//
// The model sees the transcript and the market vocabulary only, never the fact form: the
// candidates must say what was spoken, so a form value cannot pull a spoken "95" toward "92".

function unitRule(market: MarketProfile): string {
  const parts = [`"${market.units.area}" for areas`];
  if (market.units.volume !== undefined) parts.push(`"${market.units.volume}" for volumes`);
  if (market.currency !== undefined) parts.push(`"${market.currency}" for money amounts`);
  return `${parts.join(', ')}; otherwise null. Never convert units.`;
}

export function buildFactExtractionSystemPrompt(market: MarketProfile): string {
  return `You extract candidate property facts from the transcript of a real-estate agent's voice walkthrough of one property. The user message is JSON with "vocabulary" (the market's fact keys and area measurement bases) and "turns" (the transcript, split into numbered turns). The transcript is machine-generated: it can repeat words, misspell names, or run words together.

Return every fact the speaker states about the property, its building, its costs, or its surroundings. Later steps compare these candidates with the agent's fact form and the photos, so extract what is said, not what you think is true.

Rules:
1. One fact per item. A turn can contain several facts. A fact said in two turns is two facts, even when the values differ: never merge, resolve, or skip conflicting statements.
2. turnIndex: the turn in which the fact is said. quote: the shortest exact span of that turn's text that states the fact, copied character for character, including repeated words, spelling errors, and punctuation. Never translate, correct, abbreviate with "...", or combine text from two turns.
3. key: a vocabulary key only when the statement is about exactly the quantity its label names. An area key never takes a gross area, an area that includes storage or walls, the area of a single room, or a plot, unless its label says so. Everything else uses key "${OTHER_KEY}" with otherKey set to a short snake_case English name, such as bedrooms, balcony_area, or heating_boiler_year. otherKey is null when key is a vocabulary key.
4. value: a JSON number for amounts, counts, measurements, and years. Write spelled-out numbers as digits, and never round, add up, or compute. true or false for yes/no facts and boolean keys. Exactly one of the listed values for enum keys. Otherwise a short English phrase.
5. unit: ${unitRule(market)}
6. basis: for areas only. Use an area basis ID only when the speaker names that measurement standard or register; otherwise "${UNSPECIFIED_BASIS}". null for anything that is not an area.
7. assertion: "opinion" for subjective judgments, sales talk, predictions, and impressions that no document, measurement, or photo could confirm (for example "a beautiful view", "the best location in town", "it will only go up in value"); "stated" for everything else.
8. An approximate value ("about", "roughly") is still a fact: give the number as said; the quote keeps the qualifier.
9. Only facts the speaker states. Do not add facts from general knowledge or from the vocabulary.`;
}

/** The market vocabulary: keys with label, type, unit, basis, and enum values. */
function vocabulary(market: MarketProfile): unknown {
  return {
    keys: market.facts.map((fact) => {
      switch (fact.type) {
        case 'enum':
          return { key: fact.key, label: fact.label, type: fact.type, values: fact.values };
        case 'area':
          return {
            key: fact.key,
            label: fact.label,
            type: fact.type,
            unit: market.units.area,
            basis: fact.basis,
          };
        case 'volume':
          return { key: fact.key, label: fact.label, type: fact.type, unit: market.units.volume };
        case 'money':
          return { key: fact.key, label: fact.label, type: fact.type, unit: market.currency };
        case 'integer':
        case 'boolean':
          return { key: fact.key, label: fact.label, type: fact.type };
      }
    }),
    areaBases: market.area_bases.map((basis) => ({ id: basis.id, label: basis.label })),
  };
}

/**
 * The user message: compact JSON (whitespace costs input tokens). Turns carry their index and
 * text only; speaker labels and timestamps are not needed to extract facts and stay in code.
 */
export function buildFactExtractionPrompt(
  market: MarketProfile,
  turns: readonly StoredTranscriptTurn[],
): string {
  return JSON.stringify({
    vocabulary: vocabulary(market),
    turns: turns.map((turn) => ({ turnIndex: turn.index, text: turn.text })),
  });
}
