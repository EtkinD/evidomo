import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RUN_STREAM_END_EVENT,
  TRANSCRIPT_ARTIFACT_KIND,
  apiErrorSchema,
  demoArtifactFileUrl,
  demoClaimAuditGateResponseSchema,
  demoClaimAuditGateUrl,
  demoExportUrl,
  demoFactConflictsGateUrl,
  demoFactMaskUrl,
  demoMaterialFileUrl,
  demoRunEventsUrl,
  demoRunExportResponseSchema,
  demoRunListResponseSchema,
  demoRunsUrl,
  demoRunUrl,
  demoTranscriptAudioUrl,
  factConflictsGateResponseSchema,
  runSnapshotSchema,
  runStreamEventSchema,
  runStreamEndSchema,
} from '@evidomo/shared';
import { sql } from 'drizzle-orm';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appConfigFromEnv, createApp, type AppDemoDeps } from '../app.ts';
import { verifyPassword } from '../auth/password.ts';
import { listArtifacts } from '../db/repositories/artifacts.ts';
import { listFacts } from '../db/repositories/facts.ts';
import { listMaterials } from '../db/repositories/materials.ts';
import { listRunEvents } from '../db/repositories/run-events.ts';
import { getRun, transitionRun, type Run } from '../db/repositories/runs.ts';
import { getUserByEmail } from '../db/repositories/users.ts';
import { usageLedger } from '../db/schema.ts';
import { checkBudget } from '../usage/budget.ts';
import {
  seedProject,
  seedRun,
  seedUser,
  startTestDatabase,
  type TestDatabase,
} from '../db/testing.ts';
import { loadDefinitions, type DefinitionRegistry } from '../definitions/loader.ts';
import { loadEnv } from '../env.ts';
import { unusedRunDeps } from '../http/testing.ts';
import { createLogger } from '../logger.ts';
import { openSse } from '../run-api/testing.ts';
import { createLocalStorage } from '../storage/local.ts';
import type { Storage } from '../storage/storage.ts';
import { DEMO_OWNER_EMAIL } from './owner.ts';
import { DEMO_SEED_BOSS_SCHEMA_PREFIX, seedDemoRun, type DemoSeedResult } from '../cli/seed.ts';

// P4-09 end to end: `seedDemoRun` puts the committed synthetic walkthrough through the real
// pipeline in fixture mode into a migrated PostgreSQL (Testcontainers, standing in for
// `DATABASE_URL`) and a storage root, twice (the rerun reuses the demo owner); then the public
// demo API serves the first run without a session: snapshot, both gates as decided, evidence
// files, export, and the replay stream, while the second (not listed) and a run that did not
// complete answer 404. Replay cannot reach the network: an unrecorded Meta request fails the run
// and is listed. Needs Docker and ffmpeg.

const DEMO_PROJECT = path.resolve(
  import.meta.dirname,
  '../../../../fixtures/projects/synthetic-walkthrough',
);
const logger = createLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' });
const APP_ORIGIN = 'http://localhost:3000';

let testDb: TestDatabase;
let storage: Storage;
let storageDir: string;
let definitions: DefinitionRegistry;
let first: DemoSeedResult;
let second: DemoSeedResult;
let unfinished: Run;
let customerCompleted: Run;
let app: Express;
const missingRunId = randomUUID();
const LIVE_DAILY_CAP = '0.01';
const LIVE_SPEND_TODAY = '0.00500000';

function buildApp(demo: AppDemoDeps, options: { runCostsVisible?: boolean } = {}): Express {
  const env = loadEnv({
    DATABASE_URL: testDb.container.getConnectionUri(),
    NODE_ENV: 'test',
    APP_ORIGIN,
    ...(options.runCostsVisible === false ? { RUN_COSTS_VISIBLE: 'false' } : {}),
  });
  return createApp({
    db: testDb.client,
    logger,
    config: appConfigFromEnv(env),
    // The demo never resumes or starts anything: an engine call would fail the test.
    runs: { ...unusedRunDeps(), markets: definitions, services: definitions },
    storage,
    projects: { definitions, dailyCapUsd: '5.00' },
    demo,
  });
}

function seed(): Promise<DemoSeedResult> {
  return seedDemoRun({
    projectDir: DEMO_PROJECT,
    db: testDb.db,
    connectionString: testDb.container.getConnectionUri(),
    storage,
    // Near zero: replayed demo usage must not count against the live budget (docs §10).
    dailyCapUsd: LIVE_DAILY_CAP,
    logger,
    progress: () => undefined,
  });
}

