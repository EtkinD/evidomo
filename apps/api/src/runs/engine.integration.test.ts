import { randomUUID } from 'node:crypto';
import type { ServiceDefinition } from '@evidomo/shared';
import { sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidRunTransitionError } from '../db/errors.ts';
import { listArtifacts, insertArtifact } from '../db/repositories/artifacts.ts';
import { listRunEvents } from '../db/repositories/run-events.ts';
import { createRunStep, listRunSteps } from '../db/repositories/run-steps.ts';
import { getRun, transitionRun, type Run } from '../db/repositories/runs.ts';
import { listUsageForRun } from '../db/repositories/usage.ts';
import {
  seedProject,
  seedRun,
  seedUser,
  startTestDatabase,
  type TestDatabase,
} from '../db/testing.ts';
import { createLogger } from '../logger.ts';
import { createRunEngine, type RunEngine, type RunEngineOptions, type StepJob } from './engine.ts';
import { RUN_STEP_QUEUE, type StepJobData } from './queue.ts';
import { StepTimeoutError, type StepContext, type StepResult } from './steps.ts';
import {
  buildTestService,
  fakeModelCall,
  placeholderMetaClients,
  testRegistry,
  uniformHandlers,
  untilAborted,
  waitFor,
} from './testing.ts';

const GATED = buildTestService('gated', [
  { id: 'intake', agent: 'intake' },
  { id: 'extract', agent: 'extractor' },
  { id: 'reconcile', agent: 'reconciler', gate_after: 'fact_conflicts' },
  { id: 'export', agent: 'exporter' },
]);
const LINEAR = buildTestService('linear', [
  { id: 'a', agent: 'intake' },
  { id: 'b', agent: 'extractor' },
  { id: 'c', agent: 'exporter' },
]);
const TIMEOUTS = buildTestService('timeouts', [
  { id: 'quick', agent: 'intake' },
  { id: 'hangs', agent: 'extractor' },
]);
// One fake call costs 0.003375 USD, so the second call of a step is refused.
const TINY_BUDGET = buildTestService(
  'tiny-budget',
  [
    { id: 'spend', agent: 'extractor' },
    { id: 'never', agent: 'exporter' },
  ],
  '0.001',
);
const HANG_TIMEOUT_MS = 1000;

type Behavior = (context: StepContext) => Promise<StepResult | undefined>;

interface Call {
  runId: string;
  stepId: string;
  execution: number;
}

let testDb: TestDatabase;
const bosses: PgBoss[] = [];
let primaryBoss: PgBoss;
let engine: RunEngine;
const calls: Call[] = [];
/** Per-run step behavior; runs without one log the call and bill one fake model call. */
const behaviors = new Map<string, Behavior>();

const logger = createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' });
const registry = testRegistry(GATED, LINEAR, TIMEOUTS, TINY_BUDGET);

function engineOptions(boss: PgBoss): RunEngineOptions {
  return {
    db: testDb.db,
    boss,
    registry,
    logger,
    dailyCapUsd: '5.00',
    handlers: uniformHandlers(async (context) => {
      calls.push({
        runId: context.run.id,
        stepId: context.step.id,
        execution: context.execution,
      });
      const behavior = behaviors.get(context.run.id);
      if (behavior !== undefined) return behavior(context);
      await fakeModelCall(context);
      return undefined;
    }),
    createMetaClients: placeholderMetaClients,
    stepTimeoutMs: (step) => (step.id === 'hangs' ? HANG_TIMEOUT_MS : 30_000),
    heartbeatSeconds: 10,
    expiryGraceSeconds: 5,
    retryDelaySeconds: 0,
  };
}

async function startBoss(): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: testDb.container.getConnectionUri(),
    superviseIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
  });
  boss.on('error', (error) => {
    logger.error({ err: error }, 'pg-boss error in test');
  });
  await boss.start();
  bosses.push(boss);
  return boss;
}

