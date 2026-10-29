import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EXPORT_HTML_ARTIFACT_KIND,
  EXPORT_IMAGE_ARTIFACT_KIND,
  EXPORT_MANIFEST_ARTIFACT_KIND,
  EXPORT_PORTAL_FIELDS_ARTIFACT_KIND,
  PHOTO_INVENTORY_ARTIFACT_KIND,
  RUN_STREAM_END_EVENT,
  RUN_STREAM_RESYNC_EVENT,
  STAGED_IMAGE_ARTIFACT_KIND,
  TRANSCRIPT_ARTIFACT_KIND,
  apiErrorSchema,
  authUserResponseSchema,
  exportFileContentSchema,
  exportManifestContentSchema,
  projectRunsResponseSchema,
  runExportResponseSchema,
  runFactMaskUrl,
  runSnapshotSchema,
  runStreamEndSchema,
  runStreamEventSchema,
  transcriptArtifactContentSchema,
  type ExportFileRole,
  type SamRegion,
} from '@evidomo/shared';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appConfigFromEnv, createApp } from '../app.ts';
import { insertArtifact, insertSingletonArtifact } from '../db/repositories/artifacts.ts';
import { insertFacts } from '../db/repositories/facts.ts';
import { addMaterial, setMaterialStatus } from '../db/repositories/materials.ts';
import { appendRunEvent } from '../db/repositories/run-events.ts';
import { claimRunStep, completeRunStep, createRunStep } from '../db/repositories/run-steps.ts';
import { transitionRun, type Run } from '../db/repositories/runs.ts';
import { recordUsage } from '../db/repositories/usage.ts';
import { seedProject, seedRun, startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { loadEnv } from '../env.ts';
import {
  FRAME,
  inventoryContent,
  inventoryEntry,
  recordedMaskRegion,
  sha256Hex,
  syntheticPhoto,
} from '../export/testing.ts';
import { unusedProjectDeps, unusedRunDeps } from '../http/testing.ts';
import { createLogger } from '../logger.ts';
import { encodePcm16Wav } from '../media/wav.ts';
import { decodeSamMask } from '../meta/sam-mask.ts';
import { buildTestService, testRegistry } from '../runs/testing.ts';
import { createLocalStorage } from '../storage/local.ts';
import {
  newMaterialStorageKey,
  newRunArtifactStorageKey,
  type Storage,
} from '../storage/storage.ts';
import { PACK_RESPONSE_CSP } from './routes.ts';
import { openSse, type SseConnection, type SseMessage } from './testing.ts';

// The run, evidence, and export routes over HTTP against PostgreSQL (Testcontainers) and local
// storage in a temp directory. Runs, steps, events, ledger rows, materials, artifacts, and an
// export are seeded through the repositories as the engine and the steps write them; nothing
// here calls a model.

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });
const PASSWORD = 'correct horse battery staple';
const service = buildTestService('run-api-test', [
  { id: 'intake', agent: 'intake' },
  { id: 'reconcile', agent: 'reconciler', gate_after: 'fact_conflicts' },
  { id: 'export', agent: 'exporter' },
]);

let testDb: TestDatabase;
let storage: Storage;
let storageDir: string;
let server: Server;
let baseUrl: string;

interface Operator {
  readonly id: string;
  readonly cookie: string;
}
let owner: Operator;
let stranger: Operator;

/** A seeded run of `owner` with every kind of evidence. */
interface Scenario {
  readonly run: Run;
  readonly photo: { readonly id: string; readonly bytes: Uint8Array };
  readonly memo: { readonly id: string; readonly bytes: Uint8Array };
  readonly transcriptId: string;
  readonly stagedId: string;
  readonly htmlArtifactId: string;
  readonly maskedFactId: string;
  readonly unmaskedFactId: string;
  readonly formFactId: string;
  readonly maskRegion: SamRegion;
}
let scenario: Scenario;

async function signUp(): Promise<Operator> {
  const response = await request(server)
    .post('/api/auth/register')
    .send({ email: `operator-${randomUUID()}@example.test`, password: PASSWORD });
  expect(response.status).toBe(201);
  const [setCookie] = response.get('set-cookie') ?? [];
  const cookie = setCookie?.split(';')[0];
  if (cookie === undefined) throw new Error('Registration set no cookie');
  return { id: authUserResponseSchema.parse(response.body).user.id, cookie };
}

function get(operator: Operator | undefined, url: string): request.Test {
  const test = request(server).get(url);
  return operator === undefined ? test : test.set('Cookie', operator.cookie);
}

/** Supertest buffers binary bodies only with a parser; this one keeps the raw bytes. */
function binary(test: request.Test): request.Test {
  return test.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => {
      done(null, Buffer.concat(chunks));
    });
  });
}

