import type { VerificationStepInput } from './step-schema.ts';

// The verification step prompt (P3-06). Changing the wording, the rubric texts (rubric.ts), or
// the input serialization changes the request hash: re-record the P3-06 fixtures and bump the
// version. The P1-03 sizing prompt (`prompt.ts`) stays unchanged for its measurement test.

/** Stored in the claim audit and in `claims.verifier_details`. */
export const VERIFICATION_PROMPT_VERSION = 1;

/** Structured-output name sent to the API (and part of the fixture's request hash). */
export const VERIFICATION_OUTPUT_NAME = 'claim_audit';

export const VERIFICATION_STEP_SYSTEM_PROMPT = `You audit real-estate listing copy before publication. The user message is JSON:
- "language": the language the copy is written in.
- "market": the market's currency, units, and area bases.
- "rubric": the rules, one per category.
- "facts": the verified facts the copy cites, the only source of truth. A fact with "presence": true was seen in photos ("seenIn" lists the rooms): it shows that something is there, never how many, how large, or in what condition.
- "copy": the texts (portal description, social caption), each a list of segments with an "id", the "text", the "factIds" it cites, and "audit".

Code has already checked that every cited fact exists and that every number equals a cited fact's value. You judge meaning and phrasing.

Audit every segment with "audit": true against every rubric rule. Segments with "audit": false were audited before: read them as context (for words like "it" or "also"), never flag them.

Return one flag per problem: the segment "id", the rubric "category" the words break, "problem" (one English sentence that quotes the words at fault and says why they break the rule), and "suggestion" (the whole segment rewritten in the copy's language so that its cited facts support every word and it follows every rule, or null when the claim should be dropped). Return no flag for a segment that breaks no rule; an empty list is a valid answer.

Be precise, not pedantic: plain restatements, translations, and neutral connecting words are fine, and tone and style are not your concern.`;

/** The user message: the audit input as compact JSON (whitespace costs input tokens). */
export function buildVerificationStepPrompt(input: VerificationStepInput): string {
  return JSON.stringify(input);
}
