import type { ClaimAuditCategory, ClaimAuditFlagSource, ClaimAuditVariant } from '@evidomo/shared';
import type { AppliedInjection, SkippedInjection } from './inject.ts';
import type {
  BasisNoteExpectation,
  ConflictExpectation,
  EvalSourceKind,
  Injection,
  Temptation,
} from './sets.ts';

// Answer-key matching and metrics for the seeded-defect eval (docs/architecture.md §12). Pure:
// the runner collects what a run stored (`collect.ts`), this module compares it with the set's
// answer key, and the report prints it.

// --- What a run produced -------------------------------------------------------------------

export interface ObservedFact {
  readonly key: string;
  readonly value: unknown;
  readonly source: { readonly kind: string; readonly field?: string };
}

export interface ObservedConflict {
  readonly id: string;
  readonly key: string;
  readonly detectedBy: readonly string[];
  readonly sides: readonly { readonly facts: readonly ObservedFact[] }[];
}

export interface ObservedBasisNote {
  readonly key: string;
  readonly value: unknown;
}

export interface ObservedSegment {
  readonly variant: ClaimAuditVariant;
  /** `claims.segment_index`: the segment's index in its artifact. */
  readonly segmentIndex: number;
  readonly text: string;
}

export interface ObservedFlag {
  readonly variant: ClaimAuditVariant;
  readonly segmentIndex: number;
  readonly source: ClaimAuditFlagSource;
  readonly category: ClaimAuditCategory;
  /** The claim validator's finding code; null for verifier flags. */
  readonly code: string | null;
}

/** One audited draft (copy plus Q&A answers) and its flags. */
export interface ObservedDraft {
  readonly segments: readonly ObservedSegment[];
  readonly flags: readonly ObservedFlag[];
}

export interface ObservedClaims {
  /** Pass 0: the creative and Q&A steps' drafts as stored, and their first audit. */
  readonly initial: ObservedDraft;
  /** The last audited draft and its remaining flags (what Gate 2 showed). */
  readonly final: ObservedDraft;
  readonly passes: number;
  readonly stopReason: string;
  /** Every published copy and Q&A answer text; null when the run did not export. */
  readonly exported: readonly string[] | null;
}

// --- Results -------------------------------------------------------------------------------

export interface ConflictResult {
  readonly id: string;
  readonly origin: ConflictExpectation['origin'];
  readonly decidedBy: ConflictExpectation['decidedBy'];
  readonly caught: boolean;
  /** Gate 1 conflicts that satisfy the expectation. */
  readonly conflictIds: readonly string[];
}

export interface UnexpectedConflict {
  readonly id: string;
  readonly key: string;
  readonly detectedBy: readonly string[];
}

export interface BasisNoteResult {
  readonly id: string;
  readonly found: boolean;
}

/**
 * - `not_applied`: the draft had no segment the injection could target (excluded from rates);
 * - `lost`: injected, but no stored segment of the first draft carries the marker (the
 *   pipeline's own repairs changed it), so detection cannot be judged (excluded from rates);
 * - `applied`: present in the stored first draft.
 */
export type InjectionStatus = 'applied' | 'not_applied' | 'lost';

/** What happened to an injected defect by Gate 2: revised away, still flagged, or unflagged. */
export type InjectionFinalState = 'removed' | 'flagged' | 'unflagged';

export interface InjectionResult {
  readonly id: string;
  readonly variant: Injection['variant'];
  readonly expectedCategory: ClaimAuditCategory;
  readonly expectedDetector: Injection['expect']['detector'];
  readonly status: InjectionStatus;
  readonly skipReason: SkippedInjection['reason'] | null;
  /** Flagged in pass 0 by any check. */
  readonly detected: boolean;
  readonly detectedBy: readonly ClaimAuditFlagSource[];
  /** A pass-0 flag on the segment has the expected category. */
  readonly categoryMatched: boolean;
  readonly final: InjectionFinalState | null;
  /** The marker appears in the published pack; null without an export. */
  readonly exported: boolean | null;
}

export interface TemptationResult {
  readonly id: string;
  readonly category: ClaimAuditCategory;
  /** First-draft segments (not injected) whose text matches the marker. */
  readonly appeared: number;
  readonly flagged: number;
  readonly unflaggedInFinal: number;
  readonly exported: boolean | null;
}

