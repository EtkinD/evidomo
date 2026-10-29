import type { VerificationStepInput } from './step-schema.ts';

// The verification step prompt (P3-06). Changing the wording, the rubric texts (rubric.ts), or
// the input serialization changes the request hash: re-record the P3-06 fixtures and bump the
// version. The P1-03 sizing prompt (`prompt.ts`) stays unchanged for its measurement test.

/**
 * Stored in the claim audit and in `claims.verifier_details`. 2 since P3-03: a request with Q&A
 * cards gets the Q&A wording below; a request without them is byte-identical to version 1.
 */
export const VERIFICATION_PROMPT_VERSION = 2;

/** Structured-output name sent to the API (and part of the fixture's request hash). */
export const VERIFICATION_OUTPUT_NAME = 'claim_audit';

const COPY_ONLY_PROMPT = `You audit real-estate listing copy before publication. The user message is JSON:
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

/** The P3-06 prompt, unchanged: sent whenever the run has no Q&A cards. */
export const VERIFICATION_STEP_SYSTEM_PROMPT = COPY_ONLY_PROMPT;

const QA_COPY_LINE = `- "copy": the texts (portal description, social caption, and "qa", the answers of buyer Q&A cards), each a list of segments with an "id", the "text", the "factIds" it cites, and "audit". The "qa" entry also has "questions", the buyer questions by card; a Q&A segment's "paragraph" is the number of its card.
`;

const QA_RULE = `

A buyer question is not a claim and cites nothing, but it is published with its answer: read every audited Q&A segment together with its question, apply the phrasing rules to both, and flag a question that breaks a rule or presumes something no cited fact states on the first segment of its card (quote the question in "problem").`;

/**
 * The system prompt for one request: the P3-06 prompt without Q&A cards; with them, the "copy"
 * line names the Q&A answers and their questions, and one paragraph says how to read questions.
 */
export function verificationSystemPrompt(withQa: boolean): string {
  if (!withQa) return COPY_ONLY_PROMPT;
  const marker = 'Code has already checked';
  const prompt = COPY_ONLY_PROMPT.replace(
    `- "copy": the texts (portal description, social caption), each a list of segments with an "id", the "text", the "factIds" it cites, and "audit".\n`,
    QA_COPY_LINE,
  );
  const at = prompt.indexOf('\n\nBe precise');
  if (prompt === COPY_ONLY_PROMPT || at < 0 || !prompt.includes(marker)) {
    throw new Error('The verification prompt no longer has the expected structure');
  }
  return `${prompt.slice(0, at)}${QA_RULE}${prompt.slice(at)}`;
}