function bodyBytes(response: request.Response): Buffer {
  if (!Buffer.isBuffer(response.body)) throw new Error('Expected a binary body');
  return response.body;
}

function expectNotFound(response: request.Response): void {
  expect(response.status).toBe(404);
  expect(apiErrorSchema.parse(response.body).error).toBe('not_found');
}

async function storeMaterial(
  projectId: string,
  kind: 'photo' | 'voice_memo',
  bytes: Uint8Array,
): Promise<string> {
  const extension = kind === 'photo' ? 'jpg' : 'wav';
  const stored = await storage.put(newMaterialStorageKey(projectId, extension), bytes);
  const material = await addMaterial(testDb.db, {
    projectId,
    kind,
    storageKey: stored.key,
    mimeType: kind === 'photo' ? 'image/jpeg' : 'audio/wav',
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    status: 'processing',
  });
  await setMaterialStatus(testDb.db, material.id, 'ready');
  return material.id;
}

async function storeFileArtifact(
  run: Run,
  input: {
    kind: string;
    extension: string;
    mimeType: string;
    bytes: Uint8Array;
    content?: unknown;
  },
): Promise<string> {
  const stored = await storage.put(
    newRunArtifactStorageKey(run.projectId, run.id, input.extension),
    input.bytes,
  );
  const artifact = await insertArtifact(testDb.db, {
    runId: run.id,
    stepId: input.kind.startsWith('export') ? 'export' : 'stage',
    kind: input.kind,
    file: { storageKey: stored.key, mimeType: input.mimeType },
    ...(input.content === undefined
      ? {}
      : { content: exportFileContentSchema.parse(input.content) }),
  });
  return artifact.id;
}

function memoBytes(): Uint8Array {
  const samples = new Int16Array(16_000);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(8000 * Math.sin(i / 7));
  return encodePcm16Wav(samples, 16_000);
}

async function seedScenario(ownerId: string): Promise<Scenario> {
  const project = await seedProject(testDb.db, ownerId);
  const run = await seedRun(testDb.db, project.id, {
    serviceId: service.id,
    serviceVersion: service.version,
  });

  const photoBytes = await syntheticPhoto([200, 190, 170]);
  const photoId = await storeMaterial(project.id, 'photo', photoBytes);
  const memo = memoBytes();
  const memoId = await storeMaterial(project.id, 'voice_memo', memo);

  const { artifact: transcript } = await insertSingletonArtifact(testDb.db, {
    runId: run.id,
    stepId: 'intake',
    kind: TRANSCRIPT_ARTIFACT_KIND,
    content: transcriptArtifactContentSchema.parse({
      schemaVersion: 1,
      materialId: memoId,
      materialSha256: sha256Hex(memo),
      model: 'muse-voice-transcribe-1.0',
      mode: 'ENDPOINTING',
      sessionId: 'session-1',
      audioDurationMs: 1000,
      languageBias: ['en'],
      keywords: [],
      maxTurnMs: null,
      turns: [
        {
          index: 0,
          sourceTurnIndex: 0,
          speaker: null,
          text: 'The living room has a sofa.',
          startMs: 0,
          endMs: 900,
          timing: 'model',
        },
      ],
    }),
  });

  const maskRegion = await recordedMaskRegion(100, 120);
  const photoEntry = inventoryEntry({
    materialId: photoId,
    sha256: sha256Hex(photoBytes),
    subject: 'living_room',
    coverRank: 1,
    privacy: { status: 'clear' },
  });
  const observation = (key: string, regions: SamRegion[]) => ({
    key,
    object: 'other',
    label: key,
    detail: 'A synthetic object.',
    modelCount: 1,
    supports: [],
    evidence: {
      status: 'segmented' as const,
      phrase: key.slice('other:'.length),
      instanceCount: regions.length,
      regions,
      reason: null,
    },
    region: maskRegion.region,
    factStored: true,
  });
  const inventory = await insertArtifact(testDb.db, {
    runId: run.id,
    stepId: 'vision_inventory',
    kind: PHOTO_INVENTORY_ARTIFACT_KIND,
    content: inventoryContent([
      {
        ...photoEntry,
        observations: [
          observation('other:sofa', [maskRegion]),
          observation('other:lamp', [{ ...maskRegion, mask: null }]),
        ],
      },
    ]),
  });
  const [masked, unmasked, form] = await insertFacts(testDb.db, run.id, [
    {
      stepId: 'vision_inventory',
      key: 'other:sofa',
      value: 1,
      source: {
        kind: 'photo_region',
        materialId: photoId,
        region: maskRegion.region,
        maskArtifactId: inventory.id,
      },
    },
    {
      stepId: 'vision_inventory',
      key: 'other:lamp',
      value: 1,
      source: { kind: 'photo_region', materialId: photoId, region: maskRegion.region },
    },
    {
      stepId: 'extract',
      key: 'energy_label',
      value: 'A',
      source: { kind: 'form', field: 'energy_label' },
    },
  ]);
  if (masked === undefined || unmasked === undefined || form === undefined) {
    throw new Error('Facts were not stored');
  }

  const stagedId = await storeFileArtifact(run, {
    kind: STAGED_IMAGE_ARTIFACT_KIND,
    extension: 'jpg',
    mimeType: 'image/jpeg',
    bytes: await syntheticPhoto([120, 160, 200]),
  });
  // An HTML file artifact outside any export manifest: never served by the image route.
  const htmlArtifactId = await storeFileArtifact(run, {
    kind: 'debug_html',
    extension: 'html',
    mimeType: 'text/html',
    bytes: new TextEncoder().encode('<p>not evidence</p>'),
  });

  return {
    run,
    photo: { id: photoId, bytes: photoBytes },
    memo: { id: memoId, bytes: memo },
    transcriptId: transcript.id,
    stagedId,
    htmlArtifactId,
    maskedFactId: masked.id,
    unmaskedFactId: unmasked.id,
    formFactId: form.id,
    maskRegion,
  };
}

