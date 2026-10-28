import type {
  BasisNote,
  ConflictKind,
  FactConflict,
  FactOutcome,
  FactOutcomeReason,
  FactSheetEntry,
  FactSourceKind,
  MarketProfile,
  ReconciliationDecider,
  ReconciliationDiagnostics,
} from '@evidomo/shared';
import { profileUnit } from '../extraction/normalize.ts';
import type { Catalog, CatalogFact } from './catalog.ts';
import { compareMeasures, compareProfileFacts, groupByMeasure, sameValue } from './compare.ts';
import type { ReconciliationStepOutput } from './schema.ts';

// Turns the candidates and the model's (untrusted) judgment into the Verified Fact Sheet and
// the conflict list (docs/architecture.md §5 step 4). Code decides; the model proposes:
//
// - Opinions are rejected and never verified (also a database check).
// - Market facts (the profile's keys) are compared by code alone, on value + unit + basis.
// - The model groups `other:` facts and photo evidence, finds contradictions code cannot see,
//   and rejects non-facts. Every cited ID must exist; a verified value must equal the value of a
//   cited candidate exactly; cited values that disagree on one measure make the group a
//   conflict; the basis rule overrides the model's conflicts on measurements.
// - Escalation is allowed, de-escalation is not: a valid model conflict may pull verified facts
//   into Gate 1, but the model can never verify a market fact, reject a form value or a photo
//   observation, or verify a transcript candidate it did not account for.

const MAX_EXPLANATION = 300;
const MAX_CONFLICT_EXPLANATION = 1200;

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

interface EntryDraft {
  readonly kind: 'entry';
  readonly anchor: CatalogFact;
  readonly members: readonly CatalogFact[];
  readonly corroborating: readonly CatalogFact[];
  readonly reason: FactSheetEntry['reason'];
  readonly decidedBy: ReconciliationDecider;
}

interface ConflictDraft {
  readonly kind: 'conflict';
  readonly members: readonly CatalogFact[];
  readonly conflictKind: ConflictKind;
  readonly detectedBy: ReconciliationDecider;
  readonly explanation: string;
}

type Draft = EntryDraft | ConflictDraft;

interface RuleRejection {
  readonly reason: 'opinion' | 'different_basis' | 'different_unit';
  /** The draft of the same quantity, for the basis note. */
  readonly related: Draft | null;
  readonly profileBasis: string | null;
}

interface ModelRejection {
  readonly reason: 'opinion' | 'out_of_scope' | 'ambiguous';
  readonly note: string;
}

export interface ReconciliationResult {
  readonly entries: FactSheetEntry[];
  readonly conflicts: FactConflict[];
  readonly basisNotes: BasisNote[];
  readonly outcomes: FactOutcome[];
  readonly diagnostics: ReconciliationDiagnostics;
}

/** An invariant of the result does not hold: a bug, never a model or data problem. */
export class ReconciliationInvariantError extends Error {
  override name = 'ReconciliationInvariantError';
}

function emptyDiagnostics(modelCalled: boolean): ReconciliationDiagnostics {
  return {
    modelCalled,
    verifiedProposed: 0,
    verifiedAccepted: 0,
    verifiedEscalated: 0,
    verifiedDropped: {},
    conflictsProposed: 0,
    conflictsAccepted: 0,
    conflictsDropped: {},
    rejectionsProposed: 0,
    rejectionsAccepted: 0,
    rejectionsIgnored: {},
    citationsStripped: {},
    unknownEvidenceIds: 0,
  };
}

function bump(counter: Record<string, number>, reason: string): void {
  counter[reason] = (counter[reason] ?? 0) + 1;
}

/** The model may drop the `other:` prefix it was shown; nothing else is tolerated. */
function keyMatches(modelKey: string, factKey: string): boolean {
  return modelKey === factKey || `other:${modelKey}` === factKey;
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/** Minimal union-find over fact IDs. */
function createUnionFind() {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    for (
      let next = parent.get(root);
      next !== undefined && next !== root;
      next = parent.get(root)
    ) {
      root = next;
    }
    parent.set(id, root);
    return root;
  };
  return {
    add(id: string): void {
      if (!parent.has(id)) parent.set(id, id);
    },
    union(a: string, b: string): void {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent.set(rootB, rootA);
    },
    find,
  };
}

