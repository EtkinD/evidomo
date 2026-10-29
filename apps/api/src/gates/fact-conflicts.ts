import {
  FACT_CONFLICTS_ARTIFACT_KIND,
  factConflictsContentSchema,
  factEditSchema,
  gateDecidedPayloadSchema,
  type ApiValidationIssue,
  type FactConflict,
  type FactConflictDecision,
  type FactConflictsContent,
  type FactConflictsGateResponse,
  type FactConflictsGateState,
  type FactEdit,
  type GateConflict,
  type GateFact,
  type ParsedFactConflictDecisionRequest,
} from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import { listArtifacts, type Artifact } from '../db/repositories/artifacts.ts';
import { listDecisions, upsertDecisions, type Decision } from '../db/repositories/decisions.ts';
import {
  getFactsByIds,
  insertFacts,
  setFactStatus,
  type Fact,
  type NewFact,
} from '../db/repositories/facts.ts';
import { appendRunEvent } from '../db/repositories/run-events.ts';
import { listCompletedRunSteps } from '../db/repositories/run-steps.ts';
import { getRunForOwner, lockRun, type Run } from '../db/repositories/runs.ts';
import type { DefinitionRegistry } from '../definitions/loader.ts';
import { isValidProfileValue, profileUnit } from '../pipeline/extraction/normalize.ts';
import type { RunEngine } from '../runs/engine.ts';

// Gate 1 (docs/architecture.md §5 "Gate 1 API"): list the run's fact conflicts and decide them.
//
// - Decisions are stored per conflicted fact (`decisions.target_kind = 'fact'`). Conflicts are
//   disjoint, so a conflict is decided exactly when each of its facts has a decision, and one
//   request writes all of them at once.
// - While the gate is open, decisions may be changed; facts keep their `conflicted` status.
// - The request that decides the last open conflict applies every decision to the facts and
//   resumes the run in the same transaction, under the run row lock, so concurrent requests
//   serialize and the run is resumed exactly once.

const GATE = 'fact_conflicts';
/** `facts.step_id` of a fact created from an edited value: the gate, not a pipeline step. */
export const GATE_DECISION_STEP_ID = `gate:${GATE}`;

export type FactConflictsGateErrorReason =
  | 'run_not_found'
  | 'conflict_not_found'
  | 'gate_not_open'
  | 'fact_not_in_conflict'
  | 'invalid_decision';

/** An expected refusal; the router maps `reason` to the HTTP status and `ApiErrorCode`. */
export class FactConflictsGateError extends Error {
  override name = 'FactConflictsGateError';
  readonly reason: FactConflictsGateErrorReason;
  /** For `invalid_decision`: which field and why, never the submitted value. */
  readonly issues: readonly ApiValidationIssue[];

  constructor(reason: FactConflictsGateErrorReason, issues: readonly ApiValidationIssue[] = []) {
    super(`Gate 1 request refused: ${reason}`);
    this.reason = reason;
    this.issues = issues;
  }
}

export interface FactConflictsGateDeps {
  readonly db: Executor;
  readonly engine: Pick<RunEngine, 'resumeAfterGate'>;
  readonly markets: Pick<DefinitionRegistry, 'getMarket'>;
}

export interface FactConflictsGate {
  /** The gate as the run's owner sees it; `run_not_found` for anyone else. */
  get(userId: string, runId: string): Promise<FactConflictsGateResponse>;
  /**
   * The gate of a run the caller has already resolved and may read (the public demo API's
   * allow-list); read-only, nothing is checked against a user.
   */
  view(run: Run): Promise<FactConflictsGateResponse>;
  /** Decides one conflict; resumes the run when it was the last open one. */
  decide(
    userId: string,
    runId: string,
    conflictId: string,
    request: ParsedFactConflictDecisionRequest,
  ): Promise<FactConflictsGateResponse & { resumed: boolean }>;
}

interface LoadedGate {
  readonly artifact: Artifact;
  readonly content: FactConflictsContent;
  readonly factSheetArtifactId: string;
  /** The completed step whose `gate_after` this gate is. */
  readonly stepId: string;
  readonly released: boolean;
  readonly facts: ReadonlyMap<string, Fact>;
  /** Gate 1 decisions on facts, by fact ID. */
  readonly decisions: ReadonlyMap<string, Decision>;
}