/** Moves a run through intake as the engine would: steps, events, and a ledger row. */
async function runIntake(run: Run, costUsd: string): Promise<void> {
  await transitionRun(testDb.db, run.id, { to: 'running', stepId: 'intake' });
  const key = { runId: run.id, stepId: 'intake', attempt: 1 };
  const jobId = randomUUID();
  await createRunStep(testDb.db, { ...key, jobId });
  await claimRunStep(testDb.db, key, { jobId, retryCount: 0 });
  await appendRunEvent(testDb.db, run.id, {
    type: 'step_started',
    payload: { stepId: 'intake', attempt: 1, execution: 1 },
  });
  await recordUsage(testDb.db, {
    runId: run.id,
    stepId: 'intake',
    modelId: 'muse-voice-transcribe-1.0',
    audioSeconds: '10',
    estimatedCostUsd: costUsd,
    latencyMs: 100,
  });
  await appendRunEvent(testDb.db, run.id, {
    type: 'usage_recorded',
    payload: { stepId: 'intake', stepCostUsd: costUsd, runCostUsd: costUsd },
  });
  await completeRunStep(testDb.db, key, []);
  await appendRunEvent(testDb.db, run.id, {
    type: 'step_completed',
    payload: {
      stepId: 'intake',
      attempt: 1,
      execution: 1,
      artifactIds: [],
      stepCostUsd: costUsd,
      runCostUsd: costUsd,
    },
  });
  const nextKey = { runId: run.id, stepId: 'reconcile', attempt: 1 };
  await createRunStep(testDb.db, { ...nextKey, jobId: randomUUID() });
}

const ROLE_KIND: Readonly<Record<ExportFileRole, string>> = {
  html: EXPORT_HTML_ARTIFACT_KIND,
  portal_fields: EXPORT_PORTAL_FIELDS_ARTIFACT_KIND,
  image: EXPORT_IMAGE_ARTIFACT_KIND,
};

const PACK_HTML = '<!doctype html><html lang="en"><body><h1>Synthetic pack</h1></body></html>';