export function resolveReconciliation(
  market: MarketProfile,
  catalog: Catalog,
  output: ReconciliationStepOutput | null,
): ReconciliationResult {
  const diagnostics = emptyDiagnostics(output !== null);
  const order = new Map(catalog.items.map((item, index) => [item.fact.id, index]));
  const byOrder = (a: CatalogFact, b: CatalogFact): number =>
    (order.get(a.fact.id) ?? 0) - (order.get(b.fact.id) ?? 0);

  const drafts: Draft[] = [];
  const ruleRejected = new Map<string, { item: CatalogFact; rejection: RuleRejection }>();
  const rejectByRule = (item: CatalogFact, rejection: RuleRejection): void => {
    ruleRejected.set(item.fact.id, { item, rejection });
  };

  // 1. Opinions: never verified, never compared.
  for (const item of catalog.items) {
    if (item.assertion === 'opinion') {
      rejectByRule(item, { reason: 'opinion', related: null, profileBasis: null });
    }
  }
  const stated = catalog.items.filter((item) => item.assertion === 'stated');

  // 2. Market facts: deterministic comparison per key.
  const profileKeys = new Set(market.facts.map((fact) => fact.key));
  const codeOwned = new Set<string>();
  for (const fact of market.facts) {
    const items = stated.filter((item) => item.key === fact.key);
    for (const item of items) codeOwned.add(item.fact.id);
    if (items.length === 0) continue;
    const measure = {
      key: fact.key,
      unit: profileUnit(market, fact),
      basis: fact.type === 'area' ? fact.basis : null,
    };
    const comparison = compareProfileFacts(measure, items);
    let related: Draft | null = null;
    if (comparison.kind === 'verified') {
      const [anchor] = comparison.members;
      if (anchor === undefined) throw new ReconciliationInvariantError('Empty verified group');
      const draft: EntryDraft = {
        kind: 'entry',
        anchor,
        members: comparison.members,
        corroborating: comparison.corroborating,
        reason:
          comparison.members.length + comparison.corroborating.length > 1
            ? 'agreement'
            : 'single_source',
        decidedBy: 'code',
      };
      drafts.push(draft);
      related = draft;
    } else if (comparison.kind === 'conflict') {
      const values = comparison.sides.map((side) => JSON.stringify(side[0]?.value)).join(' vs ');
      const draft: ConflictDraft = {
        kind: 'conflict',
        members: comparison.sides.flat(),
        conflictKind: 'value_mismatch',
        detectedBy: 'code',
        explanation: clip(
          `${fact.key}: the sources state different values on the same measure (${[measure.unit, measure.basis].filter((part) => part !== null).join(', ') || 'no unit'}): ${values}.`,
          MAX_CONFLICT_EXPLANATION,
        ),
      };
      drafts.push(draft);
      related = draft;
    }
    for (const off of comparison.offMeasure) {
      rejectByRule(off.item, { reason: off.reason, related, profileBasis: measure.basis });
    }
  }

  // 3. The model's judgment, verified citation by citation.
  const modelConflictFacts = new Set<string>();
  const claimedByGroup = new Set<string>();
  const modelRejected = new Map<string, ModelRejection>();
  if (output !== null) {
    const resolve = (ids: readonly string[]): CatalogFact[] => {
      const items: CatalogFact[] = [];
      for (const id of unique(ids)) {
        const item = catalog.sent.get(id);
        if (item === undefined) diagnostics.unknownEvidenceIds += 1;
        else items.push(item);
      }
      return items;
    };

    // Conflicts first: they may overlap anything (escalation), groups may not overlap.
    for (const proposed of output.conflicts) {
      diagnostics.conflictsProposed += 1;
      const members = resolve(proposed.evidenceIds).filter((item) => {
        if (!ruleRejected.has(item.fact.id)) return true;
        bump(diagnostics.citationsStripped, 'decided_by_rule');
        return false;
      });
      if (members.length < 2) {
        bump(diagnostics.conflictsDropped, 'too_few_evidence');
        continue;
      }
      const keys = unique(members.map((item) => item.key));
      const [onlyKey] = keys;
      if (keys.length === 1 && onlyKey !== undefined && profileKeys.has(onlyKey)) {
        // Same-key comparisons of market facts are code's alone (the basis rule).
        bump(diagnostics.conflictsDropped, 'market_fact_compared_by_code');
        continue;
      }
      const measured = members.filter((item) => item.unit !== null);
      const statements = members.filter(
        (item) => item.unit === null && item.sourceKind !== 'photo_region',
      );
      let kept: CatalogFact[];
      if (measured.length === members.length) {
        // Measurements only: the basis rule decides. A value contradicts only another value
        // of the same unit and basis; values on other measures are removed.
        kept = measured.filter((item) =>
          measured.some(
            (other) => other !== item && compareMeasures(item, other).relation === 'contradict',
          ),
        );
        for (let i = kept.length; i < measured.length; i += 1) {
          bump(diagnostics.citationsStripped, 'measure_not_contradicted');
        }
      } else if (measured.length > 0) {
        // A measurement against a statement (e.g. "no ground lease" vs a ground lease fee) is a
        // semantic contradiction. A photo shows part of the property and cannot contradict a
        // measurement, so photos are removed.
        kept = [...measured, ...statements];
        for (let i = statements.length + measured.length; i < members.length; i += 1) {
          bump(diagnostics.citationsStripped, 'photo_cannot_contradict_measurement');
        }
      } else {
        kept = members;
      }
      if (groupByMeasure(kept).length < 2) {
        bump(diagnostics.conflictsDropped, 'no_disagreement');
        continue;
      }
      diagnostics.conflictsAccepted += 1;
      for (const item of kept) modelConflictFacts.add(item.fact.id);
      drafts.push({
        kind: 'conflict',
        members: [...kept].sort(byOrder),
        conflictKind: proposed.kind,
        detectedBy: 'model',
        explanation:
          clip(proposed.explanation, MAX_EXPLANATION) || 'Contradiction found by the model.',
      });
    }

    for (const proposed of output.verifiedFacts) {
      diagnostics.verifiedProposed += 1;
      const members = resolve(proposed.evidenceIds).filter((item) => {
        const reason = codeOwned.has(item.fact.id)
          ? 'market_fact_compared_by_code'
          : ruleRejected.has(item.fact.id)
            ? 'decided_by_rule'
            : claimedByGroup.has(item.fact.id)
              ? 'cited_by_another_entry'
              : undefined;
        if (reason === undefined) return true;
        bump(diagnostics.citationsStripped, reason);
        return false;
      });
      if (members.length === 0) {
        bump(diagnostics.verifiedDropped, 'no_valid_evidence');
        continue;
      }
      // The verified value must be a cited candidate's value, exactly, under its key.
      const anchor = members.find(
        (item) =>
          item.sourceKind !== 'photo_region' &&
          keyMatches(proposed.key, item.key) &&
          sameValue(proposed.value, item.value),
      );
      if (anchor === undefined) {
        bump(diagnostics.verifiedDropped, 'value_not_cited');
        continue;
      }
      const kept: CatalogFact[] = [anchor];
      const contradicting: CatalogFact[] = [];
      const offMeasure: { item: CatalogFact; reason: 'different_basis' | 'different_unit' }[] = [];
      for (const item of members) {
        if (item === anchor) continue;
        if (item.sourceKind === 'photo_region') {
          if (anchor.unit === null) kept.push(item);
          else bump(diagnostics.citationsStripped, 'photo_cannot_support_measurement');
          continue;
        }
        const relation = compareMeasures(anchor, item);
        if (relation.relation === 'agree') kept.push(item);
        else if (
          relation.relation === 'contradict' &&
          anchor.unit === null &&
          item.key !== anchor.key
        ) {
          // Different statements under different keys ("Kwartelhoflaan" next to a full address)
          // can be related without being one fact: not support, and not a contradiction either.
          bump(diagnostics.citationsStripped, 'value_differs');
        } else if (relation.relation === 'contradict') contradicting.push(item);
        else if (modelConflictFacts.has(item.fact.id)) {
          bump(diagnostics.citationsStripped, relation.reason);
        } else offMeasure.push({ item, reason: relation.reason });
      }
      for (const item of [...kept, ...contradicting, ...offMeasure.map((off) => off.item)]) {
        claimedByGroup.add(item.fact.id);
      }
      let draft: Draft;
      if (contradicting.length > 0) {
        // The model called these one fact, and they disagree on one measure: a contradiction.
        diagnostics.verifiedEscalated += 1;
        draft = {
          kind: 'conflict',
          members: [...kept, ...contradicting].sort(byOrder),
          conflictKind: 'value_mismatch',
          detectedBy: 'code',
          explanation:
            'These statements describe one fact but give different values on the same measure.',
        };
      } else {
        diagnostics.verifiedAccepted += 1;
        draft = {
          kind: 'entry',
          anchor,
          members: [...kept].sort(byOrder),
          corroborating: [],
          reason: 'model_verified',
          decidedBy: 'model',
        };
      }
      drafts.push(draft);
      for (const off of offMeasure) {
        rejectByRule(off.item, { reason: off.reason, related: draft, profileBasis: anchor.basis });
      }
    }

    for (const proposed of output.rejected) {
      diagnostics.rejectionsProposed += 1;
      const [item] = resolve([proposed.evidenceId]);
      if (item === undefined) {
        bump(diagnostics.rejectionsIgnored, 'unknown_evidence');
        continue;
      }
      const id = item.fact.id;
      const ignored = codeOwned.has(id)
        ? 'market_fact_compared_by_code'
        : item.sourceKind !== 'transcript_turn'
          ? 'form_or_photo_not_rejectable'
          : ruleRejected.has(id) || claimedByGroup.has(id) || modelConflictFacts.has(id)
            ? 'already_decided'
            : modelRejected.has(id)
              ? 'duplicate'
              : undefined;
      if (ignored !== undefined) {
        bump(diagnostics.rejectionsIgnored, ignored);
        continue;
      }
      diagnostics.rejectionsAccepted += 1;
      modelRejected.set(id, {
        reason: proposed.reason,
        note: clip(proposed.explanation, MAX_EXPLANATION),
      });
    }
  }

  // 4. Form values and photo observations nothing grouped or contradicted stand on their own:
  // the form is the source of truth, and an observation is what the photo shows.
  const inDraft = new Set(
    drafts.flatMap((draft) =>
      draft.kind === 'entry'
        ? [...draft.members, ...draft.corroborating].map((item) => item.fact.id)
        : draft.members.map((item) => item.fact.id),
    ),
  );
  for (const item of stated) {
    const id = item.fact.id;
    if (inDraft.has(id) || ruleRejected.has(id) || modelRejected.has(id)) continue;
    if (item.sourceKind === 'form' || item.sourceKind === 'photo_region') {
      drafts.push({
        kind: 'entry',
        anchor: item,
        members: [item],
        corroborating: [],
        reason: 'single_source',
        decidedBy: 'code',
      });
    }
  }

  // 5. Merge: a conflict pulls in every entry and conflict it touches, so conflicts are
  // disjoint and no entry is half verified.
  const unionFind = createUnionFind();
  const membersOf = (draft: Draft): readonly CatalogFact[] =>
    draft.kind === 'entry' ? [...draft.members, ...draft.corroborating] : draft.members;
  for (const draft of drafts) {
    const [first, ...rest] = membersOf(draft);
    if (first === undefined) throw new ReconciliationInvariantError('Empty draft');
    unionFind.add(first.fact.id);
    for (const item of rest) {
      unionFind.add(item.fact.id);
      unionFind.union(first.fact.id, item.fact.id);
    }
  }
  const components = new Map<string, Draft[]>();
  for (const draft of drafts) {
    const [first] = membersOf(draft);
    if (first === undefined) continue;
    const root = unionFind.find(first.fact.id);
    components.set(root, [...(components.get(root) ?? []), draft]);
  }

  interface FinalEntry {
    readonly draft: EntryDraft;
  }
  interface FinalConflict {
    readonly members: CatalogFact[];
    readonly drafts: readonly Draft[];
  }
  const finalEntries: FinalEntry[] = [];
  const finalConflicts: FinalConflict[] = [];
  for (const group of components.values()) {
    if (group.some((draft) => draft.kind === 'conflict')) {
      const members = unique(group.flatMap(membersOf)).sort(byOrder);
      finalConflicts.push({ members, drafts: group });
    } else {
      for (const draft of group) if (draft.kind === 'entry') finalEntries.push({ draft });
    }
  }

  // 6. IDs in key order, then catalog order.
  const firstIndex = (items: readonly CatalogFact[]): number =>
    Math.min(...items.map((item) => order.get(item.fact.id) ?? 0));
  finalEntries.sort(
    (a, b) =>
      (a.draft.anchor.key < b.draft.anchor.key
        ? -1
        : a.draft.anchor.key > b.draft.anchor.key
          ? 1
          : 0) || firstIndex(membersOf(a.draft)) - firstIndex(membersOf(b.draft)),
  );
  const conflictKey = (members: readonly CatalogFact[]): string => {
    const counts = new Map<string, number>();
    for (const item of members) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
    let best = members[0]?.key ?? '';
    for (const [key, n] of counts) if (n > (counts.get(best) ?? 0)) best = key;
    return best;
  };
  finalConflicts.sort((a, b) => {
    const keyA = conflictKey(a.members);
    const keyB = conflictKey(b.members);
    return (
      (keyA < keyB ? -1 : keyA > keyB ? 1 : 0) || firstIndex(a.members) - firstIndex(b.members)
    );
  });

  const placement = new Map<Draft, { entryId: string | null; conflictId: string | null }>();
  const sourceKinds = (items: readonly CatalogFact[]): FactSourceKind[] =>
    unique(items.map((item) => item.sourceKind));

  const entries: FactSheetEntry[] = finalEntries.map(({ draft }, index) => {
    const id = `V${String(index + 1).padStart(2, '0')}`;
    placement.set(draft, { entryId: id, conflictId: null });
    const items = [...membersOf(draft)].sort(byOrder);
    return {
      id,
      key: draft.anchor.key,
      value: draft.anchor.value,
      unit: draft.anchor.unit,
      basis: draft.anchor.basis,
      factIds: items.map((item) => item.fact.id),
      evidenceIds: items.map((item) => item.evidenceId),
      sourceKinds: sourceKinds(items),
      reason: draft.reason,
      decidedBy: draft.decidedBy,
    };
  });

  const conflicts: FactConflict[] = finalConflicts.map(({ members, drafts: group }, index) => {
    const id = `K${String(index + 1).padStart(2, '0')}`;
    for (const draft of group) placement.set(draft, { entryId: null, conflictId: id });
    const conflictDrafts = group.filter((draft) => draft.kind === 'conflict');
    const kinds = unique(conflictDrafts.map((draft) => draft.conflictKind));
    const [onlyKind] = kinds;
    return {
      id,
      key: conflictKey(members),
      kind: kinds.length === 1 && onlyKind !== undefined ? onlyKind : 'other',
      detectedBy: unique(conflictDrafts.map((draft) => draft.detectedBy)).sort(),
      explanation: clip(
        unique(conflictDrafts.map((draft) => draft.explanation)).join(' '),
        MAX_CONFLICT_EXPLANATION,
      ),
      factIds: members.map((item) => item.fact.id),
      sides: groupByMeasure(members).map((side) => {
        const [first] = side;
        if (first === undefined) throw new ReconciliationInvariantError('Empty conflict side');
        return {
          key: first.key,
          value: first.value,
          unit: first.unit,
          basis: first.basis,
          factIds: side.map((item) => item.fact.id),
          evidenceIds: side.map((item) => item.evidenceId),
          sourceKinds: sourceKinds(side),
        };
      }),
    };
  });

  // 7. One outcome per candidate.
  const entryOf = new Map<string, { entry: FactSheetEntry; corroborating: boolean }>();
  for (const { draft } of finalEntries) {
    const place = placement.get(draft);
    const entry = entries.find((candidate) => candidate.id === place?.entryId);
    if (entry === undefined) throw new ReconciliationInvariantError('Entry without an ID');
    for (const item of draft.members) entryOf.set(item.fact.id, { entry, corroborating: false });
    for (const item of draft.corroborating)
      entryOf.set(item.fact.id, { entry, corroborating: true });
  }
  const conflictOf = new Map<string, FactConflict>();
  for (const conflict of conflicts) for (const id of conflict.factIds) conflictOf.set(id, conflict);

  const basisNotes: BasisNote[] = [];
  const outcomes: FactOutcome[] = catalog.items.map((item) => {
    const id = item.fact.id;
    const base = {
      factId: id,
      evidenceId: item.evidenceId,
      entryId: null,
      conflictId: null,
      note: null,
    };
    const conflict = conflictOf.get(id);
    if (conflict !== undefined) {
      const reason: FactOutcomeReason = conflict.detectedBy.includes('model')
        ? 'model_conflict'
        : 'value_mismatch';
      return {
        ...base,
        status: 'conflicted',
        reason,
        decidedBy: conflict.detectedBy.includes('model') ? 'model' : 'code',
        conflictId: conflict.id,
      };
    }
    const placed = entryOf.get(id);
    if (placed !== undefined) {
      return {
        ...base,
        status: 'verified',
        reason: placed.corroborating ? 'corroborating' : placed.entry.reason,
        decidedBy: placed.entry.decidedBy,
        entryId: placed.entry.id,
      };
    }
    const rule = ruleRejected.get(id);
    if (rule !== undefined) {
      const { reason, related, profileBasis } = rule.rejection;
      if (reason !== 'opinion') {
        const place = related === null ? undefined : placement.get(related);
        basisNotes.push({
          factId: id,
          evidenceId: item.evidenceId,
          key: item.key,
          value: item.value,
          unit: item.unit,
          basis: item.basis,
          reason,
          relatedEntryId: place?.entryId ?? null,
          relatedConflictId: place?.conflictId ?? null,
          explanation:
            reason === 'different_unit'
              ? `Stated in ${item.unit ?? 'no unit'}, not the unit this fact is compared in; neither support nor a contradiction.`
              : `Stated on basis "${item.basis ?? 'none'}", not "${profileBasis ?? 'none'}"; a different measure is neither support nor a contradiction.`,
        });
      }
      return { ...base, status: 'rejected', reason, decidedBy: 'code' };
    }
    const rejected = modelRejected.get(id);
    if (rejected !== undefined) {
      return {
        ...base,
        status: 'rejected',
        reason: rejected.reason,
        decidedBy: 'model',
        note: rejected.note,
      };
    }
    return { ...base, status: 'rejected', reason: 'not_reconciled', decidedBy: 'code' };
  });

  assertInvariants(catalog, entries, conflicts, outcomes);
  return { entries, conflicts, basisNotes, outcomes, diagnostics };
}

