import type { ReconciliationInput } from './schema.ts';

// The reconciliation step's prompt (P2-09), derived from the P1-03 prototype in `prompt.ts`
// (which stays as recorded for its measurement fixtures). Differences: market facts are compared
// in code, opinions are removed before the call, the answer cites IDs and copies one candidate's
// key and value instead of echoing units and bases, values are not translated, and photos carry
// per-photo counts with no cross-photo aggregates. Changing the wording or the serialization
// changes the request hash: re-record the P2-09 fixtures and bump the prompt version.

/** Stored in the fact sheet artifact; bump whenever the prompt or the output schema changes. */
export const RECONCILIATION_PROMPT_VERSION = 1;

/** Structured-output name sent to the API (and part of the fixture's request hash). */
export const RECONCILIATION_OUTPUT_NAME = 'reconciliation';

export const RECONCILIATION_STEP_SYSTEM_PROMPT = `You reconcile property facts for a real-estate listing. The user message is a JSON evidence catalog for one property:
- "marketFacts": the market's typed facts (key, type, unit, basis). Code compares every form field and candidate with these keys on value + unit + basis.
- "form": values the listing agent entered. The form is the source of truth for publication.
- "transcript": turns of the agent's voice walkthrough, for context.
- "candidates": stated facts extracted from the transcript, each with its turn and a verbatim quote. Keys outside the market facts start with "other:". Opinions were already removed.
- "photos": photo observations. Each region ID is one kind of object seen in that photo, with its count in that photo only.

Return verifiedFacts, conflicts, and rejected. Code checks every entry against the catalog and discards entries that break a rule.

Rules:
1. Cite evidence only by catalog IDs: form IDs ("F.street_name"), candidate IDs ("C05"), and photo region IDs ("P03.R1"). Never cite turn IDs and never invent IDs.
2. Do not put market-fact form fields or candidates (keys listed in marketFacts) in verifiedFacts or rejected: code reconciles them. Cite them only in a conflict with evidence under a different key that contradicts them.
3. verifiedFacts: one entry per distinct "other:" fact that the evidence supports and nothing contradicts. Cite every form field and candidate that states the same fact. A stated candidate that nothing contradicts may be verified on its own.
4. In verifiedFacts, copy key and value exactly from one cited form field or candidate. Never translate, round, convert units, add up, or compute a value.
5. Photo regions may be cited in verifiedFacts as support for the presence of a thing or feature, never for a measurement (area, volume, money, year). A photo shows only part of the property: never derive totals or room counts from photos.
6. Measurements are compared as value + unit + basis. Values for the same quantity with the same unit and basis that differ are a conflict. A value on a different basis, or one that measures something else (a gross area, an area including storage or walls, one room versus the whole home), is a separate fact, not a conflict.
7. conflicts: form fields or candidates that state different values for the same thing, or a photo that shows something a statement says is absent. Cite every item involved, at least two. A human resolves conflicts, so do not also verify those items.
8. rejected: "other:" candidates that are subjective after all ("opinion"), are not about the property ("out_of_scope"), or are too vague to state as a fact ("ambiguous").
9. Account for every "other:" candidate: cite it in verifiedFacts or in a conflict, or list it in rejected. Photo regions need no accounting.
10. Keep each explanation to one short English sentence.`;

/** The user message: the evidence catalog as compact JSON (whitespace costs input tokens). */
export function buildReconciliationStepPrompt(input: ReconciliationInput): string {
  return JSON.stringify(input);
}