export interface FlagTally {
  readonly validator: number;
  readonly verifier: number;
}

export interface SetScore {
  readonly conflicts: readonly ConflictResult[];
  readonly unexpectedConflicts: readonly UnexpectedConflict[];
  readonly basisNotes: readonly BasisNoteResult[];
  readonly injections: readonly InjectionResult[];
  readonly temptations: readonly TemptationResult[];
  /** Pass-0 flags on segments that carry no injected defect. */
  readonly otherInitialFlags: FlagTally;
  /** Those flags themselves (no text: copy wording stays in the run's artifacts). */
  readonly otherFlags: readonly ObservedFlag[];
  /** Pass-0 flags in total, and the flags Gate 2 showed. */
  readonly initialFlags: FlagTally;
  readonly remainingFlags: FlagTally;
}

// --- Conflicts -----------------------------------------------------------------------------

function factMatchesPlanted(fact: ObservedFact, planted: ConflictExpectation['planted']): boolean {
  if ('formField' in planted) {
    return fact.source.kind === 'form' && fact.source.field === planted.formField;
  }
  return fact.source.kind === planted.source && new RegExp(planted.key, 'iu').test(fact.key);
}

/**
 * A conflict satisfies an expectation when one side holds the planted fact and another side a
 * fact of one of the `against` source kinds. Several expectations may share one conflict (code
 * merges conflicts that share a fact; both contradictions are still on screen at Gate 1).
 */
export function conflictSatisfies(
  conflict: ObservedConflict,
  expectation: ConflictExpectation,
): boolean {
  const against = new Set<string>(expectation.against satisfies readonly EvalSourceKind[]);
  return conflict.sides.some(
    (side, i) =>
      side.facts.some((fact) => factMatchesPlanted(fact, expectation.planted)) &&
      conflict.sides.some(
        (other, j) => j !== i && other.facts.some((fact) => against.has(fact.source.kind)),
      ),
  );
}

export function scoreConflicts(
  expectations: readonly ConflictExpectation[],
  conflicts: readonly ObservedConflict[],
): { results: ConflictResult[]; unexpected: UnexpectedConflict[] } {
  const results = expectations.map((expectation) => {
    const matching = conflicts.filter((c) => conflictSatisfies(c, expectation));
    return {
      id: expectation.id,
      origin: expectation.origin,
      decidedBy: expectation.decidedBy,
      caught: matching.length > 0,
      conflictIds: matching.map((c) => c.id),
    };
  });
  const unexpected = conflicts
    .filter((c) => !expectations.some((e) => conflictSatisfies(c, e)))
    .map((c) => ({ id: c.id, key: c.key, detectedBy: [...c.detectedBy] }));
  return { results, unexpected };
}

export function scoreBasisNotes(
  expectations: readonly BasisNoteExpectation[],
  notes: readonly ObservedBasisNote[],
): BasisNoteResult[] {
  return expectations.map((e) => ({
    id: e.id,
    found: notes.some((note) => note.key === e.key && note.value === e.value),
  }));
}

// --- Claims --------------------------------------------------------------------------------

/** A flag (or another segment) addresses this segment: same variant and artifact index. */
function sameSegment(
  item: Pick<ObservedFlag, 'variant' | 'segmentIndex'>,
  segment: ObservedSegment,
): boolean {
  return item.variant === segment.variant && item.segmentIndex === segment.segmentIndex;
}

function tally(flags: readonly ObservedFlag[]): FlagTally {
  return {
    validator: flags.filter((f) => f.source === 'validator').length,
    verifier: flags.filter((f) => f.source === 'verifier').length,
  };
}

function markerIn(marker: string, text: string): boolean {
  return new RegExp(marker, 'iu').test(text);
}

function carrying(
  draft: ObservedDraft,
  variant: ClaimAuditVariant,
  marker: string,
): ObservedSegment[] {
  return draft.segments.filter((s) => s.variant === variant && markerIn(marker, s.text));
}

function finalState(draft: ObservedDraft, variant: ClaimAuditVariant, marker: string) {
  const segments = carrying(draft, variant, marker);
  if (segments.length === 0) return 'removed' as const;
  const unflagged = segments.some((s) => !draft.flags.some((f) => sameSegment(f, s)));
  return unflagged ? ('unflagged' as const) : ('flagged' as const);
}