function assertInvariants(
  catalog: Catalog,
  entries: readonly FactSheetEntry[],
  conflicts: readonly FactConflict[],
  outcomes: readonly FactOutcome[],
): void {
  const items = new Map(catalog.items.map((item) => [item.fact.id, item]));
  if (
    outcomes.length !== items.size ||
    new Set(outcomes.map((o) => o.factId)).size !== items.size
  ) {
    throw new ReconciliationInvariantError('Every candidate needs exactly one outcome');
  }
  for (const outcome of outcomes) {
    if (outcome.status === 'verified' && items.get(outcome.factId)?.assertion === 'opinion') {
      throw new ReconciliationInvariantError('An opinion cannot be verified');
    }
  }
  for (const entry of entries) {
    const supported = entry.factIds.some((id) => {
      const item = items.get(id);
      return item !== undefined && item.key === entry.key && sameValue(item.value, entry.value);
    });
    if (!supported)
      throw new ReconciliationInvariantError('A sheet value must equal a cited value');
  }
  const seen = new Set<string>();
  for (const conflict of conflicts) {
    if (conflict.sides.length < 2) throw new ReconciliationInvariantError('One-sided conflict');
    for (const id of conflict.factIds) {
      if (seen.has(id)) throw new ReconciliationInvariantError('Conflicts must be disjoint');
      seen.add(id);
    }
  }
}