/** Rows of every table a run writes; the demo API must leave all of them unchanged. */
async function writeCounts(): Promise<Record<string, number>> {
  const result = await testDb.db.execute<Record<string, string>>(sql`
    select
      (select count(*) from run_events)::text as run_events,
      (select count(*) from runs)::text as runs,
      (select count(*) from run_steps)::text as run_steps,
      (select count(*) from facts)::text as facts,
      (select count(*) from artifacts)::text as artifacts,
      (select count(*) from decisions)::text as decisions,
      (select count(*) from usage_ledger)::text as usage_ledger,
      (select count(*) from sessions)::text as sessions,
      (select extract(epoch from max(updated_at)) from runs)::text as runs_updated
  `);
  const row = result.rows[0] ?? {};
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

function binary(test: request.Test): request.Test {
  return test.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => {
      done(null, Buffer.concat(chunks));
    });
  });
}

function expectNotFound(response: request.Response): void {
  expect(response.status).toBe(404);
  expect(apiErrorSchema.parse(response.body).error).toBe('not_found');
  expect(response.headers['cache-control']).toBe('no-store');
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-demo-storage-'));
  storage = createLocalStorage({ rootDir: storageDir });
  definitions = await loadDefinitions();
  // Today's live spend, below the cap: the seeds' replayed usage must not add to it.
  await testDb.db.insert(usageLedger).values({
    modelId: 'muse-spark-1.3',
    estimatedCostUsd: LIVE_SPEND_TODAY,
    latencyMs: 1,
  });
  first = await seed();
  second = await seed();
  const someone = await seedUser(testDb.db);
  const project = await seedProject(testDb.db, someone.id);
  unfinished = await seedRun(testDb.db, project.id);
  await transitionRun(testDb.db, unfinished.id, { to: 'running' });
  // A real customer's completed run: listing it by mistake must not publish it.
  customerCompleted = await seedRun(testDb.db, project.id);
  await transitionRun(testDb.db, customerCompleted.id, { to: 'running' });
  await transitionRun(testDb.db, customerCompleted.id, { to: 'completed' });
  app = buildApp({
    runIds: [first.runId, unfinished.id, missingRunId, customerCompleted.id],
  });
}, 600_000);

afterAll(async () => {
  await testDb?.stop();
  if (storageDir !== undefined) await rm(storageDir, { recursive: true, force: true });
});

describe('npm run demo:seed (fixture mode against a configured database)', () => {
  it('completes the run with zero live requests, every call answered from the cassette', async () => {
    for (const result of [first, second]) {
      expect(result.liveRequests).toBe(0);
      expect(result.calls).toBeGreaterThan(0);
      expect(result.servedFromCassette).toBe(result.calls);
      expect((await getRun(testDb.db, result.runId))?.status).toBe('completed');
    }
    expect(Number(first.costUsd)).toBeGreaterThan(0);
  });

  it('does not use up the live daily budget, even with a cap near zero', async () => {
    // Both seeds completed under a 0.01 USD cap while each replayed ~0.45 USD of usage.
    expect(Number(first.costUsd)).toBeGreaterThan(Number(LIVE_DAILY_CAP));
    const status = await checkBudget(testDb.db, { dailyCapUsd: LIVE_DAILY_CAP, now: new Date() });
    expect(status.dailySpentUsd).toBe(LIVE_SPEND_TODAY);
  });

  it('is rerunnable: one demo owner that can never log in, a new run each time', async () => {
    expect(first.ownerCreated).toBe(true);
    expect(second.ownerCreated).toBe(false);
    expect(second.runId).not.toBe(first.runId);
    const owner = await getUserByEmail(testDb.db, DEMO_OWNER_EMAIL);
    if (owner === undefined) throw new Error('no demo owner');
    expect(owner.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(owner.passwordHash, '')).toBe(false);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: DEMO_OWNER_EMAIL, password: 'not the random password' });
    expect(login.status).toBe(401);
  });

  it('keeps its jobs in a schema of its own and drops it, never the default pg-boss schema', async () => {
    const schemas = await testDb.db.execute<{ name: string }>(sql`
      select schema_name as name from information_schema.schemata
      where schema_name like 'pgboss%'
    `);
    // No worker of the deployment could have seen a seed job: `pgboss` was never even created.
    expect(schemas.rows.map((row) => row.name)).toEqual([]);
    expect(DEMO_SEED_BOSS_SCHEMA_PREFIX).toBe('pgboss_demo_seed_');
  });
});

