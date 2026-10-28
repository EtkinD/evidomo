import {
  evidenceIds,
  evidenceValue,
  type ReconciliationInput,
  type ReconciliationOutput,
} from './schema.ts';
import type { ReconciliationExpectations } from './synthetic-nl-apartment.ts';

// Deterministic scoring of a reconciliation output against planted defects. Used for the P1-03
// quality table and the seeded-defect eval; tests do not assert one recording's score.

export interface ReconciliationScore {
  /** Planted conflict ID -> caught. */
  readonly conflictsCaught: Readonly<Record<string, boolean>>;
  /** Conflicts that match no planted conflict (false positives). */
  readonly extraConflicts: number;
  /** IDs from `neverInConflict` that appeared in a conflict. */
  readonly falseConflictEvidence: readonly string[];
  /** IDs from `neverVerified` that a verified fact cited. */
  readonly wronglyVerifiedEvidence: readonly string[];
  /** Opinion candidates rejected with reason `opinion`. */
  readonly opinionsRejectedAsOpinion: number;
  /** Provenance: IDs cited anywhere that are not in the catalog. */
  readonly unknownEvidenceIds: readonly string[];
  /** Provenance: verified fact keys with no evidence. */
  readonly verifiedWithoutEvidence: readonly string[];
  /** Provenance: numeric verified facts whose value equals no cited evidence value. */
  readonly numericMismatches: readonly string[];
  /** Conflicts with fewer than two sides. */
  readonly oneSidedConflicts: readonly string[];
  /** Candidates not cited in verifiedFacts or conflicts and not rejected. */
  readonly unaccountedCandidates: readonly string[];
  readonly expectedVerifiedCovered: number;
  readonly expectedVerifiedTotal: number;
}

function conflictEvidence(conflict: ReconciliationOutput['conflicts'][number]): Set<string> {
  return new Set(conflict.sides.map((side) => side.evidenceId));
}

export function scoreReconciliation(
  input: ReconciliationInput,
  expectations: ReconciliationExpectations,
  output: ReconciliationOutput,
): ReconciliationScore {
  const catalog = evidenceIds(input);
  const verifiedCited = new Set(output.verifiedFacts.flatMap((fact) => fact.evidenceIds));
  const conflictSets = output.conflicts.map(conflictEvidence);
  const inAnyConflict = new Set(conflictSets.flatMap((set) => [...set]));

  const conflictsCaught: Record<string, boolean> = {};
  const matchedConflicts = new Set<number>();
  for (const planted of expectations.conflicts) {
    const index = conflictSets.findIndex(
      (set) =>
        planted.all.every((id) => set.has(id)) &&
        (planted.anyOf.length === 0 || planted.anyOf.some((id) => set.has(id))),
    );
    conflictsCaught[planted.id] = index !== -1;
    if (index !== -1) matchedConflicts.add(index);
  }

  const cited = [
    ...verifiedCited,
    ...inAnyConflict,
    ...output.distinctBasisNotes.flatMap((note) => note.evidenceIds),
    ...output.rejected.map((item) => item.evidenceId),
  ];

  const numericMismatches = output.verifiedFacts
    .filter((fact) => typeof fact.value === 'number')
    .filter((fact) => !fact.evidenceIds.some((id) => evidenceValue(input, id) === fact.value))
    .map((fact) => `${fact.key}=${String(fact.value)}`);

  const rejectedIds = new Set(output.rejected.map((item) => item.evidenceId));
  const opinionRejections = new Set(
    output.rejected.filter((item) => item.reason === 'opinion').map((item) => item.evidenceId),
  );

  return {
    conflictsCaught,
    extraConflicts: output.conflicts.length - matchedConflicts.size,
    falseConflictEvidence: expectations.neverInConflict
      .flatMap((rule) => rule.evidenceIds)
      .filter((id) => inAnyConflict.has(id)),
    wronglyVerifiedEvidence: expectations.neverVerified
      .flatMap((rule) => rule.evidenceIds)
      .filter((id) => verifiedCited.has(id)),
    opinionsRejectedAsOpinion: expectations.opinions.filter((id) => opinionRejections.has(id))
      .length,
    unknownEvidenceIds: [...new Set(cited.filter((id) => !catalog.has(id)))],
    verifiedWithoutEvidence: output.verifiedFacts
      .filter((fact) => fact.evidenceIds.length === 0)
      .map((fact) => fact.key),
    numericMismatches,
    oneSidedConflicts: output.conflicts
      .filter((conflict) => conflictEvidence(conflict).size < 2)
      .map((conflict) => conflict.key),
    unaccountedCandidates: input.candidates
      .map((candidate) => candidate.id)
      .filter((id) => !verifiedCited.has(id) && !inAnyConflict.has(id) && !rejectedIds.has(id)),
    expectedVerifiedCovered: expectations.expectedVerified.filter((id) => verifiedCited.has(id))
      .length,
    expectedVerifiedTotal: expectations.expectedVerified.length,
  };
}
