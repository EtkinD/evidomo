import { and, asc, eq, inArray, max, sql } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { runSteps } from '../schema.ts';
import { returnedRow } from './rows.ts';

// The run engine's idempotency record (docs/architecture.md §9). Callers hold the run row lock
// (`lockRun`) before touching a run's steps, so every engine transaction locks run → run_steps
// in the same order and concurrent workers serialize per run instead of deadlocking.

export type RunStep = typeof runSteps.$inferSelect;

export interface RunStepKey {
  runId: string;
  stepId: string;
  attempt: number;
}

/** The pg-boss delivery executing an attempt: its job ID and `retryCount`. */
export interface JobClaim {
  jobId: string;
  retryCount: number;
}

function keyMatches(key: RunStepKey) {
  return and(
    eq(runSteps.runId, key.runId),
    eq(runSteps.stepId, key.stepId),
    eq(runSteps.attempt, key.attempt),
  );
}

/** The attempt number the next scheduling of a step gets: 1, or one above the highest so far. */
export async function nextRunStepAttempt(
  db: Executor,
  runId: string,
  stepId: string,
): Promise<number> {
  const [row] = await db
    .select({ highest: max(runSteps.attempt) })
    .from(runSteps)
    .where(and(eq(runSteps.runId, runId), eq(runSteps.stepId, stepId)));
  return (row?.highest ?? 0) + 1;
}

/**
 * Records a scheduled attempt together with the ID of the job that will execute it. Fails on
 * `run_steps_one_open_attempt_key` when the step already has a queued or running attempt.
 */
export async function createRunStep(
  db: Executor,
  input: RunStepKey & { jobId: string },
): Promise<RunStep> {
  return returnedRow(await db.insert(runSteps).values(input).returning(), 'run step');
}

export async function getRunStepForUpdate(
  db: Executor,
  key: RunStepKey,
): Promise<RunStep | undefined> {
  const [row] = await db.select().from(runSteps).where(keyMatches(key)).for('update');
  return row;
}

export async function listRunSteps(db: Executor, runId: string): Promise<RunStep[]> {
  return db
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, runId))
    .orderBy(asc(runSteps.createdAt), asc(runSteps.stepId), asc(runSteps.attempt));
}

/** Completed attempts of a run; at most one per step (`run_steps_one_completion_key`). */
export async function listCompletedRunSteps(db: Executor, runId: string): Promise<RunStep[]> {
  return db
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, runId), eq(runSteps.status, 'completed')));
}

/** Marks the attempt running under `claim` and counts one more handler execution. */
export async function claimRunStep(
  db: Executor,
  key: RunStepKey,
  claim: JobClaim,
): Promise<RunStep> {
  const rows = await db
    .update(runSteps)
    .set({
      status: 'running',
      jobRetryCount: claim.retryCount,
      executions: sql`${runSteps.executions} + 1`,
      startedAt: sql`coalesce(${runSteps.startedAt}, now())`,
      updatedAt: sql`now()`,
    })
    .where(and(keyMatches(key), eq(runSteps.jobId, claim.jobId)))
    .returning();
  return returnedRow(rows, 'run step');
}

export async function completeRunStep(
  db: Executor,
  key: RunStepKey,
  artifactIds: readonly string[],
): Promise<RunStep> {
  const rows = await db
    .update(runSteps)
    .set({
      status: 'completed',
      error: null,
      outputArtifactIds: [...artifactIds],
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(keyMatches(key))
    .returning();
  return returnedRow(rows, 'run step');
}

/** Puts the attempt back to `queued` for its retry, keeping the failure reason. */
export async function requeueRunStep(
  db: Executor,
  key: RunStepKey,
  reason: string,
): Promise<RunStep> {
  const rows = await db
    .update(runSteps)
    .set({ status: 'queued', error: reason, updatedAt: sql`now()` })
    .where(keyMatches(key))
    .returning();
  return returnedRow(rows, 'run step');
}

/** Closes every queued or running attempt of a run as failed (the run is failing). */
export async function failOpenRunSteps(
  db: Executor,
  runId: string,
  reason: string,
): Promise<RunStep[]> {
  return db
    .update(runSteps)
    .set({ status: 'failed', error: reason, finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(runSteps.runId, runId), inArray(runSteps.status, ['queued', 'running'])))
    .returning();
}

/** Records that the run has been released past the gate after this completed step. */
export async function releaseRunStepGate(
  db: Executor,
  runId: string,
  stepId: string,
): Promise<RunStep> {
  const rows = await db
    .update(runSteps)
    .set({ gateReleasedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(eq(runSteps.runId, runId), eq(runSteps.stepId, stepId), eq(runSteps.status, 'completed')),
    )
    .returning();
  return returnedRow(rows, 'run step');
}
