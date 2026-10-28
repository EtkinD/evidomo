import {
  jsonValueSchema,
  type DecisionChoice,
  type DecisionTargetKind,
  type Gate,
  type JsonValue,
} from '@evidomo/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import {
  DecisionAlreadyRecordedError,
  GateNotOpenError,
  NotFoundError,
  isUniqueViolation,
} from '../errors.ts';
import { artifacts, claims, decisions, facts, runs } from '../schema.ts';
import { returnedRow } from './rows.ts';

type DecisionRow = typeof decisions.$inferSelect;

export type Decision = Omit<DecisionRow, 'editedValue'> & { editedValue: JsonValue | null };

interface DecisionBase {
  runId: string;
  gate: Gate;
  targetKind: DecisionTargetKind;
  targetId: string;
  decidedBy: string;
}

/** `edit` carries the edited value; every other choice must not. */
export type NewDecision = DecisionBase &
  (
    | { choice: 'edit'; editedValue: JsonValue }
    | { choice: Exclude<DecisionChoice, 'edit'>; editedValue?: undefined }
  );

function toDecision(row: DecisionRow): Decision {
  return {
    ...row,
    editedValue: row.editedValue === null ? null : jsonValueSchema.parse(row.editedValue),
  };
}

async function targetBelongsToRun(
  db: Executor,
  runId: string,
  kind: DecisionTargetKind,
  targetId: string,
): Promise<boolean> {
  switch (kind) {
    case 'fact': {
      const rows = await db
        .select({ id: facts.id })
        .from(facts)
        .where(and(eq(facts.id, targetId), eq(facts.runId, runId)));
      return rows.length > 0;
    }
    case 'artifact': {
      const rows = await db
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(and(eq(artifacts.id, targetId), eq(artifacts.runId, runId)));
      return rows.length > 0;
    }
    case 'claim': {
      const rows = await db
        .select({ id: claims.id })
        .from(claims)
        .innerJoin(artifacts, eq(artifacts.id, claims.artifactId))
        .where(and(eq(claims.id, targetId), eq(artifacts.runId, runId)));
      return rows.length > 0;
    }
    default: {
      const unreachable: never = kind;
      throw new Error(`Unhandled decision target kind ${String(unreachable)}`);
    }
  }
}

/**
 * Records a human gate decision. Gates are states: the run must currently be awaiting this
 * gate (checked under a row lock that blocks concurrent transitions), and the target must
 * belong to the run. One decision per target per gate.
 */
export async function recordDecision(db: Executor, input: NewDecision): Promise<Decision> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: runs.status, gate: runs.gate })
      .from(runs)
      .where(eq(runs.id, input.runId))
      .for('share');
    if (!run) throw new NotFoundError('run', input.runId);
    if (run.status !== 'awaiting_gate' || run.gate !== input.gate) {
      throw new GateNotOpenError(input.runId, input.gate);
    }
    if (!(await targetBelongsToRun(tx, input.runId, input.targetKind, input.targetId))) {
      throw new NotFoundError(input.targetKind, input.targetId);
    }

    try {
      const rows = await tx
        .insert(decisions)
        .values({
          runId: input.runId,
          gate: input.gate,
          targetKind: input.targetKind,
          targetId: input.targetId,
          choice: input.choice,
          editedValue: input.choice === 'edit' ? jsonValueSchema.parse(input.editedValue) : null,
          decidedBy: input.decidedBy,
        })
        .returning();
      return toDecision(returnedRow(rows, 'decision'));
    } catch (error) {
      if (isUniqueViolation(error, 'decisions_one_per_target_key')) {
        throw new DecisionAlreadyRecordedError(input.runId, input.targetId);
      }
      throw error;
    }
  });
}

export async function listDecisions(
  db: Executor,
  runId: string,
  filter: { gate?: Gate } = {},
): Promise<Decision[]> {
  const rows = await db
    .select()
    .from(decisions)
    .where(
      and(
        eq(decisions.runId, runId),
        filter.gate === undefined ? undefined : eq(decisions.gate, filter.gate),
      ),
    )
    .orderBy(asc(decisions.decidedAt), asc(decisions.id));
  return rows.map(toDecision);
}

/**
 * Writes one decision per target, replacing any earlier decision for the same target (one row
 * per run, gate, and target by `decisions_one_per_target_key`); a replaced row gets the new
 * choice, value, decider, and time.
 *
 * Unlike `recordDecision` it does not check the gate: the caller holds the run row lock
 * (`lockRun`) and has checked that the run awaits `gate` and that the targets belong to the run,
 * in the same transaction. That lets a gate decide several targets, and resume the run, in one
 * transaction.
 */
export async function upsertDecisions(
  tx: Executor,
  inputs: readonly NewDecision[],
): Promise<Decision[]> {
  if (inputs.length === 0) return [];
  const rows = await tx
    .insert(decisions)
    .values(
      inputs.map((input) => ({
        runId: input.runId,
        gate: input.gate,
        targetKind: input.targetKind,
        targetId: input.targetId,
        choice: input.choice,
        editedValue: input.choice === 'edit' ? jsonValueSchema.parse(input.editedValue) : null,
        decidedBy: input.decidedBy,
      })),
    )
    .onConflictDoUpdate({
      target: [decisions.runId, decisions.gate, decisions.targetKind, decisions.targetId],
      set: {
        choice: sql`excluded.choice`,
        editedValue: sql`excluded.edited_value`,
        decidedBy: sql`excluded.decided_by`,
        decidedAt: sql`now()`,
      },
    })
    .returning();
  return rows.map(toDecision);
}