async function loadGate(db: Executor, run: Run): Promise<LoadedGate | undefined> {
  const stored = await listArtifacts(db, run.id, { kind: FACT_CONFLICTS_ARTIFACT_KIND });
  if (stored.length === 0) return undefined;
  const [artifact] = stored;
  if (artifact === undefined || stored.length > 1) {
    throw new Error(`Run ${run.id} has ${stored.length} fact_conflicts artifacts`);
  }
  const content = factConflictsContentSchema.parse(artifact.content);
  const step = (await listCompletedRunSteps(db, run.id)).find((s) => s.stepId === artifact.stepId);
  if (step === undefined) {
    throw new Error(
      `Run ${run.id} has conflicts from step ${artifact.stepId}, which never completed`,
    );
  }
  const factIds = content.conflicts.flatMap((conflict) => conflict.factIds);
  const facts = new Map((await getFactsByIds(db, run.id, factIds)).map((f) => [f.id, f]));
  const missing = factIds.filter((id) => !facts.has(id));
  if (missing.length > 0) {
    throw new Error(`Run ${run.id} lists ${missing.length} conflicted fact(s) it does not have`);
  }
  const decisions = new Map(
    (await listDecisions(db, run.id, { gate: GATE }))
      .filter((decision) => decision.targetKind === 'fact')
      .map((decision) => [decision.targetId, decision]),
  );
  return {
    artifact,
    content,
    factSheetArtifactId: content.factSheetArtifactId,
    stepId: step.stepId,
    released: step.gateReleasedAt !== null,
    facts,
    decisions,
  };
}

function isOpenAt(run: Run): boolean {
  return run.status === 'awaiting_gate' && run.gate === GATE;
}

function gateState(run: Run, loaded: LoadedGate | undefined): FactConflictsGateState {
  if (loaded === undefined) return 'not_reached';
  if (loaded.released) return 'released';
  return isOpenAt(run) ? 'open' : 'suspended';
}

function sameEdit(a: FactEdit, b: FactEdit): boolean {
  return a.key === b.key && a.value === b.value && a.unit === b.unit && a.basis === b.basis;
}

