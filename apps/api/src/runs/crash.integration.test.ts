import { spawn, type ChildProcess } from 'node:child_process';
import { stepCompletedPayloadSchema } from '@evidomo/shared';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { listRunEvents } from '../db/repositories/run-events.ts';
import { listRunSteps } from '../db/repositories/run-steps.ts';
import { getRun } from '../db/repositories/runs.ts';
import { listUsageForRun } from '../db/repositories/usage.ts';
import {
  seedProject,
  seedRun,
  seedUser,
  startTestDatabase,
  type TestDatabase,
} from '../db/testing.ts';
import { createLogger } from '../logger.ts';
import { createRunEngine, type RunEngine } from './engine.ts';
import {
  CRASH_SERVICE,
  CRASH_SLOW_STEP,
  CRASH_TEST_TIMING,
  createInvocationLog,
  listInvocations,
  releaseInvocation,
  testRegistry,
  waitFor,
} from './testing.ts';

// The Done-when of P2-03: a real worker process is SIGKILLed while a step runs, a new one picks
// the run up, and the run completes without re-executing completed steps.

const fixture = fileURLToPath(new URL('./crash-worker.fixture.ts', import.meta.url));

// Every wait is a condition, never a sleep. The bound only decides how long a broken run takes
// to fail; it is generous because this file runs next to other Testcontainers suites, where
// spawning a worker and pg-boss's crash recovery are several times slower than alone.
const WAIT_TIMEOUT_MS = 60_000;

interface WorkerProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  /** stdout + stderr so far, printed when a test fails. */
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
const workers: WorkerProcess[] = [];
const bossErrors: Error[] = [];

