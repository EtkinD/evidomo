import type { Server } from 'node:http';
import {
  RUN_STREAM_END_EVENT,
  authUserResponseSchema,
  projectRunsResponseSchema,
  runSnapshotSchema,
  runStreamEventSchema,
  type RunStreamEvent,
} from '@evidomo/shared';
import type { Express } from 'express';
import { PgBoss } from 'pg-boss';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appConfigFromEnv, createApp } from '../app.ts';
import { listRunEvents } from '../db/repositories/run-events.ts';
import { listRunSteps } from '../db/repositories/run-steps.ts';
import { getRun, transitionRun, type Run } from '../db/repositories/runs.ts';
import { listUsageForRun } from '../db/repositories/usage.ts';
import { seedProject, seedRun, startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { loadEnv } from '../env.ts';
import { unusedProjectDeps, unusedRunDeps, unusedStorage } from '../http/testing.ts';
import { createLogger } from '../logger.ts';
import { createRunEngine, type RunEngine } from '../runs/engine.ts';
import {
  buildTestService,
  fakeModelCall,
  placeholderMetaClients,
  testRegistry,
  uniformHandlers,
  waitFor,
} from '../runs/testing.ts';
import {
  BudgetExceededError,
  DAILY_BUDGET_REACHED_REASON,
  RUN_BUDGET_REACHED_REASON,
  UNDISCLOSED_FAILURE_REASON,
} from '../usage/budget.ts';
import { InvalidBudgetCapError } from '../usage/ledger.ts';
import { openSse } from './testing.ts';

// Cost visibility end to end (docs/architecture.md §10 "Cost visibility"): the real engine runs a
// run into its budget cap (PostgreSQL in Testcontainers, pg-boss, fake metered calls, no model),
// and the same database is read through an app with `RUN_COSTS_VISIBLE` on and one with it off.
// Hidden: no cost key in the snapshot, the run list, or the stream; `usage_recorded` arrives as
// `withheld` at its own seq; the budget failure is stated without amounts. The database keeps
// the exact reason, the events with their costs, and the ledger rows either way.

const logger = createLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' });
const PASSWORD = 'correct horse battery staple';
// One fake call costs 0.003375 USD, so the step's second call is refused by the run cap.
const OVER_BUDGET = buildTestService(
  'over-budget',
  [
    { id: 'spend', agent: 'extractor' },
    { id: 'never', agent: 'exporter' },
  ],
  '0.001',
);
const EXACT_REASON =
  'Step "spend" failed after 1 execution: Run budget cap reached: spent 0.00337500 of 0.001 USD';
const PUBLIC_REASON = `Step "spend" failed after 1 execution: ${RUN_BUDGET_REACHED_REASON}`;

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let visibleApp: Express;
let hiddenApp: Express;
let hiddenServer: Server;
let hiddenBaseUrl: string;
let cookie: string;
let run: Run;
let projectId: string;

function appWith(runCostsVisible: 'true' | 'false'): Express {
  const env = loadEnv({
    DATABASE_URL: testDb.container.getConnectionUri(),
    NODE_ENV: 'test',
    RUN_COSTS_VISIBLE: runCostsVisible,
  });
  return createApp({
    db: testDb.client,
    logger,
    config: appConfigFromEnv(env),
    runs: { ...unusedRunDeps(), services: testRegistry(OVER_BUDGET) },
    storage: unusedStorage(),
    projects: unusedProjectDeps(),
  });
}

const costKeys = /costUsd|costCapUsd|CostUsd/;

beforeAll(async () => {
  testDb = await startTestDatabase();
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
    registry: testRegistry(OVER_BUDGET),
    logger,
    dailyCapUsd: '5.00',
    handlers: uniformHandlers(async (context) => {
      await fakeModelCall(context);
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

  visibleApp = appWith('true');
  hiddenApp = appWith('false');
  hiddenServer = hiddenApp.listen(0);
  await new Promise<void>((resolve) => hiddenServer.once('listening', () => resolve()));
  const address = hiddenServer.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  hiddenBaseUrl = `http://127.0.0.1:${address.port}`;

  // Sessions live in the database, so one registration works on both apps.
  const registered = await request(visibleApp)
    .post('/api/auth/register')
    .send({ email: 'cost-visibility@example.test', password: PASSWORD });
  expect(registered.status).toBe(201);
  const [setCookie] = registered.get('set-cookie') ?? [];
  const sessionCookie = setCookie?.split(';')[0];
  if (sessionCookie === undefined) throw new Error('Registration set no cookie');
  cookie = sessionCookie;
  const userId = authUserResponseSchema.parse(registered.body).user.id;

  const project = await seedProject(testDb.db, userId);
  projectId = project.id;
  run = await seedRun(testDb.db, project.id, {
    serviceId: OVER_BUDGET.id,
    serviceVersion: OVER_BUDGET.version,
  });
  await engine.startRun(run.id);
  await waitFor('the run to fail on its budget', async () => {
    const current = await getRun(testDb.db, run.id);
    return current?.status === 'failed' ? current : undefined;
  });
}, 120_000);

afterAll(async () => {
  hiddenServer.closeAllConnections();
  await new Promise<void>((resolve) => hiddenServer.close(() => resolve()));
  await boss.stop({ graceful: false });
  await testDb.stop();
});

describe('run costs visible (development and test default)', () => {
  it('shows costs, the cap, and the exact budget reason', async () => {
    const response = await request(visibleApp).get(`/api/runs/${run.id}`).set('Cookie', cookie);
    expect(response.status).toBe(200);
    const snapshot = runSnapshotSchema.parse(response.body);
    expect(snapshot).toMatchObject({
      status: 'failed',
      failureReason: EXACT_REASON,
      costUsd: '0.00337500',
      costCapUsd: '0.001',
    });
    expect(snapshot.steps[0]).toMatchObject({
      stepId: 'spend',
      costUsd: '0.00337500',
      error: EXACT_REASON,
    });
  });
});

describe('run costs hidden (production default)', () => {
  it('leaves every cost key out of the snapshot and states the budget failure without amounts', async () => {
    const response = await request(hiddenApp).get(`/api/runs/${run.id}`).set('Cookie', cookie);
    expect(response.status).toBe(200);
    const snapshot = runSnapshotSchema.parse(response.body);
    expect(snapshot.status).toBe('failed');
    expect(snapshot.failureReason).toBe(PUBLIC_REASON);
    expect(snapshot.steps.map((step) => [step.stepId, step.status, step.error])).toEqual([
      ['spend', 'failed', PUBLIC_REASON],
      ['never', 'pending', null],
    ]);
    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(costKeys);
    expect(text).not.toMatch(/USD|0\.00337500|0\.001/);
  });

  it('leaves the cost out of the project run list and redacts its reason', async () => {
    const response = await request(hiddenApp)
      .get(`/api/projects/${run.projectId}/runs`)
      .set('Cookie', cookie);
    expect(response.status).toBe(200);
    const { runs } = projectRunsResponseSchema.parse(response.body);
    expect(runs.map((r) => [r.id, r.failureReason])).toEqual([[run.id, PUBLIC_REASON]]);
    expect(JSON.stringify(response.body)).not.toMatch(costKeys);
  });

  it('streams every seq once, usage_recorded as withheld, with no costs or amounts', async () => {
    const stored = await listRunEvents(testDb.db, run.id);
    expect(stored.map((e) => e.type)).toEqual([
      'run_status_changed',
      'step_started',
      'usage_recorded',
      'step_failed',
      'run_status_changed',
    ]);
    const stream = await openSse(`${hiddenBaseUrl}/api/runs/${run.id}/events`, { Cookie: cookie });
    expect(stream.status).toBe(200);
    await stream.closed();
    const data = stream.messages().filter((m) => m.data !== undefined && m.event === undefined);
    const received: RunStreamEvent[] = data.map((m) =>
      runStreamEventSchema.parse(JSON.parse(m.data ?? '')),
    );
    expect(data.map((m) => m.id)).toEqual(stored.map((e) => String(e.seq)));
    expect(received.map((e) => e.type)).toEqual([
      'run_status_changed',
      'step_started',
      'withheld',
      'step_failed',
      'run_status_changed',
    ]);
    const failed = received[3];
    expect(failed?.type === 'step_failed' && failed.payload.reason).toBe(PUBLIC_REASON);
    const ended = received[4];
    expect(ended?.type === 'run_status_changed' && ended.payload.reason).toBe(PUBLIC_REASON);
    expect(stream.messages().at(-1)?.event).toBe(RUN_STREAM_END_EVENT);
    expect(stream.text()).not.toMatch(costKeys);
    expect(stream.text()).not.toMatch(/usage_recorded|USD|0\.00337500/);
  });

  it('keeps the exact reason, the costed events, and the ledger rows in the database', async () => {
    expect((await getRun(testDb.db, run.id))?.failureReason).toBe(EXACT_REASON);
    const [spend] = await listRunSteps(testDb.db, run.id);
    expect(spend?.error).toBe(EXACT_REASON);
    const usage = await listUsageForRun(testDb.db, run.id);
    expect(usage.map((row) => [row.stepId, row.estimatedCostUsd])).toEqual([
      ['spend', '0.00337500'],
    ]);
    const stored = await listRunEvents(testDb.db, run.id);
    expect(stored.find((e) => e.type === 'usage_recorded')?.payload).toMatchObject({
      stepCostUsd: '0.00337500',
      runCostUsd: '0.00337500',
    });
    expect(stored.find((e) => e.type === 'step_failed')?.payload).toMatchObject({
      reason: EXACT_REASON,
      runCostUsd: '0.00337500',
    });
  });

  it('states the daily cap and an invalid cap without amounts or configuration, snapshot and stream', async () => {
    const cases = [
      {
        stored: `Step "spend" failed after 1 execution: ${new BudgetExceededError('daily', '5.00', '5.00120000').message}`,
        shown: `Step "spend" failed after 1 execution: ${DAILY_BUDGET_REACHED_REASON}`,
      },
      {
        stored: `Step "spend" failed after 1 execution: ${new InvalidBudgetCapError('daily').message}`,
        shown: UNDISCLOSED_FAILURE_REASON,
      },
    ];
    for (const { stored, shown } of cases) {
      const failed = await seedRun(testDb.db, projectId, {
        serviceId: OVER_BUDGET.id,
        serviceVersion: OVER_BUDGET.version,
      });
      await transitionRun(testDb.db, failed.id, { to: 'running' });
      await transitionRun(testDb.db, failed.id, { to: 'failed', reason: stored });

      const response = await request(hiddenApp).get(`/api/runs/${failed.id}`).set('Cookie', cookie);
      expect(runSnapshotSchema.parse(response.body).failureReason).toBe(shown);
      const stream = await openSse(`${hiddenBaseUrl}/api/runs/${failed.id}/events`, {
        Cookie: cookie,
      });
      await stream.closed();
      const reasons = stream
        .messages()
        .filter((m) => m.data !== undefined && m.event === undefined)
        .map((m) => runStreamEventSchema.parse(JSON.parse(m.data ?? '')))
        .flatMap((e) =>
          e.type === 'run_status_changed' && e.payload.reason ? [e.payload.reason] : [],
        );
      expect(reasons).toEqual([shown]);
      expect(stream.text()).not.toMatch(/USD|5\.00/);
      expect((await getRun(testDb.db, failed.id))?.failureReason).toBe(stored);
    }
  });
});
