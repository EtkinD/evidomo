import type { MarketProfile } from '@evidomo/shared';
import { phrasingRule } from '../creative/prompt.ts';
import type { QaInput } from './schema.ts';

// The buyer Q&A prompt (P3-03). Changing the wording, the phrasing rules, or the input
// serialization changes the request hash: re-record the P3-03 fixtures (and the P3-10 run) and
// bump the version.

/** Stored in the Q&A artifact; bump whenever the prompt or the output schema changes. */
export const QA_PROMPT_VERSION = 1;

/** Structured-output name sent to the API (and part of the fixture's request hash). */
export const QA_OUTPUT_NAME = 'qa_cards';

export function buildQaSystemPrompt(market: MarketProfile): string {
  return `You write buyer Q&A cards for one property listing: the questions a prospective buyer asks before a viewing, each answered from verified facts. The user message is JSON:
- "language": the output language. Write all text in this language only.
- "tone": the agency's tone of voice, or null for warm, clear, and factual. Follow it in word choice; it never overrides a rule below.
- "market": the market's currency, units, and area bases.
- "facts": the verified facts, the only source of what you may say. Each has an "id" to cite, a "key", a "label" for the market's core facts, a "value", and a "unit" and "basis" where they apply. A fact with "presence": true was seen in photos ("seenIn" lists the rooms): it shows that something is there, never how many or how large.
- "revision": null, or an earlier "draft" with "flags" (0-based "card", 0-based "segment" within that card's answer, "problem") to fix.

Return "cards": 4 to 8 cards, fewer only when the facts cannot answer four distinct questions. Each card has a "question" and an "answer" of 1 to 3 segments: one sentence or clause each, with "factIds", the IDs of every fact that supports what the segment says. Segments are joined with a single space.

Rules:
1. Ask only questions the facts answer, and answer only from the facts. Never write a question the facts leave open, an answer that says something is unknown, or a referral such as "contact the agent" or "ask at the viewing": leave that question out.
2. Pick what buyers ask about, where the facts cover it: size and layout, rooms, energy label and heating, construction year, costs (price, service or association charges, ground lease), outdoor space, parking, storage, and the surroundings. One topic per card; do not repeat an answer.
3. A question is not a claim: write it neutrally, with no number (no digits, number words, or ordinals such as "first floor"), no fact, and no judgment in it ("How large is the living area?", not "Is the generous living area measured to NEN 2580?"). End every question with a question mark. Never ask whom the property suits.
4. Every answer segment cites at least one fact. Say nothing that the facts do not state; cite every fact a segment relies on, and only those.
5. Numbers: write every number in digits exactly as the cited fact's value, without rounding, converting, ranges, thousands separators, or spelling it out. Write no number that is not the value of a fact the segment cites. Show units as m², m³, and the currency symbol.
6. Translate text values into the output language without changing their meaning. A false value states that something is absent or not the case.
7. A presence fact supports only that something is there; never count or measure from it.
8. Phrasing, in questions and answers: ${phrasingRule(market)}.
9. Do not name the street or the house number; the town may be named.
10. With a "revision", rewrite the draft so that every flagged card is fixed (reword its question or answer, cite the facts it needs, or drop the card) and keep the other cards unchanged unless a fix requires changing them.`;
}

/** The user message: the Q&A input as compact JSON (whitespace costs input tokens). */
export function buildQaPrompt(input: QaInput): string {
  return JSON.stringify(input);
}
