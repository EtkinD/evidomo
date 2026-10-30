import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  apiErrorSchema,
  authUserResponseSchema,
  RESUME_REFUSAL_CODES,
  runSnapshotSchema,
  resumeRunResponseSchema,
  runResumeUrl,
  runStatusChangedPayloadSchema,
  type ApiErrorCode,
  type ResumeRunResponse,
  type RunResumability,
  type ServiceDefinition,
} from '@evidomo/shared';
import { sql } from 'drizzle-orm';
import type { Express, RequestHandler } from 'express';
import { PgBoss } from 'pg-boss';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appConfigFromEnv, createApp } from '../app.ts';
import type { Executor } from '../db/client.ts';
import { addMaterial } from '../db/repositories/materials.ts';
import { lockProject, touchProject } from '../db/repositories/projects.ts';
import { listRunEvents } from '../db/repositories/run-events.ts';
import { listRunSteps } from '../db/repositories/run-steps.ts';
import { getRun, transitionRun, type Run } from '../db/repositories/runs.ts';
import { listUsageForRun } from '../db/repositories/usage.ts';
import { createUser } from '../db/repositories/users.ts';
import { seedProject, seedRun, startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { DEMO_OWNER_EMAIL } from '../demo/owner.ts';
import { loadEnv } from '../env.ts';
import { unusedProjectDeps, unusedRunDeps } from '../http/testing.ts';
import { createLogger, type Logger } from '../logger.ts';
import { createRunStartGuards } from '../projects/run-start-guards.ts';
import { createRunEngine, type RunEngine } from '../runs/engine.ts';
import { RUN_STEP_QUEUE } from '../runs/queue.ts';
import type { StepContext, StepResult } from '../runs/steps.ts';
import {
  buildTestService,
  fakeModelCall,
  placeholderMetaClients,
  testRegistry,
  uniformHandlers,
  waitFor,
} from '../runs/testing.ts';
import { createLocalStorage } from '../storage/local.ts';
import type { Storage } from '../storage/storage.ts';
import { BudgetExceededError } from '../usage/budget.ts';

// `POST /api/runs/:runId/resume` (P5-03) end to end: PostgreSQL in Testcontainers, the real run
// engine with pg-boss workers and fake metered steps (no model), and the app with its real
// routes. Failed runs come from real step failures (a step that keeps failing, a run cap that is
// reached) or are fabricated with `transitionRun` where only the status matters.

const logger = createLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' });
const PASSWORD = 'correct horse battery staple';
const ACCESS_CODE = 'synthetic-resume-access-code';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const LINEAR = buildTestService('resume-linear', [
  { id: 'a', agent: 'intake' },
  { id: 'b', agent: 'extractor' },
  { id: 'c', agent: 'exporter' },
]);
// One fake call costs 0.003375 USD, so the step's second call is refused by the run cap.
const TINY_BUDGET = buildTestService(
  'resume-tiny-budget',
  [
    { id: 'spend', agent: 'extractor' },
    { id: 'never', agent: 'exporter' },
  ],
  '0.001',
);
const registry = testRegistry(LINEAR, TINY_BUDGET);
// A service the registry does not know: a run of a definition version no longer deployed.
const RETIRED = buildTestService('resume-retired', [{ id: 'a', agent: 'intake' }]);

type Behavior = (context: StepContext) => Promise<StepResult | undefined>;

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let storageDir: string;
let storage: Storage;
/** Costs visible, no guards, daily cap 5 USD. */
let app: Express;
let hiddenApp: Express;
/** Daily cap 0: every resume meets a spent day. */
let noBudgetApp: Express;
let owner: { id: string; cookie: string };
let stranger: { id: string; cookie: string };
/** Handler invocations per run, as `step#execution`. */
const calls = new Map<string, string[]>();
/** Per-run step behavior; runs without one bill one fake model call per step. */
const behaviors = new Map<string, Behavior>();

function buildApp(
  options: {
    runCostsVisible?: 'true' | 'false';
    dailyCapUsd?: string;
    runStartGuards?: readonly RequestHandler[];
    logger?: Logger;
  } = {},
): Express {
  const env = loadEnv({
    DATABASE_URL: testDb.container.getConnectionUri(),
    NODE_ENV: 'test',
    RUN_COSTS_VISIBLE: options.runCostsVisible ?? 'true',
  });
  return createApp({
    db: testDb.client,
    logger: options.logger ?? logger,
    config: appConfigFromEnv(env),
    runs: { engine, markets: unusedRunDeps().markets, services: registry },
    storage,
    projects: {
      ...unusedProjectDeps(),
      dailyCapUsd: options.dailyCapUsd ?? '5.00',
      ...(options.runStartGuards === undefined ? {} : { runStartGuards: options.runStartGuards }),
    },
  });
}

async function register(email: string): Promise<{ id: string; cookie: string }> {
  const registered = await request(app)
    .post('/api/auth/register')
    .send({ email, password: PASSWORD });
  expect(registered.status).toBe(201);
  const [setCookie] = registered.get('set-cookie') ?? [];
  const cookie = setCookie?.split(';')[0];
  if (cookie === undefined) throw new Error('Registration set no cookie');
  return { id: authUserResponseSchema.parse(registered.body).user.id, cookie };
}

function resume(
  runId: string,
  options: { as?: { cookie: string }; target?: Express; body?: object } = {},
): Promise<request.Response> {
  const test = request(options.target ?? app)
    .post(runResumeUrl(runId))
    .set('Cookie', (options.as ?? owner).cookie);
  return (options.body === undefined ? test : test.send(options.body)).then((r) => r);
}

function errorOf(response: request.Response): ApiErrorCode {
  return apiErrorSchema.parse(response.body).error;
}

function resumed(response: request.Response): ResumeRunResponse {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return resumeRunResponseSchema.parse(response.body);
}

/** The snapshot's `resume` field (`GET /api/runs/:runId`). */
async function resumeField(runId: string, target: Express = app): Promise<RunResumability> {
  const response = await request(target).get(`/api/runs/${runId}`).set('Cookie', owner.cookie);
  expect(response.status).toBe(200);
  const { resume: value } = runSnapshotSchema.parse(response.body);
  if (value === undefined) throw new Error('The snapshot has no resume field');
  return value;
}

/**
 * The snapshot says `expected`, and the endpoint, deciding with the same function under its
 * locks, refuses with the 409 code mapped from it and changes nothing (status, jobs).
 */
async function expectRefusal(
  run: Run,
  expected: Exclude<RunResumability, 'available'>,
  target: Express = app,
): Promise<void> {
  expect([run.status, await resumeField(run.id, target)]).toEqual([run.status, expected]);
  const jobs = await stepJobs(run.id);
  const response = await resume(run.id, { target });
  expect([expected, response.status, errorOf(response)]).toEqual([
    expected,
    409,
    RESUME_REFUSAL_CODES[expected],
  ]);
  expect((await getRun(testDb.db, run.id))?.status).toBe(run.status);
  expect(await stepJobs(run.id)).toEqual(jobs);
}

async function projectOf(service: ServiceDefinition = LINEAR): Promise<{ id: string }> {
  return seedProject(testDb.db, owner.id, { title: `Resume ${service.id}` });
}

/** A run of `service` in `status`, without steps (only the status matters). */
async function fabricatedRun(
  projectId: string,
  status: Run['status'],
  options: { service?: ServiceDefinition; reason?: string } = {},
): Promise<Run> {
  const service = options.service ?? LINEAR;
  const run = await seedRun(testDb.db, projectId, {
    serviceId: service.id,
    serviceVersion: service.version,
  });
  if (status === 'queued') return run;
  await transitionRun(testDb.db, run.id, { to: 'running' });
  switch (status) {
    case 'running':
      return (await getRun(testDb.db, run.id)) ?? run;
    case 'failed':
      return transitionRun(testDb.db, run.id, {
        to: 'failed',
        reason: options.reason ?? 'Step "a" failed after 2 executions: Unexpected TypeError',
      });
    case 'awaiting_gate':
      return transitionRun(testDb.db, run.id, { to: 'awaiting_gate', gate: 'fact_conflicts' });
    case 'completed':
      return transitionRun(testDb.db, run.id, { to: 'completed' });
    default: {
      const unreachable: never = status;
      throw new Error(`Unhandled status ${String(unreachable)}`);
    }
  }
}

async function waitForStatus(runId: string, status: Run['status']): Promise<Run> {
  return waitFor(`run to be ${status}`, async () => {
    const run = await getRun(testDb.db, runId);
    return run?.status === status ? run : undefined;
  });
}

/** A promise the test resolves: a step behavior that waits on it holds the run in `running`. */
function latch(): { opened: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Steps hold until `held` opens (the run stays `running`), then bill one fake call. */
function holdingBehavior(held: Promise<void>): Behavior {
  return async (context) => {
    await Promise.race([
      held,
      new Promise<never>((_, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
    ]);
    await fakeModelCall(context);
    return undefined;
  };
}

async function stepJobs(runId: string): Promise<{ stepId: string; attempt: number }[]> {
  const result = await testDb.db.execute<{ step_id: string; attempt: number }>(sql`
    select data->>'stepId' as step_id, (data->>'attempt')::int as attempt
    from pgboss.job where name = ${RUN_STEP_QUEUE} and data->>'runId' = ${runId}
    order by created_on, step_id
  `);
  return result.rows.map((row) => ({ stepId: row.step_id, attempt: row.attempt }));
}

/** Sessions waiting for a row lock (pg_stat_activity), for ordering the race tests. */
async function untilLockWaiters(count: number): Promise<void> {
  await waitFor(`${count} session(s) waiting for a lock`, async () => {
    const result = await testDb.db.execute<{ count: string }>(sql`
      select count(*) as count from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
    `);
    return Number(result.rows[0]?.count) >= count ? true : undefined;
  });
}

/** Holds a transaction open until `release` is called; `ready` resolves once `work` ran. */
function holdTransaction(work: (tx: Executor) => Promise<unknown>) {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready = (): void => undefined;
  const isReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const done = testDb.db.transaction(async (tx) => {
    await work(tx);
    ready();
    await released;
  });
  return { ready: isReady, release, done };
}

function capturingLogger(): { logger: Logger; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { logger: pino({ level: 'info' }, stream), output: () => chunks.join('') };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-resume-storage-'));
  storage = createLocalStorage({ rootDir: storageDir });
  boss = new PgBoss({
    connectionString: testDb.container.getConnectionUri(),
    superviseIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
  });
  boss.on('error', (error) => {
    logger.error({ err: error }, 'pg-boss error in test');
  });
  await boss.start();
  engine = createRunEngine({
    db: testDb.db,
    boss,
    registry,
    logger,
    dailyCapUsd: '5.00',
    handlers: uniformHandlers(async (context) => {
      const log = calls.get(context.run.id) ?? [];
      log.push(`${context.step.id}#${context.execution}`);
      calls.set(context.run.id, log);
      const behavior = behaviors.get(context.run.id);
      if (behavior !== undefined) return behavior(context);
      await fakeModelCall(context);
      return undefined;
    }),
    createMetaClients: placeholderMetaClients,
    stepTimeoutMs: () => 30_000,
    heartbeatSeconds: 10,
    expiryGraceSeconds: 5,
    retryDelaySeconds: 0,
  });
  await engine.startWorkers({ pollingIntervalSeconds: 0.5 });

  app = buildApp();
  hiddenApp = buildApp({ runCostsVisible: 'false' });
  noBudgetApp = buildApp({ dailyCapUsd: '0' });
  owner = await register('resume-owner@example.test');
  stranger = await register('resume-stranger@example.test');
}, 120_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await testDb?.stop();
  if (storageDir !== undefined) await rm(storageDir, { recursive: true, force: true });
});

describe('POST /api/runs/:runId/resume', () => {
  it('queues a failed run again and continues it without re-running or re-billing completed steps', async () => {
    const project = await projectOf();
    const run = await seedRun(testDb.db, project.id, {
      serviceId: LINEAR.id,
      serviceVersion: LINEAR.version,
    });
    let healthy = false;
    const held = latch();
    behaviors.set(run.id, async (context) => {
      if (context.step.id !== 'b') {
        await fakeModelCall(context);
        return undefined;
      }
      if (!healthy) throw new TypeError('still broken');
      // The resumed attempt holds until the snapshot has been checked.
      return holdingBehavior(held.opened)(context);
    });
    await engine.startRun(run.id);
    await waitForStatus(run.id, 'failed');
    expect(calls.get(run.id)).toEqual(['a#1', 'b#1', 'b#2']);

    healthy = true;
    expect(await resumeField(run.id)).toBe('available');
    const body = resumed(await resume(run.id));
    expect(body.run.resume).toBe('not_failed');
    expect(body.run).toMatchObject({
      id: run.id,
      status: 'running',
      failureReason: null,
      finishedAt: null,
      currentStepId: 'b',
      costCapUsd: '0.50',
    });
    expect(body.run.costUsd).toBe('0.00337500');
    expect(
      body.run.steps.map((step) => [step.stepId, step.status, step.attempt, step.attempts]),
    ).toEqual([
      ['a', 'completed', 1, 1],
      // `queued` until a worker claims the new attempt, `running` after.
      ['b', expect.stringMatching(/^(queued|running)$/), 2, 2],
      ['c', 'pending', null, 0],
    ]);
    // The new attempt's job was enqueued with the transition (not a re-run of `a`).
    expect(await stepJobs(run.id)).toEqual([
      { stepId: 'a', attempt: 1 },
      { stepId: 'b', attempt: 1 },
      { stepId: 'b', attempt: 2 },
    ]);
    const statusChanges = (await listRunEvents(testDb.db, run.id))
      .filter((event) => event.type === 'run_status_changed')
      .map((event) => {
        const { from, to } = runStatusChangedPayloadSchema.parse(event.payload);
        return `${from}→${to}`;
      });
    expect(statusChanges.slice(-2)).toEqual(['failed→queued', 'queued→running']);

    held.open();
    await waitForStatus(run.id, 'completed');
    expect(calls.get(run.id)).toEqual(['a#1', 'b#1', 'b#2', 'b#1', 'c#1']);
    const steps = await listRunSteps(testDb.db, run.id);
    expect(steps.map((s) => [s.stepId, s.attempt, s.status, s.executions])).toEqual([
      ['a', 1, 'completed', 1],
      ['b', 1, 'failed', 2],
      ['b', 2, 'completed', 1],
      ['c', 1, 'completed', 1],
    ]);
    // `a` was billed once, before the failure; only the resumed work added rows.
    const usage = await listUsageForRun(testDb.db, run.id);
    expect(usage.map((row) => row.stepId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('accepts no body, an empty object, and refuses unknown fields', async () => {
    const project = await projectOf();
    const first = await fabricatedRun(project.id, 'failed');
    const held = latch();
    behaviors.set(first.id, holdingBehavior(held.opened));
    expect(resumed(await resume(first.id)).run.status).toBe('running');

    const other = await projectOf();
    const second = await fabricatedRun(other.id, 'failed');
    behaviors.set(second.id, holdingBehavior(held.opened));
    const refused = await resume(second.id, { body: { accessCode: 'x', extra: true } });
    expect([refused.status, errorOf(refused)]).toEqual([400, 'validation_failed']);
    expect(resumed(await resume(second.id, { body: {} })).run.status).toBe('running');
    held.open();
    await waitForStatus(first.id, 'completed');
    await waitForStatus(second.id, 'completed');
  });

  it('refuses a run that is not failed with 409 run_not_resumable and changes nothing', async () => {
    const project = await projectOf();
    for (const status of ['queued', 'running', 'awaiting_gate', 'completed'] as const) {
      const run = await fabricatedRun(project.id, status);
      await expectRefusal(run, 'not_failed');
      // Clear the way for the next status: only one run of a project may be active.
      if (status !== 'completed') {
        await testDb.db.execute(sql`delete from runs where id = ${run.id}`);
      }
    }
  });

  it("answers 404 for another user's run and an unknown run, 400 for a malformed ID", async () => {
    const project = await projectOf();
    const run = await fabricatedRun(project.id, 'failed');
    const foreign = await resume(run.id, { as: stranger });
    expect([foreign.status, errorOf(foreign)]).toEqual([404, 'not_found']);
    const unknown = await resume('00000000-0000-4000-8000-000000000000');
    expect([unknown.status, errorOf(unknown)]).toEqual([404, 'not_found']);
    const malformed = await resume('not-a-uuid');
    expect([malformed.status, errorOf(malformed)]).toEqual([400, 'validation_failed']);
    const anonymous = await request(app).post(runResumeUrl(run.id)).send({});
    expect([anonymous.status, errorOf(anonymous)]).toEqual([401, 'unauthenticated']);
    expect((await getRun(testDb.db, run.id))?.status).toBe('failed');
  });

  it('refuses with 409 run_active while another run of the project is active', async () => {
    const project = await projectOf();
    const failed = await fabricatedRun(project.id, 'failed');
    const active = await fabricatedRun(project.id, 'awaiting_gate');
    await expectRefusal(failed, 'other_run_active');
    expect((await getRun(testDb.db, active.id))?.status).toBe('awaiting_gate');
  });

  it('refuses with 409 run_not_resumable when the run definition is no longer deployed', async () => {
    const project = await projectOf();
    const run = await fabricatedRun(project.id, 'failed', { service: RETIRED });
    await expectRefusal(run, 'definition_unavailable');
  });

  it('refuses with 409 run_not_resumable once the inputs changed after the run was created', async () => {
    // A material deleted or uploaded, or the fact form or office profile saved (`updated_at`).
    const touched = await projectOf();
    const first = await fabricatedRun(touched.id, 'failed');
    await touchProject(testDb.db, touched.id);
    await expectRefusal(first, 'inputs_changed');

    // A material row created after the run, even without the project row changing.
    const added = await projectOf();
    const second = await fabricatedRun(added.id, 'failed');
    await addMaterial(testDb.db, {
      projectId: added.id,
      kind: 'photo',
      storageKey: `projects/${added.id}/late-photo.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
    });
    await expectRefusal(second, 'inputs_changed');
  });

  it('refuses a run whose own spend reached its cap with 409 run_budget_exhausted', async () => {
    const project = await projectOf(TINY_BUDGET);
    const run = await seedRun(testDb.db, project.id, {
      serviceId: TINY_BUDGET.id,
      serviceVersion: TINY_BUDGET.version,
    });
    behaviors.set(run.id, async (context) => {
      await fakeModelCall(context);
      await fakeModelCall(context);
      return undefined;
    });
    await engine.startRun(run.id);
    const failed = await waitForStatus(run.id, 'failed');
    expect(failed.failureReason).toMatch(/Run budget cap reached/);

    // Decided by the ledger against the cap, not by the stored text: the same answer with run
    // costs hidden, and before the daily cap (a run cap never passes with the day).
    for (const target of [app, hiddenApp, noBudgetApp]) {
      await expectRefusal(failed, 'budget_exhausted', target);
    }
    expect((await listRunSteps(testDb.db, run.id)).map((s) => [s.stepId, s.attempt])).toEqual([
      ['spend', 1],
    ]);
    expect(calls.get(run.id)).toEqual(['spend#1']);
  });

  it('resumes a run that failed on the daily cap once the daily cap allows it', async () => {
    const project = await projectOf();
    const reason = `Step "a" failed after 1 execution: ${new BudgetExceededError('daily', '5.00', '5.00100000').message}`;
    const run = await fabricatedRun(project.id, 'failed', { reason });

    await expectRefusal(run, 'daily_budget_reached', noBudgetApp);
    // The same run on a server whose day still has budget.
    expect(await resumeField(run.id)).toBe('available');

    const held = latch();
    behaviors.set(run.id, holdingBehavior(held.opened));
    expect(resumed(await resume(run.id)).run.status).toBe('running');
    held.open();
    await waitForStatus(run.id, 'completed');
  });

  it('leaves every cost key out of the response when run costs are hidden', async () => {
    const project = await projectOf();
    const run = await fabricatedRun(project.id, 'failed');
    // The decision reads the ledger, but the field is a state: no cost key, no amount.
    const before = await request(hiddenApp).get(`/api/runs/${run.id}`).set('Cookie', owner.cookie);
    expect(runSnapshotSchema.parse(before.body).resume).toBe('available');
    expect(JSON.stringify(before.body)).not.toMatch(/costUsd|costCapUsd|CostUsd|USD/);
    const held = latch();
    behaviors.set(run.id, holdingBehavior(held.opened));
    const body = resumed(await resume(run.id, { target: hiddenApp }));
    expect(body.run.status).toBe('running');
    expect(body.run.costUsd).toBeUndefined();
    expect(body.run.costCapUsd).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/costUsd|costCapUsd|CostUsd|USD/);
    held.open();
    await waitForStatus(run.id, 'completed');
  });

  it('applies the run start guards: access code, shared allowance, refunds; logs no code', async () => {
    const captured = capturingLogger();
    const guarded = buildApp({
      logger: captured.logger,
      runStartGuards: createRunStartGuards({
        accessCode: ACCESS_CODE,
        limits: {
          perAccount: { limit: 1, windowMs: DAY },
          perIp: { limit: 10, windowMs: DAY },
          accessCodeFailuresPerIp: { limit: 10, windowMs: HOUR },
        },
        logger: captured.logger,
      }),
    });
    const completed = await fabricatedRun((await projectOf()).id, 'completed');
    const first = await fabricatedRun((await projectOf()).id, 'failed');
    const second = await fabricatedRun((await projectOf()).id, 'failed');
    const held = latch();
    behaviors.set(first.id, holdingBehavior(held.opened));

    for (const body of [undefined, {}, { accessCode: 'wrong-synthetic-code' }]) {
      const response = await resume(first.id, { target: guarded, ...(body ? { body } : {}) });
      expect([response.status, errorOf(response)]).toEqual([403, 'access_code_invalid']);
    }
    expect((await getRun(testDb.db, first.id))?.status).toBe('failed');

    // A refused resume gives its reservation back: the allowance of 1 is still there after it.
    const notResumable = await resume(completed.id, {
      target: guarded,
      body: { accessCode: ACCESS_CODE },
    });
    expect([notResumable.status, errorOf(notResumable)]).toEqual([409, 'run_not_resumable']);
    expect(
      resumed(await resume(first.id, { target: guarded, body: { accessCode: ACCESS_CODE } })).run
        .status,
    ).toBe('running');

    const limited = await resume(second.id, {
      target: guarded,
      body: { accessCode: ACCESS_CODE },
    });
    expect([limited.status, errorOf(limited)]).toEqual([429, 'run_limit_reached']);
    expect(Number(limited.get('retry-after'))).toBeGreaterThan(0);
    expect((await getRun(testDb.db, second.id))?.status).toBe('failed');

    const logs = captured.output();
    expect(logs).not.toContain(ACCESS_CODE);
    expect(logs).not.toContain('wrong-synthetic-code');
    const resumedLine = logs
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry['msg'] === 'run resumed');
    expect(resumedLine).toMatchObject({ runId: first.id, userId: owner.id });
    held.open();
    await waitForStatus(first.id, 'completed');
  });
});

describe('the snapshot on the public demo API', () => {
  it('serves `resume: not_failed` for a demo run, which is always completed', async () => {
    // The demo API serves only completed runs of the demo owner's projects.
    const demoOwner = await createUser(testDb.db, {
      email: DEMO_OWNER_EMAIL,
      passwordHash: 'not-a-real-hash',
    });
    const project = await seedProject(testDb.db, demoOwner.id);
    const run = await fabricatedRun(project.id, 'completed');
    const env = loadEnv({
      DATABASE_URL: testDb.container.getConnectionUri(),
      NODE_ENV: 'test',
      RUN_COSTS_VISIBLE: 'false',
    });
    const demoApp = createApp({
      db: testDb.client,
      logger,
      config: appConfigFromEnv(env),
      runs: { engine, markets: unusedRunDeps().markets, services: registry },
      storage,
      projects: unusedProjectDeps(),
      demo: { runIds: [run.id] },
    });
    const response = await request(demoApp).get(`/api/demo/runs/${run.id}`);
    expect(response.status).toBe(200);
    expect(runSnapshotSchema.parse(response.body).resume).toBe('not_failed');
  });
});

describe('races', () => {
  it('two concurrent resumes: one queues the run, the other gets 409 run_not_resumable', async () => {
    const project = await projectOf();
    const run = await fabricatedRun(project.id, 'failed');
    const held = latch();
    behaviors.set(run.id, holdingBehavior(held.opened));
    // Both pass their unlocked ownership read, then queue on the project lock.
    const blocker = holdTransaction((tx) => lockProject(tx, project.id));
    await blocker.ready;
    const both = Promise.all([resume(run.id), resume(run.id)]);
    await untilLockWaiters(2);
    blocker.release();
    await blocker.done;

    const responses = await both;
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = responses.find((r) => r.status === 409);
    expect(loser && errorOf(loser)).toBe('run_not_resumable');
    expect(await stepJobs(run.id)).toEqual([{ stepId: 'a', attempt: 1 }]);
    const requeued = (await listRunEvents(testDb.db, run.id)).filter(
      (event) => event.type === 'run_status_changed' && event.payload['to'] === 'queued',
    );
    expect(requeued).toHaveLength(1);
    held.open();
    await waitForStatus(run.id, 'completed');
  });

  it('a resume that waited behind a project deletion answers 404 and enqueues nothing', async () => {
    const project = await projectOf();
    const run = await fabricatedRun(project.id, 'failed');
    const blocker = holdTransaction((tx) => lockProject(tx, project.id));
    await blocker.ready;
    const deletion = request(app)
      .delete(`/api/projects/${project.id}`)
      .set('Cookie', owner.cookie)
      .then((r) => r);
    await untilLockWaiters(1);
    const resumption = resume(run.id);
    await untilLockWaiters(2);
    blocker.release();
    await blocker.done;

    expect((await deletion).status).toBe(204);
    const response = await resumption;
    expect([response.status, errorOf(response)]).toEqual([404, 'not_found']);
    expect(await getRun(testDb.db, run.id)).toBeUndefined();
    expect(await stepJobs(run.id)).toEqual([]);
  });

  it('a deletion that waited behind a resume answers 409 run_in_progress', async () => {
    const project = await projectOf();
    const run = await fabricatedRun(project.id, 'failed');
    const held = latch();
    behaviors.set(run.id, holdingBehavior(held.opened));
    const blocker = holdTransaction((tx) => lockProject(tx, project.id));
    await blocker.ready;
    const resumption = resume(run.id);
    await untilLockWaiters(1);
    const deletion = request(app)
      .delete(`/api/projects/${project.id}`)
      .set('Cookie', owner.cookie)
      .then((r) => r);
    await untilLockWaiters(2);
    blocker.release();
    await blocker.done;

    expect(resumed(await resumption).run.status).toBe('running');
    const deleted = await deletion;
    expect([deleted.status, errorOf(deleted)]).toEqual([409, 'run_in_progress']);
    expect((await getRun(testDb.db, run.id))?.status).toBe('running');
    held.open();
    await waitForStatus(run.id, 'completed');
  });
});
