import type { MarketProfile, PhrasingCategory } from '@evidomo/shared';
import type { CopyInput } from './schema.ts';

// The creative copy prompt (P3-01). Changing the wording, the phrasing rules, or the input
// serialization changes the request hash: re-record the P3-01 fixtures and bump the version.

/** Stored in the copy artifact; bump whenever the prompt or the output schema changes. */
export const COPY_PROMPT_VERSION = 1;

/** Structured-output name sent to the API (and part of the fixture's request hash). */
export const COPY_OUTPUT_NAME = 'listing_copy';

/**
 * What each phrasing category forbids. Superlatives and promises are forbidden in every market,
 * whatever its `flagged_phrasing` lists; exclusionary phrasing is added when the market lists it.
 */
const PHRASING_RULES: Readonly<Record<PhrasingCategory, string>> = {
  unverifiable_superlative:
    'no superlatives or absolutes that the facts cannot prove ("best", "unique", "perfect", "stunning", "ideal", "rare", "never", "always")',
  investment_promise:
    'no promises about value, returns, rent, investment, or the future ("will rise in value", "a safe investment", "guaranteed")',
  exclusionary:
    'nothing that addresses, includes, or excludes buyers by family status, age, gender, origin, religion, or disability ("perfect for young families", "ideal for seniors")',
};
const ALWAYS: readonly PhrasingCategory[] = ['unverifiable_superlative', 'investment_promise'];

/**
 * The phrasing categories copy must avoid in a market, in prompt order: superlatives and
 * promises always, then the profile's `flagged_phrasing`. Verification (P3-06) audits the same
 * set, so a draft is never flagged for a rule its writer was not given.
 */
export function copyPhrasingCategories(market: MarketProfile): PhrasingCategory[] {
  return [...new Set([...ALWAYS, ...market.flagged_phrasing])];
}

/** The phrasing rules of a market as one prompt clause; the Q&A prompt (P3-03) uses it too. */
export function phrasingRule(market: MarketProfile): string {
  return copyPhrasingCategories(market)
    .map((category) => PHRASING_RULES[category])
    .join('; ');
}

export function buildCopySystemPrompt(market: MarketProfile): string {
  return `You write real-estate listing copy for one property. The user message is JSON:
- "language": the output language. Write all text in this language only.
- "tone": the agency's tone of voice, or null for warm, clear, and factual. Follow it in word choice and rhythm; it never overrides a rule below.
- "market": the market's currency, units, and area bases.
- "facts": the verified facts, the only source of what you may say. Each has an "id" to cite, a "key", a "label" for the market's core facts, a "value", and a "unit" and "basis" where they apply. A fact with "presence": true was seen in photos ("seenIn" lists the rooms): it shows that something is there, never how many or how large.
- "photos": the rooms the listing photos show, cover photo first, or null. Use it only to choose order and emphasis; it is not a source.
- "revision": null, or an earlier "draft" with "flags" (variant, 0-based segment position within the variant, problem) to fix.

Return "portal", the portal description (2 to 4 paragraphs, 120 to 220 words in total), and "social", one caption for Instagram and Facebook (25 to 60 words, no hashtags, no emojis). Both consist of segments: one sentence or clause each, with "factIds", the IDs of every fact that supports what the segment says. Segments are joined with a single space, paragraphs with a blank line.

Rules:
1. Say nothing about the property that the facts do not state. Cite every fact a segment relies on, and only those.
2. Every segment cites at least one fact. Attach connecting words to the segment they introduce instead of writing a segment without a fact. No greetings, calls to action, contact details, or sign-offs: the agency adds those.
3. Numbers: write every number in digits exactly as the cited fact's value, without rounding, converting, ranges, thousands separators, or spelling it out. Write no number that is not the value of a fact the segment cites. Show units as m², m³, and the currency symbol.
4. Translate text values into the output language without changing their meaning. A false value states that something is absent or not the case.
5. A presence fact supports only that something is there; never count or measure from it.
6. Phrasing: ${phrasingRule(market)}.
7. Do not name the street or the house number; the town may be named.
8. You need not use every fact. The portal description states every fact that has a "label" at least once; the caption picks two or three highlights.
9. With a "revision", rewrite the draft so that every flagged segment is fixed (reword it, cite the facts it needs, or drop the claim) and keep the other segments unless a fix requires changing them.`;
}

/** The user message: the copy input as compact JSON (whitespace costs input tokens). */
export function buildCopyPrompt(input: CopyInput): string {
  return JSON.stringify(input);
}
