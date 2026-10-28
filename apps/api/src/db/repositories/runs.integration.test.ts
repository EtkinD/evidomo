import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidRunTransitionError, NotFoundError } from '../errors.ts';
import { runEvents, runs } from '../schema.ts';
import {
  seedProject,
  seedRunWithParents,
  seedUser,
  startTestDatabase,
  type TestDatabase,
} from '../testing.ts';
import { appendRunEvent, listRunEvents } from './run-events.ts';
import { createRun, getRun, listRunsForProject, transitionRun } from './runs.ts';

const missingId = '00000000-0000-4000-8000-000000000000';

/** Matches a Drizzle query error caused by the named PostgreSQL constraint. */
const violates = (constraint: string) => ({ cause: { constraint } });

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await startTestDatabase();
});

afterAll(async () => {
  await testDb.stop();
});

describe('runs repository', () => {
  it('creates a queued run that records the definition and market profile versions', async () => {
    const user = await seedUser(testDb.db);
    const project = await seedProject(testDb.db, user.id);

    const run = await createRun(testDb.db, {
      projectId: project.id,
      serviceId: 'listing-launch',
      serviceVersion: 1,
      marketProfileId: 'nl',
      marketProfileVersion: 2,
      outputLanguage: 'en',
    });

    expect(run).toMatchObject({
      status: 'queued',
      serviceId: 'listing-launch',
      serviceVersion: 1,
      marketProfileId: 'nl',
      marketProfileVersion: 2,
      gate: null,
      startedAt: null,
      finishedAt: null,
      lastEventSeq: 0,
    });
    expect(await getRun(testDb.db, run.id)).toEqual(run);
    expect((await listRunsForProject(testDb.db, project.id)).map((r) => r.id)).toEqual([run.id]);
  });

  it('walks the happy path through a gate and logs every status change as an event', async () => {
    const { run } = await seedRunWithParents(testDb.db);

    const running = await transitionRun(testDb.db, run.id, { to: 'running', stepId: 'intake' });
    expect(running.status).toBe('running');
    expect(running.currentStepId).toBe('intake');
    expect(running.startedAt).toBeInstanceOf(Date);

    const paused = await transitionRun(testDb.db, run.id, {
      to: 'awaiting_gate',
      gate: 'fact_conflicts',
    });
    expect(paused.status).toBe('awaiting_gate');
    expect(paused.gate).toBe('fact_conflicts');

    const resumed = await transitionRun(testDb.db, run.id, { to: 'running', stepId: 'creative' });
    expect(resumed.gate).toBeNull();
    // startedAt keeps the first start time across resumes.
    expect(resumed.startedAt).toEqual(running.startedAt);

    const completed = await transitionRun(testDb.db, run.id, { to: 'completed' });
    expect(completed.status).toBe('completed');
    expect(completed.finishedAt).toBeInstanceOf(Date);
    expect(completed.lastEventSeq).toBe(4);

    const events = await listRunEvents(testDb.db, run.id);
    expect(events.map((e) => [e.seq, e.type, e.payload])).toEqual([
      [1, 'run_status_changed', { from: 'queued', to: 'running' }],
      [2, 'run_status_changed', { from: 'running', to: 'awaiting_gate', gate: 'fact_conflicts' }],
      [3, 'run_status_changed', { from: 'awaiting_gate', to: 'running' }],
      [4, 'run_status_changed', { from: 'running', to: 'completed' }],
    ]);
  });

  it('records a failure reason and allows resuming a failed run', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    await transitionRun(testDb.db, run.id, { to: 'running' });

    const failed = await transitionRun(testDb.db, run.id, {
      to: 'failed',
      reason: 'step vision_inventory failed twice',
    });
    expect(failed.failureReason).toBe('step vision_inventory failed twice');
    expect(failed.finishedAt).toBeInstanceOf(Date);

    const requeued = await transitionRun(testDb.db, run.id, { to: 'queued' });
    expect(requeued).toMatchObject({ status: 'queued', failureReason: null, finishedAt: null });
  });

  it('rejects illegal transitions without changing state or logging an event', async () => {
    const { run } = await seedRunWithParents(testDb.db);

    await expect(
      transitionRun(testDb.db, run.id, { to: 'awaiting_gate', gate: 'claim_audit' }),
    ).rejects.toMatchObject({ name: 'InvalidRunTransitionError', from: 'queued' });
    await expect(transitionRun(testDb.db, run.id, { to: 'completed' })).rejects.toBeInstanceOf(
      InvalidRunTransitionError,
    );

    await transitionRun(testDb.db, run.id, { to: 'running' });
    await transitionRun(testDb.db, run.id, { to: 'completed' });
    await expect(transitionRun(testDb.db, run.id, { to: 'running' })).rejects.toBeInstanceOf(
      InvalidRunTransitionError,
    );

    expect((await getRun(testDb.db, run.id))?.status).toBe('completed');
    expect(await listRunEvents(testDb.db, run.id)).toHaveLength(2);
  });

  it('serializes concurrent transitions: exactly one of two racing starts wins', async () => {
    const { run } = await seedRunWithParents(testDb.db);

    const results = await Promise.allSettled([
      transitionRun(testDb.db, run.id, { to: 'running', stepId: 'a' }),
      transitionRun(testDb.db, run.id, { to: 'running', stepId: 'b' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(InvalidRunTransitionError);
  });

  it('rolls the transition back when the surrounding transaction fails', async () => {
    const { run } = await seedRunWithParents(testDb.db);

    await expect(
      testDb.db.transaction(async (tx) => {
        await transitionRun(tx, run.id, { to: 'running' });
        throw new Error('enqueue failed');
      }),
    ).rejects.toThrow('enqueue failed');

    expect((await getRun(testDb.db, run.id))?.status).toBe('queued');
    expect(await listRunEvents(testDb.db, run.id)).toEqual([]);
  });

  it('enforces the gate/status invariant in the database itself', async () => {
    const { run } = await seedRunWithParents(testDb.db);

    await expect(
      testDb.db.update(runs).set({ status: 'awaiting_gate' }).where(eq(runs.id, run.id)),
    ).rejects.toMatchObject(violates('runs_gate_iff_awaiting'));
    await expect(
      testDb.db.update(runs).set({ gate: 'claim_audit' }).where(eq(runs.id, run.id)),
    ).rejects.toMatchObject(violates('runs_gate_iff_awaiting'));
    await expect(
      testDb.db.update(runs).set({ status: 'failed' }).where(eq(runs.id, run.id)),
    ).rejects.toMatchObject(violates('runs_failed_has_reason'));
  });

  it('reports a missing run', async () => {
    await expect(transitionRun(testDb.db, missingId, { to: 'running' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('run events repository', () => {
  it('appends events with a per-run sequence and lists them in order', async () => {
    const first = await seedRunWithParents(testDb.db);
    const second = await seedRunWithParents(testDb.db);

    const e1 = await appendRunEvent(testDb.db, first.run.id, {
      type: 'step_started',
      payload: { stepId: 'intake' },
    });
    const other = await appendRunEvent(testDb.db, second.run.id, { type: 'step_started' });
    const e2 = await appendRunEvent(testDb.db, first.run.id, {
      type: 'usage_recorded',
      payload: { costUsd: '0.00012500', modelId: 'muse-voice-transcribe-1.0' },
    });

    expect([e1.seq, e2.seq, other.seq]).toEqual([1, 2, 1]);
    expect(e2.occurredAt.getTime()).toBeGreaterThanOrEqual(e1.occurredAt.getTime());
    expect(other.payload).toEqual({});

    const events = await listRunEvents(testDb.db, first.run.id);
    expect(events).toEqual([e1, e2]);
    expect(await listRunEvents(testDb.db, first.run.id, { afterSeq: 1 })).toEqual([e2]);
    expect(await listRunEvents(testDb.db, first.run.id, { limit: 1 })).toEqual([e1]);
  });

  it('keeps distinct timestamps for events appended in one transaction', async () => {
    const { run } = await seedRunWithParents(testDb.db);

    const [a, b] = await testDb.db.transaction(async (tx) => {
      const x = await appendRunEvent(tx, run.id, { type: 'step_started' });
      await tx.execute(sql`select pg_sleep(0.01)`);
      const y = await appendRunEvent(tx, run.id, { type: 'step_completed' });
      return [x, y];
    });

    expect(b.occurredAt.getTime()).toBeGreaterThan(a.occurredAt.getTime());
  });

  it('produces a gapless sequence under concurrent appends', async () => {
    const { run } = await seedRunWithParents(testDb.db);

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendRunEvent(testDb.db, run.id, { type: 'step_started', payload: { i } }),
      ),
    );

    const seqs = (await listRunEvents(testDb.db, run.id)).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('rejects unknown event types and appends to missing runs', async () => {
    const { run } = await seedRunWithParents(testDb.db);

    await expect(
      // @ts-expect-error -- verifies the runtime guard behind the type
      appendRunEvent(testDb.db, run.id, { type: 'something_else' }),
    ).rejects.toThrow();
    await expect(
      appendRunEvent(testDb.db, missingId, { type: 'step_started' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('is append-only: direct updates and deletes are refused by the database', async () => {
    const { run } = await seedRunWithParents(testDb.db);
    await appendRunEvent(testDb.db, run.id, { type: 'step_started' });

    const appendOnly = { cause: { message: expect.stringContaining('append-only') as unknown } };
    await expect(
      testDb.db.update(runEvents).set({ type: 'step_failed' }).where(eq(runEvents.runId, run.id)),
    ).rejects.toMatchObject(appendOnly);
    await expect(
      testDb.db.delete(runEvents).where(eq(runEvents.runId, run.id)),
    ).rejects.toMatchObject(appendOnly);

    // Cascading deletes from the run (project hard delete) still go through.
    await testDb.db.delete(runs).where(eq(runs.id, run.id));
    expect(await listRunEvents(testDb.db, run.id)).toEqual([]);
  });
});