async function seedServiceRun(service: ServiceDefinition): Promise<Run> {
  const user = await seedUser(testDb.db);
  const project = await seedProject(testDb.db, user.id);
  return seedRun(testDb.db, project.id, { serviceId: service.id, serviceVersion: service.version });
}

async function waitForStatus(runId: string, status: Run['status']): Promise<Run> {
  return waitFor(`run to be ${status}`, async () => {
    const run = await getRun(testDb.db, runId);
    return run?.status === status ? run : undefined;
  });
}

function callsOf(runId: string): string[] {
  return calls.filter((c) => c.runId === runId).map((c) => `${c.stepId}#${c.execution}`);
}

async function stepJobs(runId: string): Promise<{ key: string; state: string }[]> {
  const result = await testDb.db.execute<{ key: string; state: string }>(sql`
    select singleton_key as key, state from pgboss.job
    where name = ${RUN_STEP_QUEUE} and data->>'runId' = ${runId}
    order by created_on
  `);
  return result.rows;
}

/** A running run with an open attempt whose job exists only in the test (no worker sees it). */
async function fabricateOpenStep(
  service: ServiceDefinition,
  stepId: string,
): Promise<{ run: Run; data: StepJobData; jobId: string }> {
  const run = await seedServiceRun(service);
  await transitionRun(testDb.db, run.id, { to: 'running' });
  const jobId = randomUUID();
  const data: StepJobData = { runId: run.id, stepId, attempt: 1 };
  await createRunStep(testDb.db, { ...data, jobId });
  return { run, data, jobId };
}

function delivery(jobId: string, data: StepJobData, retryCount = 0): StepJob {
  return { id: jobId, retryCount, data, signal: new AbortController().signal };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  primaryBoss = await startBoss();
  engine = createRunEngine(engineOptions(primaryBoss));
  await engine.startWorkers({ pollingIntervalSeconds: 0.5 });
});

afterAll(async () => {
  for (const boss of bosses) await boss.stop({ graceful: false });
  await testDb?.stop();
});