/** Stores an export as the export step does: one artifact per file, then the manifest. */
async function storeExport(run: Run): Promise<{ manifestId: string; fileIds: string[] }> {
  const files: { role: ExportFileRole; fileName: string; mimeType: string; bytes: Uint8Array }[] = [
    {
      role: 'html',
      fileName: 'listing-pack.html',
      mimeType: 'text/html',
      bytes: new TextEncoder().encode(PACK_HTML),
    },
    {
      role: 'portal_fields',
      fileName: 'portal-fields.json',
      mimeType: 'application/json',
      bytes: new TextEncoder().encode('{"schemaVersion":2}\n'),
    },
    {
      role: 'image',
      fileName: 'photo-01.jpg',
      mimeType: 'image/jpeg',
      bytes: await syntheticPhoto([90, 90, 90]),
    },
  ];
  const entries = [];
  for (const file of files) {
    const meta = {
      schemaVersion: 1,
      role: file.role,
      fileName: file.fileName,
      sizeBytes: file.bytes.byteLength,
      sha256: sha256Hex(file.bytes),
    };
    const artifactId = await storeFileArtifact(run, {
      kind: ROLE_KIND[file.role],
      extension: file.fileName.split('.').at(-1) ?? 'bin',
      mimeType: file.mimeType,
      bytes: file.bytes,
      content: meta,
    });
    entries.push({
      artifactId,
      role: file.role,
      fileName: meta.fileName,
      mimeType: file.mimeType,
      sizeBytes: meta.sizeBytes,
      sha256: meta.sha256,
    });
  }
  const manifest = await insertArtifact(testDb.db, {
    runId: run.id,
    stepId: 'export',
    kind: EXPORT_MANIFEST_ARTIFACT_KIND,
    content: exportManifestContentSchema.parse({
      schemaVersion: 1,
      formatVersion: 1,
      approvedPackArtifactId: randomUUID(),
      inventoryArtifactId: randomUUID(),
      readyToPublish: false,
      files: entries,
      counts: {
        images: 1,
        originals: 1,
        staged: 0,
        blurredImages: 0,
        blurredRegions: 0,
        withheld: 0,
      },
    }),
  });
  return { manifestId: manifest.id, fileIds: entries.map((e) => e.artifactId) };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-run-api-'));
  storage = createLocalStorage({ rootDir: storageDir });
  const env = loadEnv({ DATABASE_URL: 'postgres://unused@localhost/unused', NODE_ENV: 'test' });
  const app = createApp({
    db: testDb.client,
    logger,
    config: appConfigFromEnv(env),
    runs: {
      ...unusedRunDeps(),
      services: testRegistry(service),
      eventStream: { pollIntervalMs: 25 },
    },
    storage,
    projects: unusedProjectDeps(),
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  owner = await signUp();
  stranger = await signUp();
  scenario = await seedScenario(owner.id);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb.stop();
  await rm(storageDir, { recursive: true, force: true });
});

describe('GET /api/runs/:runId', () => {
  it('returns the run with every definition step, costs, cap, and gate state', async () => {
    const { run } = await seedScenario(owner.id);
    const queued = runSnapshotSchema.parse((await get(owner, `/api/runs/${run.id}`)).body);
    expect(queued).toMatchObject({
      id: run.id,
      status: 'queued',
      gate: null,
      costUsd: '0.00000000',
      costCapUsd: '0.50',
      lastEventSeq: 0,
      maxExecutionsPerAttempt: 2,
      export: null,
    });
    expect(queued.steps.map((s) => [s.stepId, s.agent, s.gateAfter, s.status])).toEqual([
      ['intake', 'intake', null, 'pending'],
      ['reconcile', 'reconciler', 'fact_conflicts', 'pending'],
      ['export', 'exporter', null, 'pending'],
    ]);

    await runIntake(run, '0.00050000');
    const response = await get(owner, `/api/runs/${run.id}`);
    expect(response.status).toBe(200);
    expect(response.get('cache-control')).toBe('no-store');
    const snapshot = runSnapshotSchema.parse(response.body);
    expect(snapshot).toMatchObject({
      status: 'running',
      currentStepId: 'intake',
      costUsd: '0.00050000',
      lastEventSeq: 4,
    });
    expect(snapshot.startedAt).not.toBeNull();
    const [intake, reconcile, exporter] = snapshot.steps;
    expect(intake).toMatchObject({
      status: 'completed',
      attempt: 1,
      attempts: 1,
      executions: 1,
      totalExecutions: 1,
      costUsd: '0.00050000',
      error: null,
    });
    expect(intake?.finishedAt).not.toBeNull();
    expect(reconcile).toMatchObject({
      status: 'queued',
      attempt: 1,
      executions: 0,
      costUsd: '0.00000000',
    });
    expect(exporter).toMatchObject({ status: 'pending', attempt: null, attempts: 0 });

    await transitionRun(testDb.db, run.id, { to: 'awaiting_gate', gate: 'fact_conflicts' });
    expect(runSnapshotSchema.parse((await get(owner, `/api/runs/${run.id}`)).body).gate).toBe(
      'fact_conflicts',
    );
  });

  it('reports the export once its manifest is stored', async () => {
    const { run } = await seedScenario(owner.id);
    const { manifestId } = await storeExport(run);
    const snapshot = runSnapshotSchema.parse((await get(owner, `/api/runs/${run.id}`)).body);
    expect(snapshot.export).toEqual({
      manifestArtifactId: manifestId,
      readyToPublish: false,
      fileCount: 3,
    });
  });

  it('answers 404 for another user’s run and an unknown run, 401 without a session, 400 for a bad ID', async () => {
    expectNotFound(await get(stranger, `/api/runs/${scenario.run.id}`));
    expectNotFound(await get(owner, `/api/runs/${randomUUID()}`));
    expect((await get(undefined, `/api/runs/${scenario.run.id}`)).status).toBe(401);
    const bad = await get(owner, '/api/runs/not-a-uuid');
    expect(bad.status).toBe(400);
    expect(apiErrorSchema.parse(bad.body).error).toBe('validation_failed');
  });
});

describe('GET /api/projects/:projectId/runs', () => {
  it('lists the project’s runs newest first with their cost; 404 for anyone else', async () => {
    const project = await seedProject(testDb.db, owner.id);
    const first = await seedRun(testDb.db, project.id, { serviceId: service.id });
    const second = await seedRun(testDb.db, project.id, { serviceId: service.id });
    await runIntake(first, '0.00120000');

    const response = await get(owner, `/api/projects/${project.id}/runs`);
    expect(response.status).toBe(200);
    expect(response.get('cache-control')).toBe('no-store');
    const { runs } = projectRunsResponseSchema.parse(response.body);
    expect(runs.map((r) => [r.id, r.status, r.costUsd])).toEqual([
      [second.id, 'queued', '0.00000000'],
      [first.id, 'running', '0.00120000'],
    ]);

    expectNotFound(await get(stranger, `/api/projects/${project.id}/runs`));
    expectNotFound(await get(owner, `/api/projects/${randomUUID()}/runs`));
  });
});

describe('GET /api/runs/:runId/events', () => {
  const streams: SseConnection[] = [];
  const open = async (runId: string, query = '', headers: Record<string, string> = {}) => {
    const stream = await openSse(`${baseUrl}/api/runs/${runId}/events${query}`, {
      Cookie: owner.cookie,
      ...headers,
    });
    streams.push(stream);
    return stream;
  };
  const events = (messages: SseMessage[]) =>
    messages
      .filter((m) => m.data !== undefined && m.event === undefined)
      .map((m) => runStreamEventSchema.parse(JSON.parse(m.data ?? '')));

  afterAll(() => {
    for (const stream of streams) stream.abort();
  });

  it('replays stored events, delivers new ones, and ends after the terminal event', async () => {
    const { run } = await seedScenario(owner.id);
    await runIntake(run, '0.00050000');

    const stream = await open(run.id);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(stream.headers.get('cache-control')).toBe('private, no-cache, no-transform');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');
    await stream.until((m) => events(m).length === 4);
    expect(events(stream.messages()).map((e) => [e.seq, e.type])).toEqual([
      [1, 'run_status_changed'],
      [2, 'step_started'],
      [3, 'usage_recorded'],
      [4, 'step_completed'],
    ]);
    expect(
      stream
        .messages()
        .filter((m) => m.id !== undefined)
        .map((m) => m.id),
    ).toEqual(['1', '2', '3', '4']);

    await recordUsage(testDb.db, {
      runId: run.id,
      stepId: 'reconcile',
      modelId: 'muse-spark-1.3',
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: '0.00337500',
      latencyMs: 50,
    });
    await appendRunEvent(testDb.db, run.id, {
      type: 'usage_recorded',
      payload: { stepId: 'reconcile', stepCostUsd: '0.003375', runCostUsd: '0.003875' },
    });
    await stream.until((m) => events(m).length === 5);
    expect(events(stream.messages()).at(-1)).toMatchObject({
      seq: 5,
      type: 'usage_recorded',
      payload: { runCostUsd: '0.003875' },
    });

    await transitionRun(testDb.db, run.id, { to: 'failed', reason: 'Step "reconcile" timed out' });
    await stream.closed();
    const messages = stream.messages();
    expect(events(messages).at(-1)).toMatchObject({
      seq: 6,
      type: 'run_status_changed',
      payload: { from: 'running', to: 'failed', reason: 'Step "reconcile" timed out' },
    });
    const end = messages.at(-1);
    expect(end?.event).toBe(RUN_STREAM_END_EVENT);
    expect(runStreamEndSchema.parse(JSON.parse(end?.data ?? ''))).toEqual({
      status: 'failed',
      lastEventSeq: 6,
    });
  });

  it('resumes from Last-Event-ID, which wins over ?after=', async () => {
    const { run } = await seedScenario(owner.id);
    await runIntake(run, '0.00050000');
    await transitionRun(testDb.db, run.id, { to: 'completed' });

    const fromAfter = await open(run.id, '?after=3');
    await fromAfter.closed();
    expect(events(fromAfter.messages()).map((e) => e.seq)).toEqual([4, 5]);

    const fromHeader = await open(run.id, '?after=1', { 'Last-Event-ID': '4' });
    await fromHeader.closed();
    expect(events(fromHeader.messages()).map((e) => e.seq)).toEqual([5]);
    expect(fromHeader.messages().at(-1)?.event).toBe(RUN_STREAM_END_EVENT);
  });

  it('resyncs a cursor beyond the run head and then delivers its new events', async () => {
    const { run } = await seedScenario(owner.id);
    await runIntake(run, '0.00050000');

    const stream = await open(run.id, '?after=999');
    await stream.until((m) => m.some((message) => message.event === RUN_STREAM_RESYNC_EVENT));
    await transitionRun(testDb.db, run.id, { to: 'completed' });
    await stream.closed();
    expect(events(stream.messages()).map((e) => e.seq)).toEqual([5]);
    expect(runStreamEndSchema.parse(JSON.parse(stream.messages().at(-1)?.data ?? ''))).toEqual({
      status: 'completed',
      lastEventSeq: 5,
    });
  });

  it('streams a stored row the current schemas reject instead of failing on it forever', async () => {
    const { run } = await seedScenario(owner.id);
    await runIntake(run, '0.00050000');
    // Appended the way `appendRunEvent` does (counter, then row), bypassing its validation.
    await testDb.db.transaction(async (tx) => {
      await tx.execute(
        sql`update runs set last_event_seq = last_event_seq + 1 where id = ${run.id}`,
      );
      await tx.execute(
        sql`insert into run_events (run_id, seq, type, payload) values (${run.id}, 5, 'step_teleported', '[1, 2]'::jsonb)`,
      );
    });
    await transitionRun(testDb.db, run.id, { to: 'completed' });

    const stream = await open(run.id, '?after=3');
    await stream.closed();
    const data = stream
      .messages()
      .filter((m) => m.event === undefined && m.data !== undefined)
      .map((m) => JSON.parse(m.data ?? '') as unknown);
    expect(data).toMatchObject([
      { seq: 4, type: 'step_completed' },
      { seq: 5, type: 'step_teleported', payload: [1, 2] },
      { seq: 6, type: 'run_status_changed' },
    ]);
    expect(stream.messages().at(-1)?.event).toBe(RUN_STREAM_END_EVENT);
  });

  it('refuses a bad cursor and another user’s run before streaming', async () => {
    const badHeader = await get(owner, `/api/runs/${scenario.run.id}/events`).set(
      'Last-Event-ID',
      'abc',
    );
    expect(badHeader.status).toBe(400);
    expect(apiErrorSchema.parse(badHeader.body).error).toBe('validation_failed');
    expect((await get(owner, `/api/runs/${scenario.run.id}/events?after=-1`)).status).toBe(400);
    const foreign = await get(stranger, `/api/runs/${scenario.run.id}/events`);
    expectNotFound(foreign);
    expect(foreign.get('content-type')).toMatch(/^application\/json/);
  });

  it('releases the connection when the client disconnects', async () => {
    const { run } = await seedScenario(owner.id);
    const connectionsBefore = await new Promise<number>((resolve, reject) => {
      server.getConnections((error, count) => (error ? reject(error) : resolve(count)));
    });
    const stream = await open(run.id);
    await stream.until((m) => m.some((message) => message.retry !== undefined));
    stream.abort();

    const deadline = Date.now() + 3000;
    for (;;) {
      const count = await new Promise<number>((resolve, reject) => {
        server.getConnections((error, value) => (error ? reject(error) : resolve(value)));
      });
      if (count <= connectionsBefore) break;
      if (Date.now() > deadline) throw new Error(`${count} connections still open`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The pool still answers: no connection was left checked out by the stream.
    expect((await get(owner, `/api/runs/${run.id}`)).status).toBe(200);
  });
});

describe('evidence files', () => {
  const materialUrl = (id: string, query = '') =>
    `/api/runs/${scenario.run.id}/materials/${id}/file${query}`;

  function expectPrivateFileHeaders(response: request.Response): void {
    expect(response.get('cache-control')).toMatch(/^private, no-cache/);
    expect(response.get('x-content-type-options')).toBe('nosniff');
    expect(response.get('cross-origin-resource-policy')).toBe('same-origin');
  }

  it('serves an original photo whole, with validators and private headers', async () => {
    const response = await binary(get(owner, materialUrl(scenario.photo.id)));
    expect(response.status).toBe(200);
    expect(response.get('content-type')).toBe('image/jpeg');
    expect(response.get('content-length')).toBe(String(scenario.photo.bytes.byteLength));
    expect(response.get('accept-ranges')).toBe('bytes');
    expect(response.get('etag')).toBe(`"${sha256Hex(scenario.photo.bytes)}"`);
    expect(response.get('content-disposition')).toBe(
      `inline; filename="photo-${scenario.photo.id}.jpg"`,
    );
    expectPrivateFileHeaders(response);
    expect(bodyBytes(response).equals(Buffer.from(scenario.photo.bytes))).toBe(true);

    const revalidated = await get(owner, materialUrl(scenario.photo.id)).set(
      'If-None-Match',
      `"${sha256Hex(scenario.photo.bytes)}"`,
    );
    expect(revalidated.status).toBe(304);

    const download = await binary(get(owner, materialUrl(scenario.photo.id, '?download=1')));
    expect(download.get('content-disposition')).toBe(
      `attachment; filename="photo-${scenario.photo.id}.jpg"`,
    );
    expect((await get(owner, materialUrl(scenario.photo.id, '?download=yes'))).status).toBe(400);
  });

  it('answers Range requests on the voice memo: partial, suffix, ignored, and unsatisfiable', async () => {
    const memo = Buffer.from(scenario.memo.bytes);
    const url = materialUrl(scenario.memo.id);

    const partial = await binary(get(owner, url).set('Range', 'bytes=100-1099'));
    expect(partial.status).toBe(206);
    expect(partial.get('content-type')).toBe('audio/wav');
    expect(partial.get('content-range')).toBe(`bytes 100-1099/${memo.byteLength}`);
    expect(partial.get('content-length')).toBe('1000');
    expect(bodyBytes(partial).equals(memo.subarray(100, 1100))).toBe(true);
    expectPrivateFileHeaders(partial);
    expect(partial.get('cache-control')).toBe('private, no-cache, no-transform');

    const suffix = await binary(get(owner, url).set('Range', 'bytes=-44'));
    expect(suffix.status).toBe(206);
    expect(bodyBytes(suffix).equals(memo.subarray(memo.byteLength - 44))).toBe(true);

    const full = await binary(get(owner, url));
    expect(full.status).toBe(200);
    expect(bodyBytes(full).equals(memo)).toBe(true);

    const malformed = await binary(get(owner, url).set('Range', 'bytes=9-1'));
    expect(malformed.status).toBe(200);
    expect(bodyBytes(malformed).byteLength).toBe(memo.byteLength);

    const staleIfRange = await binary(
      get(owner, url).set('Range', 'bytes=0-9').set('If-Range', '"another-version"'),
    );
    expect(staleIfRange.status).toBe(200);

    const unsatisfiable = await get(owner, url).set('Range', `bytes=${memo.byteLength}-`);
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.get('content-range')).toBe(`bytes */${memo.byteLength}`);
    expect(apiErrorSchema.parse(unsatisfiable.body).error).toBe('range_not_satisfiable');
  });

  it('serves a transcript’s voice memo for turn playback, Range-capable', async () => {
    const memo = Buffer.from(scenario.memo.bytes);
    const url = `/api/runs/${scenario.run.id}/transcripts/${scenario.transcriptId}/audio`;
    const response = await binary(get(owner, url).set('Range', 'bytes=44-63'));
    expect(response.status).toBe(206);
    expect(response.get('content-type')).toBe('audio/wav');
    expect(bodyBytes(response).equals(memo.subarray(44, 64))).toBe(true);

    expectNotFound(
      await get(owner, `/api/runs/${scenario.run.id}/transcripts/${scenario.stagedId}/audio`),
    );
    expectNotFound(await get(stranger, url));
  });

  it('serves image artifacts (staged images) and nothing else', async () => {
    const staged = await binary(
      get(owner, `/api/runs/${scenario.run.id}/artifacts/${scenario.stagedId}/file`),
    );
    expect(staged.status).toBe(200);
    expect(staged.get('content-type')).toBe('image/jpeg');
    expect(staged.get('etag')).toBe(`"${scenario.stagedId}"`);
    expectPrivateFileHeaders(staged);
    expect((await sharp(bodyBytes(staged)).metadata()).format).toBe('jpeg');

    expectNotFound(
      await get(owner, `/api/runs/${scenario.run.id}/artifacts/${scenario.htmlArtifactId}/file`),
    );
    expectNotFound(
      await get(owner, `/api/runs/${scenario.run.id}/artifacts/${scenario.transcriptId}/file`),
    );
  });

  it('never serves another user’s files or another project’s material through a run', async () => {
    expectNotFound(await get(stranger, materialUrl(scenario.photo.id)));
    expectNotFound(
      await get(stranger, `/api/runs/${scenario.run.id}/artifacts/${scenario.stagedId}/file`),
    );
    const otherProject = await seedScenario(owner.id);
    // The owner's own photo, but of another project than this run's.
    expectNotFound(await get(owner, materialUrl(otherProject.photo.id)));
    // A staged image of another run.
    expectNotFound(
      await get(owner, `/api/runs/${scenario.run.id}/artifacts/${otherProject.stagedId}/file`),
    );
    expect((await get(undefined, materialUrl(scenario.photo.id))).status).toBe(401);
  });
});

describe('GET /api/runs/:runId/facts/:factId/mask.png', () => {
  it('renders the fact’s mask in the photo frame, matching the decoded raster', async () => {
    const response = await binary(
      get(owner, runFactMaskUrl(scenario.run.id, scenario.maskedFactId)),
    );
    expect(response.status).toBe(200);
    expect(response.get('content-type')).toBe('image/png');
    expect(response.get('x-content-type-options')).toBe('nosniff');
    expect(response.get('cache-control')).toMatch(/^private/);

    const { data, info } = await sharp(bodyBytes(response))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: FRAME.width, height: FRAME.height, channels: 4 });
    const { box, mask } = scenario.maskRegion;
    if (mask === null) throw new Error('The scenario region has a mask');
    const raster = decodeSamMask(mask);
    let mismatches = 0;
    let foreground = 0;
    for (let y = 0; y < FRAME.height; y += 1) {
      for (let x = 0; x < FRAME.width; x += 1) {
        const inBox = x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1;
        const expected = inBox && raster[(y - box.y0) * mask.width + (x - box.x0)] === 1 ? 255 : 0;
        const alpha = data[(y * FRAME.width + x) * 4 + 3];
        if (alpha !== expected) mismatches += 1;
        if (expected === 255) foreground += 1;
      }
    }
    expect(foreground).toBeGreaterThan(0);
    expect(mismatches).toBe(0);

    const revalidated = await get(
      owner,
      runFactMaskUrl(scenario.run.id, scenario.maskedFactId),
    ).set('If-None-Match', response.get('etag') ?? '');
    expect(revalidated.status).toBe(304);
  });

  it('answers 404 for facts without a mask and for other users', async () => {
    expectNotFound(await get(owner, runFactMaskUrl(scenario.run.id, scenario.unmaskedFactId)));
    expectNotFound(await get(owner, runFactMaskUrl(scenario.run.id, scenario.formFactId)));
    expectNotFound(await get(owner, runFactMaskUrl(scenario.run.id, randomUUID())));
    expectNotFound(await get(stranger, runFactMaskUrl(scenario.run.id, scenario.maskedFactId)));
  });
});