describe('demo API', () => {
  it('lists the listed runs that completed, without owner data', async () => {
    const response = await request(app).get(demoRunsUrl());
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    const body = demoRunListResponseSchema.parse(response.body);
    expect(body.runs.map((run) => run.id)).toEqual([first.runId]);
    expect(body.runs[0]).toMatchObject({ marketProfileId: 'nl', title: first.projectTitle });
  });

  it('serves the snapshot of a listed completed run only, without a session', async () => {
    const response = await request(app).get(demoRunUrl(first.runId));
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    const snapshot = runSnapshotSchema.parse(response.body);
    expect(snapshot).toMatchObject({
      id: first.runId,
      status: 'completed',
      costUsd: first.costUsd,
    });
    expect(snapshot.steps.every((step) => step.status === 'completed')).toBe(true);
    expect(snapshot.export?.manifestArtifactId).toBeDefined();

    // Not listed (completed, a real run), listed but not completed, listed but missing.
    for (const runId of [second.runId, unfinished.id, missingRunId, customerCompleted.id]) {
      expectNotFound(await request(app).get(demoRunUrl(runId)));
      expectNotFound(await request(app).get(demoFactConflictsGateUrl(runId)));
      expectNotFound(await request(app).get(demoExportUrl(runId)));
    }
    expect((await request(app).get('/api/demo/runs/not-a-uuid')).status).toBe(400);
    // The customer's run is completed and listed, but not the demo owner's: never served.
    expect((await getRun(testDb.db, customerCompleted.id))?.status).toBe('completed');
    // The owner API still needs a session for the same run.
    expect((await request(app).get(`/api/runs/${first.runId}`)).status).toBe(401);
  });

  it('serves both gates as they were decided, with no user ID anywhere', async () => {
    const gate1 = await request(app).get(demoFactConflictsGateUrl(first.runId));
    expect(gate1.status).toBe(200);
    expect(gate1.headers['cache-control']).toBe('public, max-age=60');
    const factConflicts = factConflictsGateResponseSchema.parse(gate1.body);
    expect(factConflicts.state).toBe('released');
    expect(factConflicts.conflicts.map((c) => c.key)).toEqual([
      'build_year',
      'other:bedroom_floor',
      'vve_monthly_contribution',
    ]);
    expect(factConflicts.conflicts.every((c) => c.decision !== null)).toBe(true);

    const gate2 = await request(app).get(demoClaimAuditGateUrl(first.runId));
    expect(gate2.status).toBe(200);
    const claimAudit = demoClaimAuditGateResponseSchema.parse(gate2.body);
    expect(claimAudit.state).toBe('released');
    expect(Object.keys(claimAudit.approval ?? {})).toEqual(['decidedAt']);
    expect(claimAudit.images).toHaveLength(1);

    const owner = await getUserByEmail(testDb.db, DEMO_OWNER_EMAIL);
    if (owner === undefined) throw new Error('no demo owner');
    const list = await request(app).get(demoRunsUrl());
    const snapshot = await request(app).get(demoRunUrl(first.runId));
    const exported = await request(app).get(demoExportUrl(first.runId));
    for (const response of [gate1, gate2, list, snapshot, exported]) {
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(owner.id);
      expect(text).not.toContain(DEMO_OWNER_EMAIL);
      expect(text).not.toMatch(/decidedBy|approvedBy|ownerId|email/);
    }
  });

  it('serves the evidence files with public cache headers, and none of another run', async () => {
    const run = await getRun(testDb.db, first.runId);
    if (run === undefined) throw new Error('no run');
    const [photo] = await listMaterials(testDb.db, run.projectId, { kind: 'photo' });
    if (photo === undefined) throw new Error('no photo');
    const photoResponse = await binary(request(app).get(demoMaterialFileUrl(run.id, photo.id)));
    expect(photoResponse.status).toBe(200);
    expect(photoResponse.headers).toMatchObject({
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=3600, no-transform',
      etag: `"${photo.sha256}"`,
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    });
    const revalidated = await request(app)
      .get(demoMaterialFileUrl(run.id, photo.id))
      .set('If-None-Match', `"${photo.sha256}"`);
    expect([revalidated.status, revalidated.headers['cache-control']]).toEqual([
      304,
      'public, max-age=3600, no-transform',
    ]);
    // The same material through a listed run that is not its own, and through a non-listed run.
    expectNotFound(await request(app).get(demoMaterialFileUrl(second.runId, photo.id)));

    const [transcript] = await listArtifacts(testDb.db, run.id, { kind: TRANSCRIPT_ARTIFACT_KIND });
    if (transcript === undefined) throw new Error('no transcript');
    const audio = await binary(
      request(app).get(demoTranscriptAudioUrl(run.id, transcript.id)).set('Range', 'bytes=0-3'),
    );
    expect(audio.status).toBe(206);
    expect(audio.headers['content-type']).toBe('audio/wav');
    const beyond = await request(app)
      .get(demoTranscriptAudioUrl(run.id, transcript.id))
      .set('Range', 'bytes=999999999-');
    expect([beyond.status, beyond.headers['cache-control']]).toEqual([416, 'no-store']);
    expect(apiErrorSchema.parse(beyond.body).error).toBe('range_not_satisfiable');
    expect(Buffer.isBuffer(audio.body) && audio.body.toString('latin1')).toBe('RIFF');

    const claimAudit = demoClaimAuditGateResponseSchema.parse(
      (await request(app).get(demoClaimAuditGateUrl(run.id))).body,
    );
    const staged = claimAudit.images[0];
    if (staged === undefined) throw new Error('no staged image');
    const stagedResponse = await request(app).get(demoArtifactFileUrl(run.id, staged.artifactId));
    expect(stagedResponse.status).toBe(200);
    expect(stagedResponse.headers['content-type']).toBe('image/jpeg');

    const masked = (await listFacts(testDb.db, run.id)).filter(
      (fact) => fact.source.kind === 'photo_region' && fact.source.maskArtifactId !== undefined,
    );
    expect(masked.length).toBeGreaterThan(0);
    const statuses: number[] = [];
    for (const fact of masked.slice(0, 5)) {
      const mask = await request(app).get(demoFactMaskUrl(run.id, fact.id));
      statuses.push(mask.status);
      if (mask.status === 200) {
        expect(mask.headers['content-type']).toBe('image/png');
        expect(mask.headers['cache-control']).toBe('public, max-age=3600');
      }
    }
    expect(statuses).toContain(200);
  });

  it('serves the export with demo links and the pack CSP', async () => {
    const response = await request(app).get(demoExportUrl(first.runId));
    expect(response.status).toBe(200);
    const body = demoRunExportResponseSchema.parse(response.body);
    expect(body.files.every((file) => file.url.startsWith(`/api/demo/runs/${first.runId}/`))).toBe(
      true,
    );
    const html = body.files.find((file) => file.role === 'html');
    const json = body.files.find((file) => file.role === 'portal_fields');
    if (html === undefined || json === undefined) throw new Error('incomplete export');
    const page = await request(app).get(html.url);
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['cache-control']).toBe('public, max-age=3600');
    expect(page.text).toContain('Virtually staged');
    const fields = await request(app).get(json.url);
    expect(fields.headers['content-disposition']).toBe('attachment; filename="portal-fields.json"');
  });

  it('cannot change anything: no other methods, and the database is untouched', async () => {
    const before = await writeCounts();
    const claimAudit = demoClaimAuditGateResponseSchema.parse(
      (await request(app).get(demoClaimAuditGateUrl(first.runId))).body,
    );
    const imageId = claimAudit.images[0]?.artifactId ?? randomUUID();
    const base = `/api/demo/runs/${first.runId}`;
    const attempts = [
      request(app).post(`${base}/gates/claim-audit/approve`).send({}),
      request(app)
        .put(`${base}/gates/claim-audit/images/${imageId}/decision`)
        .send({ choice: 'reject' }),
      request(app)
        .put(`${base}/gates/fact-conflicts/conflicts/K01/decision`)
        .send({ choice: 'reject' }),
      request(app).post(`${base}/events`).send({}),
      request(app).delete(base),
      request(app).patch(base).send({}),
      request(app).post(demoRunsUrl()).send({}),
    ];
    for (const attempt of attempts) expect((await attempt).status).toBe(404);
    const crossSite = await request(app)
      .post(`${base}/gates/claim-audit/approve`)
      .set('Origin', 'https://evil.example')
      .send({});
    expect(crossSite.status).toBe(403);

    // A whole walk-through reads only.
    await request(app).get(demoRunsUrl());
    await request(app).get(demoRunUrl(first.runId));
    await request(app).get(demoFactConflictsGateUrl(first.runId));
    await request(app).get(demoExportUrl(first.runId));
    expect(await writeCounts()).toEqual(before);
  });

  it('limits demo requests per client IP', async () => {
    const limited = buildApp({
      runIds: [first.runId],
      requestLimit: { limit: 2, windowMs: 60_000 },
    });
    expect((await request(limited).get(demoRunUrl(first.runId))).status).toBe(200);
    expect((await request(limited).get(demoRunsUrl())).status).toBe(200);
    const refused = await request(limited).get(demoRunUrl(first.runId));
    expect(refused.status).toBe(429);
    expect(apiErrorSchema.parse(refused.body).error).toBe('rate_limited');
    expect(refused.headers['retry-after']).toBe('60');
    expect(refused.headers['cache-control']).toBe('no-store');
  });
});