describe('run engine', () => {
  it('runs each step as a job, pauses at the gate, and resumes after it', async () => {
    const run = await seedServiceRun(GATED);
    behaviors.set(run.id, async (context) => {
      await fakeModelCall(context);
      if (context.step.id !== 'extract') return undefined;
      return {
        async commit(tx) {
          const artifact = await insertArtifact(tx, {
            runId: context.run.id,
            stepId: context.step.id,
            kind: 'candidate_facts',
            content: { facts: [] },
          });
          return { artifactIds: [artifact.id] };
        },
      };
    });

    await engine.startRun(run.id);
    const paused = await waitForStatus(run.id, 'awaiting_gate');
    expect(paused.gate).toBe('fact_conflicts');
    expect(paused.currentStepId).toBe('reconcile');
    expect(callsOf(run.id)).toEqual(['intake#1', 'extract#1', 'reconcile#1']);
    // The gate is a state: nothing after it is scheduled until the run is resumed.
    expect((await stepJobs(run.id)).map((j) => j.key)).toEqual([
      `${run.id}:intake:1`,
      `${run.id}:extract:1`,
      `${run.id}:reconcile:1`,
    ]);

    const [artifact] = await listArtifacts(testDb.db, run.id);
    const steps = await listRunSteps(testDb.db, run.id);
    expect(steps.map((s) => [s.stepId, s.status, s.executions, s.outputArtifactIds])).toEqual([
      ['intake', 'completed', 1, []],
      ['extract', 'completed', 1, [artifact?.id]],
      ['reconcile', 'completed', 1, []],
    ]);

    const events = await listRunEvents(testDb.db, run.id);
    expect(events.map((e) => e.type)).toEqual([
      'run_status_changed',
      ...['intake', 'extract', 'reconcile'].flatMap(() => [
        'step_started',
        'usage_recorded',
        'step_completed',
      ]),
      'run_status_changed',
      'gate_opened',
    ]);
    const extractCompleted = events.find(
      (e) => e.type === 'step_completed' && e.payload['stepId'] === 'extract',
    );
    expect(extractCompleted?.payload).toEqual({
      stepId: 'extract',
      attempt: 1,
      execution: 1,
      artifactIds: [artifact?.id],
      stepCostUsd: '0.00337500',
      runCostUsd: '0.00675000',
    });
    expect(events.at(-1)?.payload).toEqual({ gate: 'fact_conflicts', stepId: 'reconcile' });

    await expect(engine.resumeAfterGate(run.id, { gate: 'claim_audit' })).rejects.toThrow(
      'is not awaiting gate claim_audit',
    );
    await engine.resumeAfterGate(run.id, { gate: 'fact_conflicts' });
    await waitForStatus(run.id, 'completed');
    expect(callsOf(run.id)).toEqual(['intake#1', 'extract#1', 'reconcile#1', 'export#1']);
    const released = (await listRunSteps(testDb.db, run.id)).find((s) => s.stepId === 'reconcile');
    expect(released?.gateReleasedAt).toBeInstanceOf(Date);
    await expect(engine.resumeAfterGate(run.id)).rejects.toBeInstanceOf(InvalidRunTransitionError);
  });

  it('enqueues inside the caller transaction: a rollback leaves neither state nor job', async () => {
    const run = await seedServiceRun(LINEAR);
    class Rollback extends Error {}

    await expect(
      testDb.db.transaction(async (tx) => {
        const started = await engine.startRun(run.id, { tx });
        expect(started.status).toBe('running');
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect((await getRun(testDb.db, run.id))?.status).toBe('queued');
    expect(await listRunSteps(testDb.db, run.id)).toEqual([]);
    expect(await stepJobs(run.id)).toEqual([]);
    expect(await listRunEvents(testDb.db, run.id)).toEqual([]);

    await engine.startRun(run.id);
    await waitForStatus(run.id, 'completed');
    expect(callsOf(run.id)).toEqual(['a#1', 'b#1', 'c#1']);
  });

  it('retries a transient failure once and then continues', async () => {
    const run = await seedServiceRun(LINEAR);
    behaviors.set(run.id, async (context) => {
      await fakeModelCall(context);
      if (context.step.id === 'b' && context.execution === 1) {
        throw new Error('connection reset; prompt text that must not be stored');
      }
      return undefined;
    });

    await engine.startRun(run.id);
    await waitForStatus(run.id, 'completed');
    expect(callsOf(run.id)).toEqual(['a#1', 'b#1', 'b#2', 'c#1']);

    const failed = (await listRunEvents(testDb.db, run.id)).filter((e) => e.type === 'step_failed');
    expect(failed.map((e) => e.payload)).toEqual([
      {
        stepId: 'b',
        attempt: 1,
        execution: 1,
        reason: 'Unexpected Error',
        willRetry: true,
        stepCostUsd: '0.00337500',
        runCostUsd: '0.00675000',
      },
    ]);
    // Both executions of `b` made their (fake) call; nothing else is billed twice.
    const usage = await listUsageForRun(testDb.db, run.id);
    expect(usage.map((u) => u.stepId).sort()).toEqual(['a', 'b', 'b', 'c']);
  });

  it('fails the run after a second failure and resumes it without re-running completed steps', async () => {
    const run = await seedServiceRun(LINEAR);
    let healthy = false;
    behaviors.set(run.id, (context) =>
      context.step.id === 'b' && !healthy
        ? Promise.reject(new TypeError('still broken'))
        : Promise.resolve(undefined),
    );

    await engine.startRun(run.id);
    const failed = await waitForStatus(run.id, 'failed');
    expect(failed.failureReason).toBe('Step "b" failed after 2 executions: Unexpected TypeError');
    expect(callsOf(run.id)).toEqual(['a#1', 'b#1', 'b#2']);
    const lastFailure = (await listRunEvents(testDb.db, run.id))
      .filter((e) => e.type === 'step_failed')
      .at(-1);
    expect(lastFailure?.payload['willRetry']).toBe(false);

    healthy = true;
    await engine.resumeRun(run.id);
    await waitForStatus(run.id, 'completed');
    expect(callsOf(run.id)).toEqual(['a#1', 'b#1', 'b#2', 'b#1', 'c#1']);
    const steps = await listRunSteps(testDb.db, run.id);
    expect(steps.map((s) => [s.stepId, s.attempt, s.status, s.executions])).toEqual([
      ['a', 1, 'completed', 1],
      ['b', 1, 'failed', 2],
      ['b', 2, 'completed', 1],
      ['c', 1, 'completed', 1],
    ]);
  });

  it('fails the run at once when the budget is exhausted', async () => {
    const run = await seedServiceRun(TINY_BUDGET);
    behaviors.set(run.id, async (context) => {
      await fakeModelCall(context);
      await fakeModelCall(context);
      return undefined;
    });

    await engine.startRun(run.id);
    const failed = await waitForStatus(run.id, 'failed');
    expect(failed.failureReason).toBe(
      'Step "spend" failed after 1 execution: Run budget cap reached: spent 0.00337500 of 0.001 USD',
    );
    expect(callsOf(run.id)).toEqual(['spend#1']);
    expect((await listUsageForRun(testDb.db, run.id)).length).toBe(1);
  });

  it('times out a step, aborts its signal, and retries it once', async () => {
    const run = await seedServiceRun(TIMEOUTS);
    const abortReasons: unknown[] = [];
    behaviors.set(run.id, async (context) => {
      if (context.step.id !== 'hangs') return undefined;
      try {
        return await untilAborted(context.signal);
      } catch (reason) {
        abortReasons.push(reason);
        throw reason;
      }
    });

    await engine.startRun(run.id);
    const failed = await waitForStatus(run.id, 'failed');
    expect(failed.failureReason).toBe(
      'Step "hangs" failed after 2 executions: Step "hangs" timed out after 1 s',
    );
    expect(callsOf(run.id)).toEqual(['quick#1', 'hangs#1', 'hangs#2']);
    expect(abortReasons).toHaveLength(2);
    expect(abortReasons.every((r) => r instanceof StepTimeoutError)).toBe(true);
  });

  it('fails the run when no handler is registered for the step agent', async () => {
    const bare = createRunEngine({ ...engineOptions(primaryBoss), handlers: {} });
    const { run, data, jobId } = await fabricateOpenStep(LINEAR, 'a');

    expect(await bare.processStepJob(delivery(jobId, data))).toEqual({ outcome: 'run_failed' });
    const failed = await getRun(testDb.db, run.id);
    expect(failed?.failureReason).toBe(
      'Step "a" failed after 1 execution: No step handler is registered for agent "intake"',
    );
  });
});

describe('run engine concurrency', () => {
  it('rejects a duplicate enqueue of the same attempt and ignores stray jobs for completed steps', async () => {
    const run = await seedServiceRun(LINEAR);
    const gate = deferred();
    behaviors.set(run.id, async (context) => {
      if (context.step.id === 'a') await gate.promise;
      return undefined;
    });
    await engine.startRun(run.id);
    await waitFor('step a to start', () =>
      Promise.resolve(callsOf(run.id).includes('a#1') ? true : undefined),
    );

    const data: StepJobData = { runId: run.id, stepId: 'a', attempt: 1 };
    // Same idempotency key while the original job is active: pg-boss refuses it.
    expect(
      await primaryBoss.send(RUN_STEP_QUEUE, data, { singletonKey: `${run.id}:a:1` }),
    ).toBeNull();

    gate.resolve();
    await waitForStatus(run.id, 'completed');

    // A job with the same payload but not recorded on the attempt is a duplicate, never executed.
    const strayId = await primaryBoss.send(RUN_STEP_QUEUE, data);
    const stray = await waitFor('the stray job to settle', async () => {
      const result = await testDb.db.execute<{ state: string; output: unknown }>(
        sql`select state, output from pgboss.job where id = ${strayId}`,
      );
      const row = result.rows[0];
      return row?.state === 'completed' ? row : undefined;
    });
    // pg-boss wraps a non-object handler result as `{ value }`.
    expect(stray.output).toEqual({ value: [{ outcome: 'skipped', reason: 'duplicate_job' }] });
    expect(callsOf(run.id)).toEqual(['a#1', 'b#1', 'c#1']);
  });

  it('never executes two concurrent deliveries of the same attempt', async () => {
    const { run, data, jobId } = await fabricateOpenStep(LINEAR, 'a');
    const gate = deferred();
    behaviors.set(run.id, async (context) => {
      if (context.step.id === 'a') await gate.promise;
      return undefined;
    });

    const deliveries = [
      engine.processStepJob(delivery(jobId, data)),
      engine.processStepJob(delivery(jobId, data)),
    ];
    // One claims and blocks in the handler; the other sees the live claim and stays out.
    expect(await Promise.race(deliveries)).toEqual({
      outcome: 'skipped',
      reason: 'claimed_elsewhere',
    });
    gate.resolve();
    expect(await Promise.all(deliveries)).toContainEqual({ outcome: 'completed' });
    await waitForStatus(run.id, 'completed');
    expect(callsOf(run.id)).toEqual(['a#1', 'b#1', 'c#1']);
  });

  it('discards the result of a superseded execution so the step completes exactly once', async () => {
    const { run, data, jobId } = await fabricateOpenStep(LINEAR, 'a');
    const zombie = deferred();
    behaviors.set(run.id, async (context) => {
      if (context.step.id === 'a' && context.execution === 1) await zombie.promise;
      return undefined;
    });

    // Delivery 0 hangs (e.g. its worker stalled); pg-boss re-delivers the job as retry 1.
    const stalled = engine.processStepJob(delivery(jobId, data, 0));
    await waitFor('the first execution to start', () =>
      Promise.resolve(callsOf(run.id).includes('a#1') ? true : undefined),
    );
    expect(await engine.processStepJob(delivery(jobId, data, 1))).toEqual({
      outcome: 'completed',
    });

    zombie.resolve();
    expect(await stalled).toEqual({ outcome: 'superseded' });
    await waitForStatus(run.id, 'completed');

    const events = await listRunEvents(testDb.db, run.id);
    expect(
      events.filter((e) => e.type === 'step_completed').map((e) => e.payload['stepId']),
    ).toEqual(['a', 'b', 'c']);
    expect((await listRunSteps(testDb.db, run.id)).map((s) => [s.stepId, s.attempt])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ]);
    expect(callsOf(run.id)).toEqual(['a#1', 'a#2', 'b#1', 'c#1']);
  });

  it('executes every step once when two workers share the queue', async () => {
    const secondBoss = await startBoss();
    await createRunEngine(engineOptions(secondBoss)).startWorkers({
      pollingIntervalSeconds: 0.5,
      localConcurrency: 2,
    });

    const runs = await Promise.all(Array.from({ length: 6 }, () => seedServiceRun(LINEAR)));
    await Promise.all(runs.map((run) => engine.startRun(run.id)));
    for (const run of runs) await waitForStatus(run.id, 'completed');

    for (const run of runs) expect(callsOf(run.id)).toEqual(['a#1', 'b#1', 'c#1']);
  });

  it('fails a run whose step job was dead-lettered', async () => {
    const { run, data, jobId } = await fabricateOpenStep(LINEAR, 'b');
    expect(await engine.processDeadStepJob({ id: jobId, data })).toBe('run_failed');

    const failed = await getRun(testDb.db, run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.failureReason).toBe('Step "b" could not be recovered after repeated failures');
    expect((await listRunSteps(testDb.db, run.id)).map((s) => s.status)).toEqual(['failed']);
    expect(await engine.processDeadStepJob({ id: jobId, data })).toBe('skipped');
  });
});