function editOf(decision: Decision): FactEdit | undefined {
  const parsed = factEditSchema.safeParse(decision.editedValue);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A conflict's decision from its per-fact rows. Only the three shapes this module writes count:
 * one side `accept` and every other fact `reject`; every fact `edit` with the same value; every
 * fact `reject`. Anything else (a missing row, a row written by other code) leaves the conflict
 * open, so the operator decides it again and the request overwrites every row.
 */
export function conflictDecision(
  conflict: FactConflict,
  decisions: ReadonlyMap<string, Decision>,
): FactConflictDecision | null {
  const rows: Decision[] = [];
  for (const factId of conflict.factIds) {
    const row = decisions.get(factId);
    if (row === undefined) return null;
    rows.push(row);
  }
  const decidedAt = new Date(Math.max(...rows.map((row) => row.decidedAt.getTime()))).toISOString();

  if (rows.every((row) => row.choice === 'reject')) return { choice: 'reject', decidedAt };

  if (rows.every((row) => row.choice === 'edit')) {
    const edits = rows.map(editOf);
    const [first] = edits;
    if (first === undefined || edits.some((edit) => edit === undefined || !sameEdit(edit, first))) {
      return null;
    }
    return { choice: 'edit', ...first, decidedAt };
  }

  const accepted = rows.filter((row) => row.choice === 'accept').map((row) => row.targetId);
  const others = rows.filter((row) => row.choice !== 'accept');
  const side = conflict.sides.find((s) => s.factIds.includes(accepted[0] ?? ''));
  if (
    side !== undefined &&
    accepted.length === side.factIds.length &&
    side.factIds.every((id) => accepted.includes(id)) &&
    others.every((row) => row.choice === 'reject')
  ) {
    return { choice: 'accept', factIds: [...side.factIds], decidedAt };
  }
  return null;
}

/** A fact as the gate APIs return it (Gate 2 lists the facts its copy cites the same way). */
export function gateFact(fact: Fact): GateFact {
  return {
    id: fact.id,
    key: fact.key,
    value: fact.value,
    unit: fact.unit,
    basis: fact.basis,
    status: fact.status,
    assertion: fact.assertion,
    source: fact.source,
  };
}

function factOf(loaded: LoadedGate, factId: string): Fact {
  const fact = loaded.facts.get(factId);
  // loadGate checked that every conflicted fact exists.
  if (fact === undefined) throw new Error(`Conflicted fact ${factId} is missing`);
  return fact;
}

function buildResponse(run: Run, loaded: LoadedGate | undefined): FactConflictsGateResponse {
  if (loaded === undefined) {
    return {
      runId: run.id,
      runStatus: run.status,
      state: 'not_reached',
      factSheetArtifactId: null,
      conflictsArtifactId: null,
      conflictCount: 0,
      openCount: 0,
      conflicts: [],
    };
  }
  const conflicts = loaded.content.conflicts.map((conflict): GateConflict => ({
    id: conflict.id,
    key: conflict.key,
    kind: conflict.kind,
    detectedBy: conflict.detectedBy,
    explanation: conflict.explanation,
    sides: conflict.sides.map((side) => ({
      ...side,
      facts: side.factIds.map((id) => gateFact(factOf(loaded, id))),
    })),
    decision: conflictDecision(conflict, loaded.decisions),
  }));
  return {
    runId: run.id,
    runStatus: run.status,
    state: gateState(run, loaded),
    factSheetArtifactId: loaded.factSheetArtifactId,
    conflictsArtifactId: loaded.artifact.id,
    conflictCount: conflicts.length,
    // Once released, nothing is open, whatever the rows say (a gate with no conflicts, or a run
    // whose decisions were applied).
    openCount: loaded.released ? 0 : conflicts.filter((c) => c.decision === null).length,
    conflicts,
  };
}

function invalid(path: string, message: string): FactConflictsGateError {
  return new FactConflictsGateError('invalid_decision', [{ path: [path], message }]);
}

/** Resolves an `edit` request to the stored value, with the market profile's unit and basis. */
function resolveEdit(
  run: Run,
  conflict: FactConflict,
  request: Extract<ParsedFactConflictDecisionRequest, { choice: 'edit' }>,
  markets: Pick<DefinitionRegistry, 'getMarket'>,
): FactEdit {
  const key = request.key ?? conflict.key;
  const keys = new Set([conflict.key, ...conflict.sides.map((side) => side.key)]);
  if (!keys.has(key)) throw invalid('key', 'The key must be one of the conflict’s keys');

  const market = markets.getMarket(run.marketProfileId, run.marketProfileVersion);
  const marketFact = market.facts.find((fact) => fact.key === key);
  if (marketFact === undefined) {
    return factEditSchema.parse({
      key,
      value: request.value,
      unit: request.unit ?? null,
      basis: request.basis ?? null,
    });
  }
  if (!isValidProfileValue(marketFact, request.value)) {
    throw invalid('value', `The value is not valid for ${key} in the market profile`);
  }
  const unit = profileUnit(market, marketFact);
  const basis = marketFact.type === 'area' ? marketFact.basis : null;
  if (request.unit !== undefined && request.unit !== unit) {
    throw invalid('unit', `The market profile fixes the unit of ${key}`);
  }
  if (request.basis !== undefined && request.basis !== basis) {
    throw invalid('basis', `The market profile fixes the basis of ${key}`);
  }
  return factEditSchema.parse({ key, value: request.value, unit, basis });
}

type DesiredDecision = { factId: string } & (
  { choice: 'accept' | 'reject'; edit?: undefined } | { choice: 'edit'; edit: FactEdit }
);

function desiredDecisions(
  run: Run,
  loaded: LoadedGate,
  conflict: FactConflict,
  request: ParsedFactConflictDecisionRequest,
  markets: Pick<DefinitionRegistry, 'getMarket'>,
): DesiredDecision[] {
  switch (request.choice) {
    case 'accept': {
      const side = conflict.sides.find((s) => s.factIds.includes(request.factId));
      if (side === undefined) throw new FactConflictsGateError('fact_not_in_conflict');
      if (side.factIds.some((id) => factOf(loaded, id).assertion === 'opinion')) {
        // Reconciliation never puts opinions into a conflict; the database refuses it anyway.
        throw invalid('factId', 'An opinion cannot become a verified fact');
      }
      return conflict.factIds.map((factId) => ({
        factId,
        choice: side.factIds.includes(factId) ? 'accept' : 'reject',
      }));
    }
    case 'edit': {
      const edit = resolveEdit(run, conflict, request, markets);
      return conflict.factIds.map((factId) => ({ factId, choice: 'edit', edit }));
    }
    case 'reject':
      return conflict.factIds.map((factId) => ({ factId, choice: 'reject' }));
    default: {
      const unreachable: never = request;
      throw new Error(`Unhandled decision ${JSON.stringify(unreachable)}`);
    }
  }
}

function unchanged(desired: readonly DesiredDecision[], loaded: LoadedGate): boolean {
  return desired.every((want) => {
    const have = loaded.decisions.get(want.factId);
    if (have?.choice !== want.choice) return false;
    if (want.choice !== 'edit') return true;
    const stored = editOf(have);
    return stored !== undefined && sameEdit(stored, want.edit);
  });
}

/**
 * Applies every decision to the facts, records `gate_decided`, and resumes the run, all in the
 * caller's transaction (which holds the run lock):
 * accept → the side's facts `verified`, the others `rejected`; edit → every conflicted fact
 * `rejected` plus one new `verified` fact with `source_kind = gate_decision`; reject → every
 * conflicted fact `rejected`.
 */
async function releaseGate(
  tx: Executor,
  run: Run,
  loaded: LoadedGate,
  engine: Pick<RunEngine, 'resumeAfterGate'>,
): Promise<void> {
  const verified: string[] = [];
  const rejected: string[] = [];
  const created: NewFact[] = [];
  const counts = { acceptedCount: 0, editedCount: 0, rejectedCount: 0 };
  for (const conflict of loaded.content.conflicts) {
    const decision = conflictDecision(conflict, loaded.decisions);
    if (decision === null) throw new Error(`Conflict ${conflict.id} is not decided`);
    switch (decision.choice) {
      case 'accept':
        counts.acceptedCount += 1;
        for (const id of conflict.factIds) {
          (decision.factIds.includes(id) ? verified : rejected).push(id);
        }
        break;
      case 'edit':
        counts.editedCount += 1;
        rejected.push(...conflict.factIds);
        created.push({
          stepId: GATE_DECISION_STEP_ID,
          key: decision.key,
          value: decision.value,
          unit: decision.unit,
          basis: decision.basis,
          source: {
            kind: 'gate_decision',
            gate: GATE,
            conflictsArtifactId: loaded.artifact.id,
            conflictId: conflict.id,
          },
          status: 'verified',
          assertion: 'stated',
        });
        break;
      case 'reject':
        counts.rejectedCount += 1;
        rejected.push(...conflict.factIds);
        break;
      default: {
        const unreachable: never = decision;
        throw new Error(`Unhandled decision ${JSON.stringify(unreachable)}`);
      }
    }
  }

  if ((await setFactStatus(tx, run.id, verified, 'verified')) !== verified.length) {
    throw new Error(`Run ${run.id}: not every accepted fact could be verified`);
  }
  if ((await setFactStatus(tx, run.id, rejected, 'rejected')) !== rejected.length) {
    throw new Error(`Run ${run.id}: not every losing fact could be rejected`);
  }
  await insertFacts(tx, run.id, created);
  await appendRunEvent(tx, run.id, {
    type: 'gate_decided',
    payload: gateDecidedPayloadSchema.parse({
      gate: GATE,
      stepId: loaded.stepId,
      ...counts,
      verifiedFactCount: verified.length,
      rejectedFactCount: rejected.length,
      createdFactCount: created.length,
    }),
  });
  await engine.resumeAfterGate(run.id, { gate: GATE, tx });
}

export function createFactConflictsGate(deps: FactConflictsGateDeps): FactConflictsGate {
  const { db, engine, markets } = deps;

  return {
    async get(userId, runId) {
      const run = await getRunForOwner(db, runId, userId);
      if (run === undefined) throw new FactConflictsGateError('run_not_found');
      return buildResponse(run, await loadGate(db, run));
    },

    async view(run) {
      return buildResponse(run, await loadGate(db, run));
    },

    async decide(userId, runId, conflictId, request) {
      return db.transaction(async (tx) => {
        if ((await getRunForOwner(tx, runId, userId)) === undefined) {
          throw new FactConflictsGateError('run_not_found');
        }
        // The lock serializes every decision on this run with each other and with the run
        // engine, so exactly one request sees the last conflict decided and resumes the run.
        const run = await lockRun(tx, runId);
        if (run === undefined) throw new FactConflictsGateError('run_not_found');
        if (!isOpenAt(run)) throw new FactConflictsGateError('gate_not_open');
        const loaded = await loadGate(tx, run);
        if (loaded === undefined) {
          throw new Error(`Run ${run.id} awaits ${GATE} without a fact_conflicts artifact`);
        }
        if (loaded.released) throw new FactConflictsGateError('gate_not_open');
        const conflict = loaded.content.conflicts.find((c) => c.id === conflictId);
        if (conflict === undefined) throw new FactConflictsGateError('conflict_not_found');

        const desired = desiredDecisions(run, loaded, conflict, request, markets);
        let current = loaded;
        if (!unchanged(desired, loaded)) {
          await upsertDecisions(
            tx,
            desired.map((want) => {
              const base = {
                runId: run.id,
                gate: GATE,
                targetKind: 'fact',
                targetId: want.factId,
                decidedBy: userId,
              } as const;
              return want.choice === 'edit'
                ? { ...base, choice: 'edit', editedValue: want.edit }
                : { ...base, choice: want.choice };
            }),
          );
          current = (await loadGate(tx, run)) ?? loaded;
        }

        const open = current.content.conflicts.filter(
          (c) => conflictDecision(c, current.decisions) === null,
        );
        if (open.length > 0) return { ...buildResponse(run, current), resumed: false };

        await releaseGate(tx, run, current, engine);
        const after = await lockRun(tx, run.id);
        if (after === undefined) throw new Error(`Run ${run.id} vanished while resuming`);
        return { ...buildResponse(after, await loadGate(tx, after)), resumed: true };
      });
    },
  };
}