describe('demo replay stream', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Gaps compressed to at most 2 ms so the whole run replays in well under a second.
    const replayApp = buildApp({ runIds: [first.runId], replay: { maxGapMs: 2 } });
    server = replayApp.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const dataOf = (text: string | undefined) => runStreamEventSchema.parse(JSON.parse(text ?? ''));

  it('replays every stored event of the run as stored, then sends end, without writing', async () => {
    const before = await writeCounts();
    const stored = await listRunEvents(testDb.db, first.runId);
    const stream = await openSse(`${baseUrl}${demoRunEventsUrl(first.runId, { speed: 10 })}`);
    expect(stream.status).toBe(200);
    await stream.closed(20_000);
    const messages = stream.messages().filter((m) => m.data !== undefined && m.event === undefined);
    expect(messages.map((m) => m.id)).toEqual(stored.map((e) => String(e.seq)));
    expect(messages.map((m) => dataOf(m.data).occurredAt)).toEqual(
      stored.map((e) => e.occurredAt.toISOString()),
    );
    const end = stream.messages().at(-1);
    expect(end?.event).toBe(RUN_STREAM_END_EVENT);
    expect(runStreamEndSchema.parse(JSON.parse(end?.data ?? ''))).toEqual({
      status: 'completed',
      lastEventSeq: stored.length,
    });
    expect(await writeCounts()).toEqual(before);
  });

  it('resumes after Last-Event-ID, which wins over ?after=', async () => {
    const stored = await listRunEvents(testDb.db, first.runId);
    const resumeAt = stored.length - 3;
    const stream = await openSse(`${baseUrl}${demoRunEventsUrl(first.runId, { after: 1 })}`, {
      'Last-Event-ID': String(resumeAt),
    });
    await stream.closed(20_000);
    const ids = stream
      .messages()
      .filter((m) => m.data !== undefined && m.event === undefined)
      .map((m) => Number(m.id));
    expect(ids).toEqual([resumeAt + 1, resumeAt + 2, resumeAt + 3]);
  });

  it('refuses a stream for a run that is not public and an invalid speed or cursor', async () => {
    for (const runId of [second.runId, unfinished.id, customerCompleted.id]) {
      const response = await fetch(`${baseUrl}${demoRunEventsUrl(runId)}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    }
    for (const query of ['speed=0', 'speed=11', 'speed=fast', 'after=-1']) {
      const response = await fetch(`${baseUrl}/api/demo/runs/${first.runId}/events?${query}`);
      expect(response.status, query).toBe(400);
    }
    const badHeader = await fetch(`${baseUrl}${demoRunEventsUrl(first.runId)}`, {
      headers: { 'Last-Event-ID': 'abc' },
    });
    expect(badHeader.status).toBe(400);
  });
});

describe('demo API with run costs hidden (the production default)', () => {
  let server: Server;
  let baseUrl: string;
  let hiddenApp: Express;

  beforeAll(async () => {
    hiddenApp = buildApp(
      { runIds: [first.runId], replay: { maxGapMs: 2 } },
      { runCostsVisible: false },
    );
    server = hiddenApp.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves the snapshot without any cost key', async () => {
    const response = await request(hiddenApp).get(demoRunUrl(first.runId));
    expect(response.status).toBe(200);
    const snapshot = runSnapshotSchema.parse(response.body);
    expect(snapshot.id).toBe(first.runId);
    expect(JSON.stringify(response.body)).not.toMatch(/costUsd|costCapUsd/i);
    // The ledger still holds the replayed usage the visible snapshot reports.
    expect(Number(first.costUsd)).toBeGreaterThan(0);
  });

  it('replays every seq with usage_recorded as withheld and no cost values', async () => {
    const stored = await listRunEvents(testDb.db, first.runId);
    expect(stored.some((e) => e.type === 'usage_recorded')).toBe(true);
    const stream = await openSse(`${baseUrl}${demoRunEventsUrl(first.runId, { speed: 10 })}`);
    await stream.closed(20_000);
    const messages = stream.messages().filter((m) => m.data !== undefined && m.event === undefined);
    const received = messages.map((m) => runStreamEventSchema.parse(JSON.parse(m.data ?? '')));
    expect(messages.map((m) => m.id)).toEqual(stored.map((e) => String(e.seq)));
    expect(received.map((e) => e.type)).toEqual(
      stored.map((e) => (e.type === 'usage_recorded' ? 'withheld' : e.type)),
    );
    expect(stream.text()).not.toMatch(/usage_recorded|CostUsd|costUsd/);
  });
});
