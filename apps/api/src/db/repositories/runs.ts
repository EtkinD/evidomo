import type { Gate, RunStatus } from '@evidomo/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Executor } from '../client.ts';
import { InvalidRunTransitionError, NotFoundError } from '../errors.ts';
import { materials, projects, runs } from '../schema.ts';
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

/**
 * `created_at` is `clock_timestamp()`, like materials': steps use only materials created before
 * the run, and a run started right after an upload (both under the project lock) must sort after
 * it even though its transaction began first.
 */
export async function createRun(db: Executor, input: NewRun): Promise<Run> {
  return returnedRow(
    await db
      .insert(runs)
      .values({ ...input, createdAt: sql`clock_timestamp()` })
      .returning(),
    'run',
  );
}

export async function getRun(db: Executor, runId: string): Promise<Run | undefined> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));
  return row;
}

/**
 * Ownership-checked lookup for HTTP routes: undefined both when the run does not exist and when
 * its project belongs to someone else, so a response never confirms another user's run ID.
 */
export async function getRunForOwner(
  db: Executor,
  runId: string,
  ownerId: string,
): Promise<Run | undefined> {
  const [row] = await db
    .select({ run: runs })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(and(eq(runs.id, runId), eq(projects.ownerId, ownerId)));
  return row?.run;
}

/**
 * Reads the run with a row lock held until the transaction ends. Run-engine transactions take
 * it first, so they serialize per run and always lock run → run_steps in the same order.
 */
export async function lockRun(db: Executor, runId: string): Promise<Run | undefined> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).for('update');
  return row;
}

/** Points the run at the step it is executing (no status change, no event). */
export async function setRunCurrentStep(
  db: Executor,
  runId: string,
  stepId: string,
): Promise<void> {
  const rows = await db
    .update(runs)
    .set({ currentStepId: stepId, updatedAt: sql`now()` })
    .where(eq(runs.id, runId))
    .returning({ id: runs.id });
  if (rows.length === 0) throw new NotFoundError('run', runId);
}

export async function listRunsForProject(db: Executor, projectId: string): Promise<Run[]> {
  return db
    .select()
    .from(runs)
    .where(eq(runs.projectId, projectId))
    .orderBy(asc(runs.createdAt), asc(runs.id));
}

/**
 * Whether the run's project changed after the run was created: `projects.updated_at` (title,
 * office profile, fact form, and, through `touchProject`, material uploads and deletions) or a
 * material created later. Compared in SQL, at the database's microsecond precision. The run's own
 * start writes the project (`draft → active`) with its transaction's `now()`, which precedes the
 * run's `created_at` (`clock_timestamp()`), so it does not count. False for an unknown run.
 */
export async function projectChangedSinceRun(db: Executor, runId: string): Promise<boolean> {
  const [row] = await db
    .select({
      changed: sql<boolean>`(${projects.updatedAt} > ${runs.createdAt} or exists (
        select 1 from ${materials}
        where ${materials.projectId} = ${projects.id} and ${materials.createdAt} > ${runs.createdAt}
      ))`,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(eq(runs.id, runId));
  return row?.changed === true;
}

/**
 * Row-locks every run of a project until the transaction ends, in ID order (so two lockers
 * cannot deadlock), and returns them as they are once the locks are held: a transition that
 * committed while this waited is seen. Project deletion takes it after the project lock, the same
 * project → run order as run starts.
 */
export async function lockRunsForProject(db: Executor, projectId: string): Promise<Run[]> {
  return db
    .select()
    .from(runs)
    .where(eq(runs.projectId, projectId))
    .orderBy(asc(runs.id))
    .for('update');
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
