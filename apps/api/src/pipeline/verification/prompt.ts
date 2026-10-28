import type { VerificationInput } from './schema.ts';

// Verification prompt, first measured in P1-03 (docs/model-notes.md). Changing the wording or
// the serialization changes the request hash, so the P1-03 fixture must be re-recorded with it.

export const VERIFICATION_SYSTEM_PROMPT = `You audit real-estate listing copy before publication. The user message is JSON with:
- "facts": the Verified Fact Sheet. It is the only source of truth.
- "marketRules": publication rules for this market.
- "segments": copy segments (portal description, social posts, buyer Q&A), each citing fact IDs.

Code has already checked that every cited fact ID exists and that every number in a segment equals a cited fact's value. Your job is semantic: does the wording mean what the cited facts say, and does it follow the market rules?

For every segment, return exactly one audit:
- verdict "supported": every statement in the segment is justified by the facts it cites, and no market rule is broken.
- verdict "unsupported": some statement is not justified by the cited facts (an added feature, an overstated or reinterpreted fact, a number used for a different quantity than the fact measures). Facts the segment does not cite do not support it.
- verdict "flagged": the segment breaks a market rule (superlative, investment promise, exclusionary phrasing, area basis, or another rule), whether or not its facts are cited correctly.
- issues: one entry per problem, with a category and a short explanation. Empty for "supported".
- suggestedRevision: a rewrite that keeps only what the cited facts support and follows the rules, or null when the segment is supported.

Be precise, not pedantic: neutral connecting words and plain descriptions of a cited fact are supported.`;

/** The user message: the audit input as compact JSON. */
export function buildVerificationPrompt(input: VerificationInput): string {
  return JSON.stringify(input);
}