async function spawnWorker(extraEnv: Record<string, string> = {}): Promise<WorkerProcess> {
  const child = spawn(process.execPath, [fixture], {
    // Only what the worker needs; nothing from the developer's environment.
    env: {
      PATH: process.env['PATH'] ?? '',
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      DATABASE_URL: testDb.container.getConnectionUri(),
      DAILY_BUDGET_USD: '5.00',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const pid = await new Promise<number>((resolve, reject) => {
    child.once('message', (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'pid' in message) {
        resolve(Number(message.pid));
      } else reject(new Error(`Unexpected message from worker: ${JSON.stringify(message)}`));
    });
    void exited.then(({ code, signal }) => {
      reject(new Error(`Worker exited before ready (${code ?? signal ?? '?'}):\n${output}`));
    });
  });
  const worker: WorkerProcess = { child, pid, output: () => output, exited };
  workers.push(worker);
  return worker;
}

async function seedCrashRun(): Promise<string> {
  const user = await seedUser(testDb.db);
  const project = await seedProject(testDb.db, user.id);
  const run = await seedRun(testDb.db, project.id, {
    serviceId: CRASH_SERVICE.id,
    serviceVersion: CRASH_SERVICE.version,
  });
  return run.id;
}

async function waitForInvocation(
  runId: string,
  stepId: string,
  n: number,
  timeoutMs = WAIT_TIMEOUT_MS,
) {
  return waitFor(
    `invocation ${n} of step ${stepId}`,
    async () =>
      (await listInvocations(testDb.db, runId)).find((i) => i.stepId === stepId && i.n === n),
    { timeoutMs },
  );
}

async function waitForRunStatus(runId: string, status: string, timeoutMs = WAIT_TIMEOUT_MS) {
  return waitFor(
    `run ${runId} to be ${status}`,
    async () => {
      const run = await getRun(testDb.db, runId);
      if (run?.status === 'failed') throw new Error(`Run failed: ${run.failureReason ?? ''}`);
      return run?.status === status ? run : undefined;
    },
    { timeoutMs },
  );
}

/**
 * The handler logs its invocation before it bills its model call. A kill between the two would
 * lose the bill this test wants to see survive the crash, so the kill waits for the ledger row.
 */
async function waitForUsageRows(runId: string, stepId: string, count: number) {
  return waitFor(
    `${count} usage row(s) of step ${stepId}`,
    async () => {
      const rows = (await listUsageForRun(testDb.db, runId)).filter((u) => u.stepId === stepId);
      return rows.length >= count ? rows : undefined;
    },
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}

async function stopWorker({ child, exited }: WorkerProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  await createInvocationLog(testDb.db);
  // The test process plays the API: it starts runs, it does not work jobs or supervise.
  boss = new PgBoss({
    connectionString: testDb.container.getConnectionUri(),
    supervise: false,
    schedule: false,
  });
  boss.on('error', (error) => {
    bossErrors.push(error);
  });
  await boss.start();
  engine = createRunEngine({
    db: testDb.db,
    boss,
    registry: testRegistry(CRASH_SERVICE),
    logger: createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' }),
    dailyCapUsd: '5.00',
    ...CRASH_TEST_TIMING,
  });
  await engine.ensureQueues();
});

afterEach(async (context) => {
  if (context.task.result?.state === 'fail') {
    for (const error of bossErrors) console.error('test-process pg-boss error', error);
    for (const worker of workers) {
      console.error(`--- worker ${worker.pid} output ---\n${worker.output()}`);
    }
  }
  // A test that stops midway (a failed assertion) must not leave its workers polling the queue:
  // they would take the next test's jobs, which that test expects its own workers to run.
  await Promise.all(workers.splice(0).map(stopWorker));
});

afterAll(async () => {
  await Promise.all(workers.splice(0).map(stopWorker));
  await boss?.stop({ graceful: false });
  await testDb?.stop();
});

describe('worker crash and restart', () => {
  it('completes the run after SIGKILL mid-step without re-executing completed steps', async () => {
    const runId = await seedCrashRun();
    const first = await spawnWorker();
    await engine.startRun(runId);

    // `intake` completed and the slow step is executing in the first worker.
    const interrupted = await waitForInvocation(runId, CRASH_SLOW_STEP, 1);
    expect(interrupted.pid).toBe(first.pid);
    const before = await listRunSteps(testDb.db, runId);
    expect(before.find((s) => s.stepId === 'intake')?.status).toBe('completed');
    expect(before.find((s) => s.stepId === CRASH_SLOW_STEP)?.status).toBe('running');
    await waitForUsageRows(runId, CRASH_SLOW_STEP, 1);

    first.child.kill('SIGKILL');
    expect(await first.exited).toEqual({ code: null, signal: 'SIGKILL' });

    // pg-boss fails the orphaned job once its heartbeat is stale; the new worker retries it.
    const second = await spawnWorker();
    const rerun = await waitForInvocation(runId, CRASH_SLOW_STEP, 2);
    expect(rerun.pid).toBe(second.pid);
    await releaseInvocation(testDb.db, runId, CRASH_SLOW_STEP, 2);
    await waitForRunStatus(runId, 'completed');

    // Each completed step ran once; the interrupted one ran again exactly once.
    const invocations = await listInvocations(testDb.db, runId);
    expect(invocations).toEqual([
      { stepId: 'export', n: 1, pid: second.pid },
      { stepId: CRASH_SLOW_STEP, n: 1, pid: first.pid },
      { stepId: CRASH_SLOW_STEP, n: 2, pid: second.pid },
      { stepId: 'intake', n: 1, pid: first.pid },
    ]);

    const steps = await listRunSteps(testDb.db, runId);
    expect(steps.map((s) => [s.stepId, s.attempt, s.status, s.executions])).toEqual([
      ['intake', 1, 'completed', 1],
      [CRASH_SLOW_STEP, 1, 'completed', 2],
      ['export', 1, 'completed', 1],
    ]);

    const events = await listRunEvents(testDb.db, runId);
    expect(
      countBy(
        events.filter((e) => e.type === 'step_completed'),
        (e) => stepCompletedPayloadSchema.parse(e.payload).stepId,
      ),
    ).toEqual({ intake: 1, [CRASH_SLOW_STEP]: 1, export: 1 });

    // One ledger row per invocation: nothing duplicated for completed steps. The interrupted
    // step's first call was really made (and billed) before the crash, so it stays recorded.
    const usage = await listUsageForRun(testDb.db, runId);
    expect(countBy(usage, (u) => u.stepId ?? '')).toEqual({
      intake: 1,
      [CRASH_SLOW_STEP]: 2,
      export: 1,
    });

    const jobs = await testDb.db.execute<{ state: string; retry_count: number }>(sql`
      select state, retry_count from pgboss.job
      where name = 'run-step' and singleton_key = ${`${runId}:${CRASH_SLOW_STEP}:1`}
    `);
    expect(jobs.rows).toEqual([{ state: 'completed', retry_count: 1 }]);

    second.child.kill('SIGTERM');
    expect(await second.exited).toEqual({ code: 0, signal: null });
  }, 180_000);

  it('lets an in-flight step finish on SIGTERM and stops fetching new steps', async () => {
    const runId = await seedCrashRun();
    const first = await spawnWorker({ SHUTDOWN_TIMEOUT_MS: '30000' });
    await engine.startRun(runId);
    await waitForInvocation(runId, CRASH_SLOW_STEP, 1);

    first.child.kill('SIGTERM');
    await waitFor(
      'the worker to begin shutting down',
      () => Promise.resolve(first.output().includes('worker shutting down') ? true : undefined),
      { timeoutMs: WAIT_TIMEOUT_MS },
    );
    // Released only after shutdown began: the step finishes inside the grace period.
    await releaseInvocation(testDb.db, runId, CRASH_SLOW_STEP, 1);
    expect(await first.exited).toEqual({ code: 0, signal: null });

    const steps = await listRunSteps(testDb.db, runId);
    expect(steps.map((s) => [s.stepId, s.status, s.executions])).toEqual([
      ['intake', 'completed', 1],
      [CRASH_SLOW_STEP, 'completed', 1],
      // Enqueued in the completion transaction, but not fetched by the stopping worker.
      ['export', 'queued', 0],
    ]);

    const second = await spawnWorker();
    await waitForRunStatus(runId, 'completed');
    const exports = (await listInvocations(testDb.db, runId)).filter((i) => i.stepId === 'export');
    expect(exports).toEqual([{ stepId: 'export', n: 1, pid: second.pid }]);

    second.child.kill('SIGTERM');
    expect(await second.exited).toEqual({ code: 0, signal: null });
  }, 180_000);
});
