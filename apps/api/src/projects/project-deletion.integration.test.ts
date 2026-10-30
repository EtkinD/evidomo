import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  apiErrorSchema,
  authUserResponseSchema,
  projectDetailResponseSchema,
  type CreateProjectRequest,
} from '@evidomo/shared';
import { sql } from 'drizzle-orm';
import type { Express } from 'express';
import { PgBoss } from 'pg-boss';
import { pino } from 'pino';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appConfigFromEnv, createApp } from '../app.ts';
import { seedDevRun } from '../cli/dev-seed-run.ts';
import type { Executor } from '../db/client.ts';
import { lockProject } from '../db/repositories/projects.ts';
import { createRunStep } from '../db/repositories/run-steps.ts';
import { getRun, lockRun, transitionRun, type Run } from '../db/repositories/runs.ts';
import { seedRun, startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { loadDefinitions, type DefinitionRegistry } from '../definitions/loader.ts';
import { loadEnv } from '../env.ts';
import { createLogger, type Logger } from '../logger.ts';
import { runFfmpegTests } from '../media/testing.ts';
import { createRunEngine, type RunEngine } from '../runs/engine.ts';
import { RUN_STEP_DEAD_LETTER_QUEUE, RUN_STEP_QUEUE } from '../runs/queue.ts';
import { waitFor } from '../runs/testing.ts';
import { createLocalStorage } from '../storage/local.ts';
import type { Storage } from '../storage/storage.ts';
import { STORAGE_BINDING_KEY, sweepOrphanedProjectFiles } from './orphan-files.ts';

// Project deletion (P5-04) through HTTP, against PostgreSQL (Testcontainers), local storage in a
// temp directory, and the real run engine with a send-only pg-boss (no workers). One project is a
// real run of the synthetic walkthrough through the whole pipeline in fixture mode (`dev:seed`,
// zero live calls), so every derived table and every kind of stored file is present; the rest
// use fabricated runs.

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });
const PASSWORD = 'correct horse battery staple';
const APP_ORIGIN = 'http://localhost:3000';
const DEMO_PROJECT = fileURLToPath(
  new URL('../../../../fixtures/projects/synthetic-walkthrough', import.meta.url),
);

const NEW_PROJECT: CreateProjectRequest = {
  title: 'Synthetic deletion target',
  officeProfile: { agencyName: 'Example Makelaardij', tone: 'warm' },
  market: { id: 'nl', version: 1 },
  outputLanguage: 'en',
};

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let definitions: DefinitionRegistry;
let storageDir: string;
let storage: Storage;
let app: Express;

interface Operator {
  readonly id: string;
  readonly email: string;
  readonly agent: ReturnType<typeof request.agent>;
}
let owner: Operator;
let stranger: Operator;

function buildApp(options: { storage?: Storage; logger?: Logger } = {}): Express {
  const env = loadEnv({
    DATABASE_URL: testDb.container.getConnectionUri(),
    NODE_ENV: 'test',
    APP_ORIGIN,
  });
  return createApp({
    db: testDb.client,
    logger: options.logger ?? logger,
    config: appConfigFromEnv(env),
    runs: { engine, markets: definitions, services: definitions },
    storage: options.storage ?? storage,
    projects: { definitions, dailyCapUsd: '5.00' },
  });
}

async function signUp(): Promise<Operator> {
  const agent = request.agent(app);
  const email = `operator-${randomUUID()}@example.test`;
  const response = await agent.post('/api/auth/register').send({ email, password: PASSWORD });
  expect(response.status).toBe(201);
  return { id: authUserResponseSchema.parse(response.body).user.id, email, agent };
}

