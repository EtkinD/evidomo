import type { Gate, RunStatus } from '@evidomo/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Executor } from '../client.ts';
import { InvalidRunTransitionError, NotFoundError } from '../errors.ts';
import { runs } from '../schema.ts';
import { appendRunEvent } from './run-events.ts';
import { returnedRow } from './rows.ts';

export type Run = typeof runs.$inferSelect;

export interface NewRun {
  projectId: string;
  serviceId: string;
  serviceVersion: number;
  marketProfileId: string;
  marketProfileVersion: number;
  outputLanguage: string;
}

/**
 * Allowed run status transitions. `awaiting_gate → running` resumes after a gate decision;
 * `failed → queued` resumes a failed run (completed steps are skipped by the run engine).
 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'failed'],
  running: ['awaiting_gate', 'completed', 'failed'],
  awaiting_gate: ['running', 'failed'],
  completed: [],
  failed: ['queued'],
};

export type RunTransition =
  | { to: 'queued' }
  | { to: 'running'; stepId?: string }
  | { to: 'awaiting_gate'; gate: Gate }
  | { to: 'completed' }
  /** `reason` is shown to the operator and logged: no secrets, tokens, or personal data. */
  | { to: 'failed'; reason: string };

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export async function createRun(db: Executor, input: NewRun): Promise<Run> {
  return returnedRow(await db.insert(runs).values(input).returning(), 'run');
}

export async function getRun(db: Executor, runId: string): Promise<Run | undefined> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));
  return row;
}

export async function listRunsForProject(db: Executor, projectId: string): Promise<Run[]> {
  return db
    .select()
    .from(runs)
    .where(eq(runs.projectId, projectId))
    .orderBy(asc(runs.createdAt), asc(runs.id));
}

function transitionChanges(transition: RunTransition): PgUpdateSetSource<typeof runs> {
  switch (transition.to) {
    case 'queued':
      return { gate: null, failureReason: null, finishedAt: null };
    case 'running':
      return {
        gate: null,
        failureReason: null,
        startedAt: sql`coalesce(${runs.startedAt}, now())`,
        ...(transition.stepId === undefined ? {} : { currentStepId: transition.stepId }),
      };
    case 'awaiting_gate':
      return { gate: transition.gate, failureReason: null };
    case 'completed':
      return { gate: null, failureReason: null, finishedAt: sql`now()` };
    case 'failed':
      return { gate: null, failureReason: transition.reason, finishedAt: sql`now()` };
    default: {
      const unreachable: never = transition;
      throw new Error(`Unhandled run transition ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Moves a run to a new status and appends a `run_status_changed` event in the same
 * transaction. The run row is locked first, so concurrent transitions are serialized and an
 * illegal one fails with InvalidRunTransitionError instead of overwriting state.
 */
export async function transitionRun(
  db: Executor,
  runId: string,
  transition: RunTransition,
): Promise<Run> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .for('update');
    if (!current) throw new NotFoundError('run', runId);
    if (!canTransition(current.status, transition.to)) {
      throw new InvalidRunTransitionError(runId, current.status, transition.to);
    }

    // Appended before the UPDATE so the returned row already carries the new last_event_seq.
    await appendRunEvent(tx, runId, {
      type: 'run_status_changed',
      payload: {
        from: current.status,
        to: transition.to,
        ...(transition.to === 'awaiting_gate' ? { gate: transition.gate } : {}),
        ...(transition.to === 'failed' ? { reason: transition.reason } : {}),
      },
    });

    const rows = await tx
      .update(runs)
      .set({ status: transition.to, ...transitionChanges(transition), updatedAt: sql`now()` })
      .where(eq(runs.id, runId))
      .returning();
    return returnedRow(rows, 'run');
  });
}