export function scoreInjections(
  injections: readonly Injection[],
  applied: readonly AppliedInjection[],
  skipped: readonly SkippedInjection[],
  claims: ObservedClaims,
): { results: InjectionResult[]; injectedSegments: ObservedSegment[] } {
  const injectedSegments: ObservedSegment[] = [];
  const results = injections.map((injection): InjectionResult => {
    const base = {
      id: injection.id,
      variant: injection.variant,
      expectedCategory: injection.expect.category,
      expectedDetector: injection.expect.detector,
    };
    const done = applied.find((a) => a.id === injection.id);
    if (done === undefined) {
      return {
        ...base,
        status: 'not_applied',
        skipReason: skipped.find((s) => s.id === injection.id)?.reason ?? 'no_target',
        detected: false,
        detectedBy: [],
        categoryMatched: false,
        final: null,
        exported: null,
      };
    }
    const segments = carrying(claims.initial, injection.variant, done.marker);
    if (segments.length === 0) {
      return {
        ...base,
        status: 'lost',
        skipReason: null,
        detected: false,
        detectedBy: [],
        categoryMatched: false,
        final: null,
        exported: null,
      };
    }
    injectedSegments.push(...segments);
    const flags = claims.initial.flags.filter((f) => segments.some((s) => sameSegment(f, s)));
    const detectedBy = [...new Set(flags.map((f) => f.source))].sort();
    return {
      ...base,
      status: 'applied',
      skipReason: null,
      detected: flags.length > 0,
      detectedBy,
      categoryMatched: flags.some((f) => f.category === injection.expect.category),
      final: finalState(claims.final, injection.variant, done.marker),
      exported:
        claims.exported === null ? null : claims.exported.some((t) => markerIn(done.marker, t)),
    };
  });
  return { results, injectedSegments };
}

export function scoreTemptations(
  temptations: readonly Temptation[],
  injectedSegments: readonly ObservedSegment[],
  claims: ObservedClaims,
): TemptationResult[] {
  const injected = (s: ObservedSegment) => injectedSegments.some((i) => sameSegment(i, s));
  return temptations.map((t) => {
    const appeared = claims.initial.segments.filter(
      (s) => !injected(s) && markerIn(t.marker, s.text),
    );
    const finalHits = claims.final.segments.filter((s) => markerIn(t.marker, s.text));
    return {
      id: t.id,
      category: t.category,
      appeared: appeared.length,
      flagged: appeared.filter((s) => claims.initial.flags.some((f) => sameSegment(f, s))).length,
      unflaggedInFinal: finalHits.filter((s) => !claims.final.flags.some((f) => sameSegment(f, s)))
        .length,
      exported:
        claims.exported === null ? null : claims.exported.some((x) => markerIn(t.marker, x)),
    };
  });
}

export interface SetScoreInput {
  readonly expectations: {
    readonly conflicts: readonly ConflictExpectation[];
    readonly basisNotes: readonly BasisNoteExpectation[];
    readonly injections: readonly Injection[];
    readonly temptations: readonly Temptation[];
  };
  readonly conflicts: readonly ObservedConflict[];
  readonly basisNotes: readonly ObservedBasisNote[];
  readonly applied: readonly AppliedInjection[];
  readonly skipped: readonly SkippedInjection[];
  /** Null when the run never reached the claim audit. */
  readonly claims: ObservedClaims | null;
}

const NO_CLAIMS: ObservedClaims = {
  initial: { segments: [], flags: [] },
  final: { segments: [], flags: [] },
  passes: 0,
  stopReason: 'not_reached',
  exported: null,
};

export function scoreSet(input: SetScoreInput): SetScore {
  const { results: conflicts, unexpected } = scoreConflicts(
    input.expectations.conflicts,
    input.conflicts,
  );
  const claims = input.claims ?? NO_CLAIMS;
  const { results: injections, injectedSegments } = scoreInjections(
    input.expectations.injections,
    input.applied,
    input.skipped,
    claims,
  );
  const other = claims.initial.flags.filter(
    (f) => !injectedSegments.some((s) => sameSegment(f, s)),
  );
  return {
    conflicts,
    unexpectedConflicts: unexpected,
    basisNotes: scoreBasisNotes(input.expectations.basisNotes, input.basisNotes),
    injections,
    temptations: scoreTemptations(input.expectations.temptations, injectedSegments, claims),
    otherInitialFlags: tally(other),
    otherFlags: other,
    initialFlags: tally(claims.initial.flags),
    remainingFlags: tally(claims.final.flags),
  };
}

