import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSteps } from '../schema.ts';
import { seedRunWithParents, startTestDatabase, type TestDatabase } from '../testing.ts';
import { deleteProject } from './projects.ts';
import {
  claimRunStep,
  completeRunStep,
  createRunStep,
  failOpenRunSteps,
  listCompletedRunSteps,
  listRunSteps,
  nextRunStepAttempt,
  releaseRunStepGate,
  requeueRunStep,
} from './run-steps.ts';

/** Matches a Drizzle query error caused by the named PostgreSQL constraint. */
const violates = (constraint: string) => ({ cause: { constraint } });

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb.stop();
});

describe('run_steps repository', () => {
  it('tracks an attempt from queued through a retry to completed', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const key = { runId: run.id, stepId: 'intake', attempt: 1 };
    const jobId = randomUUID();

    expect(await nextRunStepAttempt(testDb.db, run.id, 'intake')).toBe(1);
    const queued = await createRunStep(testDb.db, { ...key, jobId });
    expect(queued).toMatchObject({ status: 'queued', executions: 0, jobRetryCount: null });

    const first = await claimRunStep(testDb.db, key, { jobId, retryCount: 0 });
    expect(first).toMatchObject({ status: 'running', executions: 1, jobRetryCount: 0 });
    expect(first.startedAt).toBeInstanceOf(Date);

    await requeueRunStep(testDb.db, key, 'Unexpected Error');
    const second = await claimRunStep(testDb.db, key, { jobId, retryCount: 1 });
    expect(second).toMatchObject({ executions: 2, jobRetryCount: 1, error: 'Unexpected Error' });
    expect(second.startedAt).toEqual(first.startedAt);

    const artifactId = randomUUID();
    const done = await completeRunStep(testDb.db, key, [artifactId]);
    expect(done).toMatchObject({
      status: 'completed',
      error: null,
      outputArtifactIds: [artifactId],
    });
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect((await listCompletedRunSteps(testDb.db, run.id)).map((s) => s.stepId)).toEqual([
      'intake',
    ]);
  });

  it('refuses a claim by a job other than the one recorded on the attempt', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const key = { runId: run.id, stepId: 'intake', attempt: 1 };
    await createRunStep(testDb.db, { ...key, jobId: randomUUID() });

    await expect(
      claimRunStep(testDb.db, key, { jobId: randomUUID(), retryCount: 0 }),
    ).rejects.toThrow('Expected a returned run step row');
  });

  it('allows one open attempt and one completion per step', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const first = { runId: run.id, stepId: 'extract', attempt: 1 };
    await createRunStep(testDb.db, { ...first, jobId: randomUUID() });

    await expect(
      createRunStep(testDb.db, { ...first, attempt: 2, jobId: randomUUID() }),
    ).rejects.toMatchObject(violates('run_steps_one_open_attempt_key'));

    await failOpenRunSteps(testDb.db, run.id, 'Step "extract" timed out after 600 s');
    expect(await nextRunStepAttempt(testDb.db, run.id, 'extract')).toBe(2);
    const second = { ...first, attempt: 2 };
    await createRunStep(testDb.db, { ...second, jobId: randomUUID() });
    await completeRunStep(testDb.db, second, []);

    // A completed step can never be completed by another attempt.
    const third = { ...first, attempt: 3 };
    await createRunStep(testDb.db, { ...third, jobId: randomUUID() });
    await expect(completeRunStep(testDb.db, third, [])).rejects.toMatchObject(
      violates('run_steps_one_completion_key'),
    );

    expect(
      (await listRunSteps(testDb.db, run.id)).map((s) => [s.attempt, s.status, s.error]),
    ).toEqual([
      [1, 'failed', 'Step "extract" timed out after 600 s'],
      [2, 'completed', null],
      [3, 'queued', null],
    ]);
  });

  it('enforces the state constraints in the database', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const values = { runId: run.id, stepId: 'export', jobId: randomUUID() };

    await expect(
      testDb.db.insert(runSteps).values({ ...values, attempt: 0 }),
    ).rejects.toMatchObject(violates('run_steps_attempt_positive'));
    await expect(
      testDb.db
        .insert(runSteps)
        .values({ ...values, attempt: 1, status: 'failed', finishedAt: new Date() }),
    ).rejects.toMatchObject(violates('run_steps_failed_has_error'));
    await expect(
      testDb.db.insert(runSteps).values({ ...values, attempt: 1, status: 'completed' }),
    ).rejects.toMatchObject(violates('run_steps_finished_iff_closed'));
    await expect(
      testDb.db.insert(runSteps).values({ ...values, attempt: 1, gateReleasedAt: new Date() }),
    ).rejects.toMatchObject(violates('run_steps_gate_release_after_completion'));
  });

  it('releases a gate only on a completed step', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    const key = { runId: run.id, stepId: 'reconcile', attempt: 1 };
    await createRunStep(testDb.db, { ...key, jobId: randomUUID() });

    await expect(releaseRunStepGate(testDb.db, run.id, 'reconcile')).rejects.toThrow(
      'Expected a returned run step row',
    );
    await completeRunStep(testDb.db, key, []);
    const released = await releaseRunStepGate(testDb.db, run.id, 'reconcile');
    expect(released.gateReleasedAt).toBeInstanceOf(Date);
  });

  it('is hard-deleted with its project', async () => {
    const { project, run } = await seedRunWithParents(testDb.db);
    await createRunStep(testDb.db, {
      runId: run.id,
      stepId: 'intake',
      attempt: 1,
      jobId: randomUUID(),
    });

    await deleteProject(testDb.db, project.id);
    const remaining = await testDb.db.execute<{ count: number }>(
      sql`select count(*)::int as count from run_steps where run_id = ${run.id}`,
    );
    expect(remaining.rows[0]?.count).toBe(0);
  });
});