async function loginOn(target: Express, operator: Operator) {
  const agent = request.agent(target);
  const login = await agent
    .post('/api/auth/login')
    .send({ email: operator.email, password: PASSWORD });
  expect(login.status).toBe(200);
  return agent;
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

async function createProject(as: Operator = owner): Promise<string> {
  const response = await as.agent.post('/api/projects').send(NEW_PROJECT);
  expect(response.status).toBe(201);
  return projectDetailResponseSchema.parse(response.body).project.id;
}

async function tinyJpeg(seed: number): Promise<Buffer> {
  return sharp({
    create: { width: 32, height: 24, channels: 3, background: { r: seed % 256, g: 80, b: 160 } },
  })
    .jpeg()
    .toBuffer();
}

async function uploadPhoto(projectId: string, seed: number, as: Operator = owner) {
  return as.agent
    .post(`/api/projects/${projectId}/materials/photos`)
    .set('Content-Type', 'image/jpeg')
    .send(await tinyJpeg(seed));
}

function deleteProjectRequest(projectId: string, as: Operator = owner) {
  return as.agent.delete(`/api/projects/${projectId}`);
}

function errorOf(response: request.Response) {
  return apiErrorSchema.parse(response.body);
}

/** A PostgreSQL array literal (Drizzle would expand a JS array into a parameter list). */
function uuidArray(ids: readonly string[]): string {
  return `{${ids.join(',')}}`;
}

/** Files below `projects/<id>/` on disk (nothing else is ever stored for a project). */
async function filesOf(projectId: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(storageDir, 'projects', projectId), {
      recursive: true,
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(storageDir, path.join(entry.parentPath, entry.name)));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function projectDirExists(projectId: string): Promise<boolean> {
  return (await storage.listChildren('projects')).includes(projectId);
}

/**
 * Rows referring to the project or one of its runs, in every table that has a `project_id` or
 * `run_id` column (found in the catalog, so a table added later is covered too), plus claims by
 * their artifacts.
 */
async function rowsReferring(
  projectId: string,
  runIds: readonly string[],
  artifactIds: readonly string[],
): Promise<Record<string, number>> {
  const columns = await testDb.db.execute<{ table_name: string; column_name: string }>(sql`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and column_name in ('project_id', 'run_id')
    order by table_name, column_name
  `);
  const counts: Record<string, number> = {};
  for (const { table_name: table, column_name: column } of columns.rows) {
    const ids = column === 'project_id' ? [projectId] : [...runIds];
    const result = await testDb.db.execute<{ count: string }>(sql`
      select count(*) as count from ${sql.identifier(table)}
      where ${sql.identifier(column)}::text = any(${uuidArray(ids)}::text[])
    `);
    counts[`${table}.${column}`] = Number(result.rows[0]?.count);
  }
  const claims = await testDb.db.execute<{ count: string }>(sql`
    select count(*) as count from claims where artifact_id::text = any(${uuidArray(artifactIds)}::text[])
  `);
  counts['claims.artifact_id'] = Number(claims.rows[0]?.count);
  const projectRows = await testDb.db.execute<{ count: string }>(
    sql`select count(*) as count from projects where id = ${projectId}`,
  );
  counts['projects.id'] = Number(projectRows.rows[0]?.count);
  return counts;
}

function allZero(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.keys(counts).map((key) => [key, 0]));
}

async function idsOf(projectId: string): Promise<{
  runIds: string[];
  artifactIds: string[];
  usageIds: string[];
  storageKeys: string[];
}> {
  const runs = await testDb.db.execute<{ id: string }>(
    sql`select id from runs where project_id = ${projectId}`,
  );
  const runIds = runs.rows.map((row) => row.id);
  const artifacts = await testDb.db.execute<{ id: string; storage_key: string | null }>(
    sql`select id, storage_key from artifacts where run_id::text = any(${uuidArray(runIds)}::text[])`,
  );
  const usage = await testDb.db.execute<{ id: string }>(
    sql`select id from usage_ledger where run_id::text = any(${uuidArray(runIds)}::text[])`,
  );
  const materials = await testDb.db.execute<{ storage_key: string }>(
    sql`select storage_key from materials where project_id = ${projectId}`,
  );
  return {
    runIds,
    artifactIds: artifacts.rows.map((row) => row.id),
    usageIds: usage.rows.map((row) => row.id),
    storageKeys: [
      ...materials.rows.map((row) => row.storage_key),
      ...artifacts.rows.flatMap((row) => (row.storage_key === null ? [] : [row.storage_key])),
    ],
  };
}

/** Sessions waiting for a row lock (pg_stat_activity), for ordering the race tests. */
async function lockWaiters(): Promise<number> {
  const result = await testDb.db.execute<{ count: string }>(sql`
    select count(*) as count from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock'
  `);
  return Number(result.rows[0]?.count);
}

async function untilLockWaiters(count: number): Promise<void> {
  await waitFor(`${count} session(s) waiting for a lock`, async () =>
    (await lockWaiters()) >= count ? true : undefined,
  );
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

async function fabricatedRun(projectId: string, status: Run['status']): Promise<Run> {
  const run = await seedRun(testDb.db, projectId);
  if (status === 'queued') return run;
  if (status === 'failed')
    return transitionRun(testDb.db, run.id, { to: 'failed', reason: 'test' });
  await transitionRun(testDb.db, run.id, { to: 'running' });
  if (status === 'running') return (await getRun(testDb.db, run.id)) ?? run;
  if (status === 'awaiting_gate') {
    return transitionRun(testDb.db, run.id, { to: 'awaiting_gate', gate: 'fact_conflicts' });
  }
  return transitionRun(testDb.db, run.id, { to: 'completed' });
}

async function jobsOf(runId: string): Promise<{ name: string; state: string }[]> {
  const result = await testDb.db.execute<{ name: string; state: string }>(sql`
    select name, state from pgboss.job where data->>'runId' = ${runId} order by name
  `);
  return result.rows;
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  definitions = await loadDefinitions();
  storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-deletion-storage-'));
  storage = createLocalStorage({ rootDir: storageDir });
  // Send-only, like the API process.
  boss = new PgBoss({
    connectionString: testDb.container.getConnectionUri(),
    supervise: false,
    schedule: false,
  });
  boss.on('error', (error) => {
    logger.error({ err: error }, 'pg-boss error in test');
  });
  await boss.start();
  engine = createRunEngine({
    db: testDb.db,
    boss,
    registry: definitions,
    logger,
    dailyCapUsd: '5.00',
  });
  await engine.ensureQueues();
  app = buildApp();
  owner = await signUp();
  stranger = await signUp();
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await boss?.stop({ graceful: false });
  await testDb?.stop();
  if (storageDir !== undefined) await rm(storageDir, { recursive: true, force: true });
});

describe('DELETE /api/projects/:projectId', () => {
  it.skipIf(!runFfmpegTests)(
    'hard-deletes a completed run: every row and file goes, ledger rows stay without the run',
    async () => {
      // A real run, from capture to export, so materials, steps, events, facts, artifacts (with
      // staged images, integrity retries, and export files), claims, decisions, and ledger rows
      // all exist.
      const seeded = await seedDevRun({
        projectDir: DEMO_PROJECT,
        ownerEmail: owner.email,
        stopAt: 'completed',
        db: testDb.db,
        connectionString: testDb.container.getConnectionUri(),
        storage,
        logger,
        progress: () => undefined,
        nodeEnv: 'test',
      });
      expect(seeded.status).toBe('completed');
      const { projectId } = seeded;
      // Neighbours that must survive: another project of the owner, and a stranger's project.
      const sibling = await createProject();
      expect((await uploadPhoto(sibling, 1)).status).toBe(201);
      const strangers = await createProject(stranger);
      expect((await uploadPhoto(strangers, 2, stranger)).status).toBe(201);
      const siblingFiles = await filesOf(sibling);
      const strangerFiles = await filesOf(strangers);

      const ids = await idsOf(projectId);
      const before = await rowsReferring(projectId, ids.runIds, ids.artifactIds);
      // The fixture really covers every table, so "zero after" proves something.
      for (const table of [
        'materials.project_id',
        'runs.project_id',
        'run_steps.run_id',
        'run_events.run_id',
        'facts.run_id',
        'artifacts.run_id',
        'decisions.run_id',
        'usage_ledger.run_id',
        'claims.artifact_id',
      ]) {
        expect(before[table], table).toBeGreaterThan(0);
      }
      const files = await filesOf(projectId);
      expect(files.length).toBeGreaterThanOrEqual(ids.storageKeys.length);
      expect(ids.storageKeys.some((key) => key.includes('/runs/'))).toBe(true);
      const siblingRows = await rowsReferring(sibling, [], []);

      const deleted = await deleteProjectRequest(projectId);
      expect(deleted.status).toBe(204);
      expect(deleted.text).toBe('');

      expect(await rowsReferring(projectId, ids.runIds, ids.artifactIds)).toEqual(allZero(before));
      for (const key of ids.storageKeys) expect(await storage.exists(key), key).toBe(false);
      expect(await filesOf(projectId)).toEqual([]);
      expect(await projectDirExists(projectId)).toBe(false);
      // Spend stays in the daily total: the rows remain, without their run.
      const ledger = await testDb.db.execute<{ run_id: string | null }>(
        sql`select run_id from usage_ledger where id::text = any(${uuidArray(ids.usageIds)}::text[])`,
      );
      expect(ledger.rows).toHaveLength(ids.usageIds.length);
      expect(ledger.rows.every((row) => row.run_id === null)).toBe(true);
      // Nobody else's data moved.
      expect(await rowsReferring(sibling, [], [])).toEqual(siblingRows);
      expect(await filesOf(sibling)).toEqual(siblingFiles);
      expect(await filesOf(strangers)).toEqual(strangerFiles);
      expect((await stranger.agent.get(`/api/projects/${strangers}`)).status).toBe(200);
      // The deleted run is gone from every view.
      expect((await owner.agent.get(`/api/projects/${projectId}`)).status).toBe(404);
      expect((await owner.agent.get(`/api/runs/${seeded.runId}`)).status).toBe(404);
      // Idempotent from the client's view: the second call finds nothing.
      const again = await deleteProjectRequest(projectId);
      expect([again.status, errorOf(again).error]).toEqual([404, 'not_found']);
    },
    300_000,
  );

  it('answers 404 for another user’s or an unknown project, and guards like every write', async () => {
    const projectId = await createProject();
    expect((await uploadPhoto(projectId, 3)).status).toBe(201);
    const files = await filesOf(projectId);

    const foreign = await deleteProjectRequest(projectId, stranger);
    expect([foreign.status, errorOf(foreign).error]).toEqual([404, 'not_found']);
    const unknown = await deleteProjectRequest(randomUUID());
    expect([unknown.status, errorOf(unknown).error]).toEqual([404, 'not_found']);
    const malformed = await deleteProjectRequest('not-a-uuid');
    expect([malformed.status, errorOf(malformed).error]).toEqual([400, 'validation_failed']);
    const anonymous = await request(app).delete(`/api/projects/${projectId}`);
    expect([anonymous.status, errorOf(anonymous).error]).toEqual([401, 'unauthenticated']);
    const crossSite = await owner.agent
      .delete(`/api/projects/${projectId}`)
      .set('Origin', 'https://evil.example');
    expect([crossSite.status, errorOf(crossSite).error]).toEqual([403, 'forbidden_origin']);
    const formBody = await owner.agent
      .delete(`/api/projects/${projectId}`)
      .type('form')
      .send('confirm=1');
    expect([formBody.status, errorOf(formBody).error]).toEqual([415, 'unsupported_media_type']);

    expect((await owner.agent.get(`/api/projects/${projectId}`)).status).toBe(200);
    expect(await filesOf(projectId)).toEqual(files);
    expect(deleted204(await deleteProjectRequest(projectId))).toBe(true);
  });

  it('refuses with 409 run_in_progress while a run is queued or running, and keeps everything', async () => {
    for (const status of ['queued', 'running'] as const) {
      const projectId = await createProject();
      expect((await uploadPhoto(projectId, 4)).status).toBe(201);
      const run = await fabricatedRun(projectId, status);
      const ids = await idsOf(projectId);
      const before = await rowsReferring(projectId, ids.runIds, ids.artifactIds);
      const files = await filesOf(projectId);

      const response = await deleteProjectRequest(projectId);
      expect([response.status, errorOf(response).error], status).toEqual([409, 'run_in_progress']);
      expect(await rowsReferring(projectId, ids.runIds, ids.artifactIds)).toEqual(before);
      expect(await filesOf(projectId)).toEqual(files);
      expect((await getRun(testDb.db, run.id))?.status).toBe(status);
    }
  });

  it('refuses while a step attempt is still open, whatever the run status says', async () => {
    const projectId = await createProject();
    const run = await fabricatedRun(projectId, 'awaiting_gate');
    await createRunStep(testDb.db, {
      runId: run.id,
      stepId: 'export',
      attempt: 1,
      jobId: randomUUID(),
    });
    const response = await deleteProjectRequest(projectId);
    expect([response.status, errorOf(response).error]).toEqual([409, 'run_in_progress']);
  });

  it('deletes a project whose run waits at a gate, completed, or failed, with its pending jobs', async () => {
    const projectId = await createProject();
    expect((await uploadPhoto(projectId, 5)).status).toBe(201);
    const gated = await fabricatedRun(projectId, 'awaiting_gate');
    const completed = await fabricatedRun(projectId, 'completed');
    const failed = await fabricatedRun(projectId, 'failed');
    // A gate-waiting run has no job of its own (`advance` opens the gate instead of enqueueing).
    expect(await jobsOf(gated.id)).toEqual([]);
    // Strays a worker has not fetched: a step job and a dead-lettered one.
    const later = { startAfter: new Date(Date.now() + 3_600_000) };
    expect(
      await boss.send(
        RUN_STEP_QUEUE,
        { runId: gated.id, stepId: 'export', attempt: 1 },
        { ...later, singletonKey: `${gated.id}:export:1` },
      ),
    ).not.toBeNull();
    expect(
      await boss.send(
        RUN_STEP_DEAD_LETTER_QUEUE,
        { runId: failed.id, stepId: 'intake', attempt: 1 },
        later,
      ),
    ).not.toBeNull();
    const ids = await idsOf(projectId);
    const before = await rowsReferring(projectId, ids.runIds, ids.artifactIds);

    expect(deleted204(await deleteProjectRequest(projectId))).toBe(true);

    expect(await rowsReferring(projectId, ids.runIds, ids.artifactIds)).toEqual(allZero(before));
    for (const run of [gated, completed, failed]) expect(await jobsOf(run.id)).toEqual([]);
    expect(await filesOf(projectId)).toEqual([]);
  });

  it('answers 204 when files cannot be deleted, logs their keys, and leaves them to the operator sweep', async () => {
    const captured = capturingLogger();
    const broken: Storage = {
      ...storage,
      delete: () => Promise.reject(new Error('disk gone')),
      deletePrefix: () => Promise.reject(new Error('disk gone')),
    };
    const brokenApp = buildApp({ storage: broken, logger: captured.logger });
    const agent = await loginOn(brokenApp, owner);
    const projectId = await createProject();
    expect((await uploadPhoto(projectId, 6)).status).toBe(201);
    const { storageKeys } = await idsOf(projectId);
    expect(storageKeys).toHaveLength(1);

    const response = await agent.delete(`/api/projects/${projectId}`);
    expect(response.status).toBe(204);
    expect((await owner.agent.get(`/api/projects/${projectId}`)).status).toBe(404);
    const log = captured.output();
    expect(log).toContain('could not delete a file of a deleted project');
    expect(log).toContain(String(storageKeys[0]));
    expect(log).toContain('could not remove the files of a deleted project');
    // The leftover is an orphan now ...
    expect(await filesOf(projectId)).toHaveLength(1);

    // ... which another deletion does not touch (it removes only its own prefix) ...
    const next = await createProject();
    expect(deleted204(await deleteProjectRequest(next))).toBe(true);
    expect(await filesOf(projectId)).toHaveLength(1);
    expect(await storage.exists(STORAGE_BINDING_KEY)).toBe(false);

    // ... and the operator's sweep (`npm run storage:sweep -- --delete --bind`) removes.
    const swept = await sweepOrphanedProjectFiles(
      { db: testDb.db, storage, logger },
      { limit: 100, bind: true, minAgeMs: 0 },
    );
    expect(swept).toMatchObject({ status: 'swept', removedProjectIds: [projectId] });
    expect(await projectDirExists(projectId)).toBe(false);
  });

  it('deletes by the stored ID when the path names the project in upper case', async () => {
    const projectId = await createProject();
    expect((await uploadPhoto(projectId, 8)).status).toBe(201);
    expect(await filesOf(projectId)).toHaveLength(1);

    // `z.uuid()` accepts upper case and PostgreSQL matches it; storage keys are lower case.
    const response = await deleteProjectRequest(projectId.toUpperCase());

    expect(deleted204(response)).toBe(true);
    expect(await filesOf(projectId)).toEqual([]);
    expect(await projectDirExists(projectId)).toBe(false);
    expect((await owner.agent.get(`/api/projects/${projectId}`)).status).toBe(404);
  });

  it('leaves a job a worker holds alone, and the worker settles it quietly afterwards', async () => {
    const projectId = await createProject();
    const gated = await fabricatedRun(projectId, 'awaiting_gate');
    const failed = await fabricatedRun(projectId, 'failed');
    // Jobs a worker already fetched (e.g. a stale delivery), inserted as pg-boss stores them.
    const held = [
      { runId: gated.id, stepId: 'export', attempt: 1, jobId: randomUUID() },
      { runId: failed.id, stepId: 'intake', attempt: 1, jobId: randomUUID() },
    ];
    for (const job of held) {
      const data = JSON.stringify({ runId: job.runId, stepId: job.stepId, attempt: job.attempt });
      await testDb.db.execute(sql`
        insert into pgboss.job (id, name, data, state, started_on, singleton_key)
        values (${job.jobId}, ${RUN_STEP_QUEUE}, ${data}::jsonb, 'active', now(),
          ${`${job.runId}:${job.stepId}:${job.attempt}`})
      `);
    }

    expect(deleted204(await deleteProjectRequest(projectId))).toBe(true);

    for (const job of held) {
      expect(await jobsOf(job.runId)).toEqual([{ name: RUN_STEP_QUEUE, state: 'active' }]);
      const outcome = await engine.processStepJob({
        id: job.jobId,
        retryCount: 0,
        data: { runId: job.runId, stepId: job.stepId, attempt: job.attempt },
        signal: new AbortController().signal,
      });
      expect(outcome).toEqual({ outcome: 'skipped', reason: 'run_missing' });
    }
    await testDb.db.execute(sql`
      delete from pgboss.job where id::text = any(${uuidArray(held.map((job) => job.jobId))}::text[])
    `);
  });
});

describe('races with deletion', () => {
  it('an upload that waited for the lock behind a deletion stores nothing and answers 404', async () => {
    const projectId = await createProject();
    const blocker = holdTransaction((tx) => lockProject(tx, projectId));
    await blocker.ready;
    const deletion = deleteProjectRequest(projectId).then((r) => r);
    await untilLockWaiters(1);
    // The upload passes its early ownership check, stores its file, then waits at the commit.
    const upload = uploadPhoto(projectId, 7).then((r) => r);
    await untilLockWaiters(2);
    blocker.release();
    await blocker.done;

    expect(deleted204(await deletion)).toBe(true);
    const uploaded = await upload;
    expect([uploaded.status, errorOf(uploaded).error]).toEqual([404, 'not_found']);
    const materials = await testDb.db.execute(
      sql`select id from materials where project_id = ${projectId}`,
    );
    expect(materials.rows).toEqual([]);
    expect(await filesOf(projectId)).toEqual([]);
  });

  it('a run start that waited behind a deletion answers 404 and creates no run', async () => {
    const projectId = await createProject();
    const blocker = holdTransaction((tx) => lockProject(tx, projectId));
    await blocker.ready;
    const deletion = deleteProjectRequest(projectId).then((r) => r);
    await untilLockWaiters(1);
    const start = owner.agent
      .post(`/api/projects/${projectId}/runs`)
      .send({})
      .then((r) => r);
    await untilLockWaiters(2);
    blocker.release();
    await blocker.done;

    expect(deleted204(await deletion)).toBe(true);
    const started = await start;
    expect([started.status, errorOf(started).error]).toEqual([404, 'not_found']);
    const runs = await testDb.db.execute(sql`select id from runs where project_id = ${projectId}`);
    expect(runs.rows).toEqual([]);
  });

  it('a gate decision that resumed the run first makes the waiting deletion answer 409', async () => {
    const projectId = await createProject();
    const run = await fabricatedRun(projectId, 'awaiting_gate');
    // What a gate decision does: lock the run, then resume it (`awaiting_gate → running`).
    const decision = holdTransaction(async (tx) => {
      await lockRun(tx, run.id);
      await transitionRun(tx, run.id, { to: 'running' });
    });
    await decision.ready;
    const deletion = deleteProjectRequest(projectId).then((r) => r);
    await untilLockWaiters(1);
    decision.release();
    await decision.done;

    const response = await deletion;
    expect([response.status, errorOf(response).error]).toEqual([409, 'run_in_progress']);
    expect((await getRun(testDb.db, run.id))?.status).toBe('running');
  });

  it('a gate decision that waited behind a deletion finds no run and answers 404', async () => {
    const projectId = await createProject();
    expect((await uploadPhoto(projectId, 9)).status).toBe(201);
    const run = await fabricatedRun(projectId, 'awaiting_gate');
    // Holds the deletion after it locked the project and its runs: its cascade has to delete
    // this material row, which the blocker keeps locked.
    const blocker = holdTransaction(async (tx) => {
      await tx.execute(sql`select id from materials where project_id = ${projectId} for update`);
    });
    await blocker.ready;
    const deletion = deleteProjectRequest(projectId).then((r) => r);
    await untilLockWaiters(1);
    // The decision passes its ownership check, then waits for the run lock the deletion holds.
    const decision = owner.agent
      .put(`/api/runs/${run.id}/gates/fact-conflicts/conflicts/K01/decision`)
      .send({ choice: 'reject' })
      .then((r) => r);
    await untilLockWaiters(2);
    blocker.release();
    await blocker.done;

    expect(deleted204(await deletion)).toBe(true);
    const decided = await decision;
    // Without the race this run (no conflicts artifact) would be a 500; 404 is `run_not_found`.
    expect([decided.status, errorOf(decided).error]).toEqual([404, 'not_found']);
    const decisions = await testDb.db.execute(
      sql`select id from decisions where run_id = ${run.id}`,
    );
    expect(decisions.rows).toEqual([]);
    expect(await jobsOf(run.id)).toEqual([]);
  });
});

function deleted204(response: request.Response): boolean {
  expect(response.status).toBe(204);
  return response.status === 204;
}