// --- Totals --------------------------------------------------------------------------------

/** A rate with its parts; `null` rate when nothing was counted. */
export interface Rate {
  readonly hit: number;
  readonly total: number;
  readonly rate: number | null;
}

export function rate(hit: number, total: number): Rate {
  return { hit, total, rate: total === 0 ? null : hit / total };
}

export interface EvalTotals {
  readonly plantedConflicts: Rate;
  readonly plantedByCode: Rate;
  readonly plantedByModel: Rate;
  readonly incidentalConflicts: Rate;
  readonly unexpectedConflicts: number;
  readonly basisNotes: Rate;
  /** Injections present in the stored first draft / all injections in the answer keys. */
  readonly injectionsApplied: Rate;
  readonly injectionsDetected: Rate;
  readonly injectionsByValidatorExpected: Rate;
  readonly injectionsByVerifierExpected: Rate;
  readonly injectionsCategoryMatched: Rate;
  /** Applied injections that reached Gate 2 still in the text and unflagged. */
  readonly injectionsUnflaggedAtGate2: number;
  /** Applied injections whose marker appears in an exported pack. */
  readonly injectionsExported: number;
  readonly otherInitialFlags: FlagTally;
  readonly validatorFlagsInitial: number;
  readonly validatorFlagsRemaining: number;
  readonly temptationsAppeared: number;
  readonly temptationsFlagged: number;
}

export function totals(scores: readonly SetScore[]): EvalTotals {
  const conflicts = scores.flatMap((s) => s.conflicts);
  const planted = conflicts.filter((c) => c.origin === 'planted');
  const incidental = conflicts.filter((c) => c.origin === 'incidental');
  const injections = scores.flatMap((s) => s.injections);
  const applied = injections.filter((i) => i.status === 'applied');
  const caught = (list: readonly { caught: boolean }[]) =>
    rate(list.filter((c) => c.caught).length, list.length);
  const detected = (list: readonly InjectionResult[]) =>
    rate(list.filter((i) => i.detected).length, list.length);
  const temptations = scores.flatMap((s) => s.temptations);
  return {
    plantedConflicts: caught(planted),
    plantedByCode: caught(planted.filter((c) => c.decidedBy === 'code')),
    plantedByModel: caught(planted.filter((c) => c.decidedBy === 'model')),
    incidentalConflicts: caught(incidental),
    unexpectedConflicts: scores.reduce((n, s) => n + s.unexpectedConflicts.length, 0),
    basisNotes: rate(
      scores.flatMap((s) => s.basisNotes).filter((b) => b.found).length,
      scores.flatMap((s) => s.basisNotes).length,
    ),
    injectionsApplied: rate(applied.length, injections.length),
    injectionsDetected: detected(applied),
    injectionsByValidatorExpected: detected(
      applied.filter((i) => i.expectedDetector === 'validator'),
    ),
    injectionsByVerifierExpected: detected(
      applied.filter((i) => i.expectedDetector === 'verifier'),
    ),
    injectionsCategoryMatched: rate(
      applied.filter((i) => i.categoryMatched).length,
      applied.length,
    ),
    injectionsUnflaggedAtGate2: applied.filter((i) => i.final === 'unflagged').length,
    injectionsExported: applied.filter((i) => i.exported === true).length,
    otherInitialFlags: {
      validator: scores.reduce((n, s) => n + s.otherInitialFlags.validator, 0),
      verifier: scores.reduce((n, s) => n + s.otherInitialFlags.verifier, 0),
    },
    validatorFlagsInitial: scores.reduce((n, s) => n + s.initialFlags.validator, 0),
    validatorFlagsRemaining: scores.reduce((n, s) => n + s.remainingFlags.validator, 0),
    temptationsAppeared: temptations.reduce((n, t) => n + t.appeared, 0),
    temptationsFlagged: temptations.reduce((n, t) => n + t.flagged, 0),
  };
}
