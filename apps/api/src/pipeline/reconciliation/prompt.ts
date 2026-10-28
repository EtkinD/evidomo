import type { ReconciliationInput } from './schema.ts';

// Reconciliation prompt, first measured in P1-03 (docs/model-notes.md). Changing the wording or
// the serialization changes the request hash, so the P1-03 fixtures must be re-recorded with it.

export const RECONCILIATION_SYSTEM_PROMPT = `You reconcile property facts for a real-estate listing. The user message is a JSON evidence catalog for one property:
- "form": values the listing agent entered in the fact form. The form is the source of truth for publication. A null value means unknown.
- "transcript": turns of the agent's voice walkthrough, for context.
- "candidates": candidate facts extracted from the transcript. Each cites the turn it came from and a verbatim quote.
- "photos": photo observations from the vision inventory, each with region IDs.
- "inventory": aggregates over several photos, such as counted rooms.

Return a Verified Fact Sheet, a conflict list, notes on measurement-basis differences, and rejected candidates.

Rules:
1. Cite evidence only by catalog IDs: form IDs ("F.living_area"), candidate IDs ("C05"), photo region IDs ("P05.R1"), and inventory IDs ("INV1"). Never cite turn IDs and never invent IDs.
2. verifiedFacts: one entry per distinct fact that the evidence supports and no evidence contradicts. Cite every catalog item that supports it. A stated fact from a candidate that nothing contradicts may be verified on that candidate alone.
3. Copy numbers exactly from the cited evidence. Never round, convert units, add up, or compute new numbers.
4. Areas and volumes are compared as value + unit + basis. Two values conflict only when they measure the same quantity on the same basis (for example, both NEN 2580 living area) and the values differ. A value with a different or unstated basis that measures something else (a gross area, an area including storage or walls) is a separate fact, not a conflict: describe it in distinctBasisNotes. A value without a stated basis that equals the form value supports the form value.
5. Counts (bedrooms, bathrooms, toilets) conflict when sources give different numbers for the same thing, including transcript versus photo inventory.
6. Contradicting the form is still a conflict: report it with both sides' evidence. A human resolves conflicts, so a fact in conflict appears only in conflicts, never in verifiedFacts.
7. Each conflict lists at least two sides, one per evidence item, with that item's value, unit, and basis.
8. Opinions, predictions, sales talk, and subjective judgments (for example "the most beautiful street", "it will only increase in value") are never verified facts, however confidently stated. Put them in rejected with reason "opinion".
9. Photos support presence and counts. They do not prove years, measurements, or brands.
10. Account for every candidate: cite it in verifiedFacts or in a conflict, or list it in rejected.
11. Do not create facts for form fields whose value is null.
12. Write keys in snake_case English and text values in English. Use "yes"/"no" for presence.`;

/** The user message: the evidence catalog as compact JSON (whitespace costs input tokens). */
export function buildReconciliationPrompt(input: ReconciliationInput): string {
  return JSON.stringify(input);
}