describe('export', () => {
  it('answers 409 export_not_ready before the export step has stored its manifest', async () => {
    const { run } = await seedScenario(owner.id);
    const response = await get(owner, `/api/runs/${run.id}/export`);
    expect(response.status).toBe(409);
    expect(apiErrorSchema.parse(response.body).error).toBe('export_not_ready');
    expectNotFound(await get(stranger, `/api/runs/${run.id}/export`));
  });

  it('lists the manifest and serves each file with its headers', async () => {
    const { run } = await seedScenario(owner.id);
    const { manifestId, fileIds } = await storeExport(run);
    const [htmlId, jsonId, imageId] = fileIds;

    const response = await get(owner, `/api/runs/${run.id}/export`);
    expect(response.status).toBe(200);
    expect(response.get('cache-control')).toBe('no-store');
    const body = runExportResponseSchema.parse(response.body);
    expect(body).toMatchObject({
      runId: run.id,
      manifestArtifactId: manifestId,
      readyToPublish: false,
    });
    expect(body.files.map((f) => [f.role, f.fileName, f.artifactId])).toEqual([
      ['html', 'listing-pack.html', htmlId],
      ['portal_fields', 'portal-fields.json', jsonId],
      ['image', 'photo-01.jpg', imageId],
    ]);
    const [html, json, image] = body.files;
    if (html === undefined || json === undefined || image === undefined) throw new Error('files');
    expect(html.url).toBe(`/api/runs/${run.id}/export/files/${htmlId}`);
    expect(html.downloadUrl).toBe(`/api/runs/${run.id}/export/files/${htmlId}?download=1`);

    const view = await get(owner, html.url);
    expect(view.status).toBe(200);
    expect(view.get('content-type')).toBe('text/html; charset=utf-8');
    expect(view.get('content-security-policy')).toBe(PACK_RESPONSE_CSP);
    expect(PACK_RESPONSE_CSP).toBe(
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    );
    expect(view.get('x-content-type-options')).toBe('nosniff');
    expect(view.get('content-disposition')).toBe('inline; filename="listing-pack.html"');
    expect(view.get('etag')).toBe(`"${html.sha256}"`);
    expect(view.text).toBe(PACK_HTML);

    const download = await get(owner, html.downloadUrl);
    expect(download.get('content-disposition')).toBe('attachment; filename="listing-pack.html"');
    expect(download.get('content-security-policy')).toBe(PACK_RESPONSE_CSP);

    const fields = await get(owner, json.url);
    expect(fields.status).toBe(200);
    expect(fields.get('content-type')).toBe('application/json; charset=utf-8');
    expect(fields.get('content-disposition')).toBe('attachment; filename="portal-fields.json"');
    expect(fields.get('x-content-type-options')).toBe('nosniff');

    const photo = await binary(get(owner, image.url).set('Range', 'bytes=0-1'));
    expect(photo.status).toBe(206);
    expect(bodyBytes(photo).equals(Buffer.from([0xff, 0xd8]))).toBe(true);

    // Only files the manifest lists, and only for the owner.
    expectNotFound(await get(owner, `/api/runs/${run.id}/export/files/${manifestId}`));
    expectNotFound(await get(stranger, html.url));
  });
});
