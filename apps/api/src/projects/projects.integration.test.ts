import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apiErrorSchema,
  authUserResponseSchema,
  localizedLabel,
  marketFormResponseSchema,
  marketListResponseSchema,
  projectDetailResponseSchema,
  projectListResponseSchema,
  projectMaterialFileUrl,
  serviceResponseSchema,
  startRunResponseSchema,
  UPLOAD_LIMITS,
  uploadMaterialResponseSchema,
  type CreateProjectRequest,
  type ProjectDetailResponse,
  type UploadLimits,
} from '@evidomo/shared';
import { sql } from 'drizzle-orm';
import type { Express, RequestHandler } from 'express';
import { PgBoss } from 'pg-boss';
import sharp from 'sharp';
import request from 'supertest';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appConfigFromEnv, createApp } from '../app.ts';
import { addMaterial, listMaterials } from '../db/repositories/materials.ts';
import { getProject as getProjectRow, lockProject } from '../db/repositories/projects.ts';
import {
  getRun,
  listRunsForProject,
  projectChangedSinceRun,
  transitionRun,
} from '../db/repositories/runs.ts';
import { seedProject, startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { loadDefinitions, type DefinitionRegistry } from '../definitions/loader.ts';
import { loadEnv } from '../env.ts';
import { createLogger, type Logger } from '../logger.ts';
import { generateTone, runFfmpegTests } from '../media/testing.ts';
import { WALKTHROUGH_FACT_FORM } from '../pipeline/intake/testing.ts';
import { createRunEngine } from '../runs/engine.ts';
import { RUN_STEP_QUEUE } from '../runs/queue.ts';
import { createLocalStorage } from '../storage/local.ts';
import type { Storage } from '../storage/storage.ts';
import type { UploadSlotLimits } from '../upload/slots.ts';
import { createRunStartGuards } from './run-start-guards.ts';

// The project and input API (P4-02 … P4-04) through HTTP, against PostgreSQL (Testcontainers),
// local storage in a temp directory, the real media processing, and the real run engine with a
// send-only pg-boss: starting a run enqueues the first step, and no worker exists to execute it,
// so no model is ever reached (fetch is stubbed to fail as a second guard).

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });
const PASSWORD = 'correct horse battery staple';
const APP_ORIGIN = 'http://localhost:3000';
const SAMPLES = fileURLToPath(
  new URL('../../../../fixtures/samples/synthetic-interiors/', import.meta.url),
);
const SAMPLE_PHOTOS = [
  'living-empty.jpg',
  'living-dining-cluttered.jpg',
  'kitchen-cluttered.jpg',
  'bedroom-empty.jpg',
  'hallway.jpg',
  'dining-chairs.jpg',
  'living-empty.edit-add-sofa.jpg',
  'living-dining-cluttered.edit-declutter-table.jpg',
  'bedroom-empty.edit-add-bed.jpg',
  'dining-chairs.edit-replace-chairs.jpg',
];
/** Small limits so the size and duration rejections need no large files. */
const LIMITS: UploadLimits = {
  ...UPLOAD_LIMITS,
  photoMaxBytes: 512 * 1024,
  voiceMemoMaxBytes: 1024 * 1024,
  voiceMemoMaxDurationMs: 6_000,
};

let testDb: TestDatabase;
let boss: PgBoss;
let definitions: DefinitionRegistry;
let storageDir: string;
let uploadTempDir: string;
let mediaDir: string;
let storage: Storage;
let app: Express;

interface Operator {
  readonly id: string;
  readonly agent: ReturnType<typeof request.agent>;
}
let owner: Operator;
let stranger: Operator;

type AppEngine = Parameters<typeof createApp>[0]['runs']['engine'];
let engine: AppEngine;

function buildApp(
  options: {
    dailyCapUsd?: string;
    engine?: AppEngine;
    storage?: Storage;
    logger?: Logger;
    uploadSlots?: UploadSlotLimits;
    runStartGuards?: RequestHandler[];
  } = {},
) {
  const env = loadEnv({
    DATABASE_URL: testDb.container.getConnectionUri(),
    NODE_ENV: 'test',
    APP_ORIGIN,
  });
  return createApp({
    db: testDb.client,
    logger: options.logger ?? logger,
    config: appConfigFromEnv(env),
    runs: { engine: options.engine ?? engine, markets: definitions, services: definitions },
    storage: options.storage ?? storage,
    projects: {
      definitions,
      dailyCapUsd: options.dailyCapUsd ?? '5.00',
      uploadLimits: LIMITS,
      uploadTempDir,
      // Above the default per-user cap, so the race tests can send several uploads at once.
      uploadSlots: options.uploadSlots ?? { perUser: 4, total: 8 },
      ...(options.runStartGuards === undefined ? {} : { runStartGuards: options.runStartGuards }),
    },
  });
}

/** An agent of `operator` on another app instance (same database, so the same account). */
async function loginOn(target: Express | Server, operator: Operator) {
  const agent = request.agent(target);
  const login = await agent
    .post('/api/auth/login')
    .send({ email: await emailOf(operator.id), password: PASSWORD });
  expect(login.status).toBe(200);
  return agent;
}

async function signUp(target: Express = app): Promise<Operator> {
  const agent = request.agent(target);
  const response = await agent
    .post('/api/auth/register')
    .send({ email: `operator-${randomUUID()}@example.test`, password: PASSWORD });
  expect(response.status).toBe(201);
  return { id: authUserResponseSchema.parse(response.body).user.id, agent };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  definitions = await loadDefinitions();
  storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-projects-storage-'));
  uploadTempDir = await mkdtemp(path.join(tmpdir(), 'evidomo-projects-uploads-'));
  mediaDir = await mkdtemp(path.join(tmpdir(), 'evidomo-projects-media-'));
  storage = createLocalStorage({ rootDir: storageDir });
  // Send-only, like the API process: no supervision, no workers.
  boss = new PgBoss({
    connectionString: testDb.container.getConnectionUri(),
    supervise: false,
    schedule: false,
  });
  boss.on('error', (error) => {
    logger.error({ err: error }, 'pg-boss error in test');
  });
  await boss.start();
  const realEngine = createRunEngine({
    db: testDb.db,
    boss,
    registry: definitions,
    logger,
    dailyCapUsd: '5.00',
  });
  await realEngine.ensureQueues();
  engine = realEngine;
  app = buildApp();
  owner = await signUp();
  stranger = await signUp();
  vi.stubGlobal('fetch', () => Promise.reject(new Error('No network access in this test')));
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await boss?.stop({ graceful: false });
  await testDb?.stop();
  for (const dir of [storageDir, uploadTempDir, mediaDir]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const NEW_PROJECT: CreateProjectRequest = {
  title: 'Synthetic three-room apartment',
  officeProfile: { agencyName: 'Example Makelaardij', tone: 'warm' },
  market: { id: 'nl', version: 1 },
  outputLanguage: 'en',
};

function errorOf(response: request.Response) {
  return apiErrorSchema.parse(response.body);
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

async function createProject(as: Operator = owner): Promise<ProjectDetailResponse> {
  const response = await as.agent.post('/api/projects').send(NEW_PROJECT);
  expect(response.status).toBe(201);
  expect(response.headers['cache-control']).toBe('no-store');
  return projectDetailResponseSchema.parse(response.body);
}

async function getProject(projectId: string, as: Operator = owner): Promise<ProjectDetailResponse> {
  const response = await as.agent.get(`/api/projects/${projectId}`);
  expect(response.status).toBe(200);
  return projectDetailResponseSchema.parse(response.body);
}

function uploadPhoto(projectId: string, bytes: Buffer, type = 'image/jpeg', as: Operator = owner) {
  return as.agent
    .post(`/api/projects/${projectId}/materials/photos`)
    .set('Content-Type', type)
    .send(bytes);
}

function uploadMemo(projectId: string, bytes: Buffer, type = 'audio/webm', as: Operator = owner) {
  return as.agent
    .put(`/api/projects/${projectId}/materials/voice-memo`)
    .set('Content-Type', type)
    .send(bytes);
}

async function samplePhoto(name: string): Promise<Buffer> {
  return readFile(path.join(SAMPLES, name));
}

let toneCount = 0;
async function tone(seconds: number): Promise<Buffer> {
  toneCount += 1;
  return readFile(generateTone(mediaDir, `memo-${toneCount}.webm`, { seconds, codec: 'libopus' }));
}

async function tinyJpeg(seed: number): Promise<Buffer> {
  return sharp({
    create: { width: 32, height: 24, channels: 3, background: { r: seed % 256, g: 80, b: 160 } },
  })
    .jpeg()
    .toBuffer();
}

async function storedFiles(): Promise<string[]> {
  const entries = await readdir(storageDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.parentPath.includes(`${path.sep}.tmp`))
    .map((entry) => path.relative(storageDir, path.join(entry.parentPath, entry.name)));
}

async function stepJobCount(runId: string): Promise<number> {
  const result = await testDb.db.execute<{ count: string }>(sql`
    select count(*)::text as count from pgboss.job
    where name = ${RUN_STEP_QUEUE} and data->>'runId' = ${runId}
  `);
  return Number(result.rows[0]?.count ?? 0);
}

/** A project with the ten sample photos (in order), a voice memo, and the walkthrough form. */
async function readyProject(): Promise<ProjectDetailResponse> {
  const created = await createProject();
  const projectId = created.project.id;
  for (const name of SAMPLE_PHOTOS) {
    expect((await uploadPhoto(projectId, await samplePhoto(name))).status).toBe(201);
  }
  expect((await uploadMemo(projectId, await tone(2))).status).toBe(200);
  const saved = await owner.agent
    .put(`/api/projects/${projectId}/fact-form`)
    .send({ values: WALKTHROUGH_FACT_FORM });
  expect(saved.status).toBe(200);
  return projectDetailResponseSchema.parse(saved.body);
}

// ---------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------

describe('GET /api/markets and /api/services', () => {
  it('lists the markets and describes one for the forms', async () => {
    const list = await owner.agent.get('/api/markets');
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(marketListResponseSchema.parse(list.body).markets).toEqual(
      expect.arrayContaining([
        {
          id: 'nl',
          version: 1,
          name: 'Netherlands',
          names: { tr: 'Hollanda', nl: 'Nederland', it: 'Paesi Bassi', es: 'Países Bajos' },
          outputLanguages: ['en', 'nl'],
          defaultOutputLanguage: 'en',
        },
      ]),
    );

    const nl = await owner.agent.get('/api/markets/nl/1');
    expect(nl.status).toBe(200);
    const market = marketFormResponseSchema.parse(nl.body).market;
    expect(market.facts.filter((fact) => fact.required).map((fact) => fact.key)).toEqual([
      'energy_label',
      'living_area',
    ]);
    // Translations travel with the English source, so the web picks one per UI language.
    const living = market.facts.find((fact) => fact.key === 'living_area');
    expect(living?.label).toBe('Living area (woonoppervlakte)');
    expect(living ? localizedLabel(living, 'tr') : undefined).toBe('Yaşam alanı (woonoppervlakte)');
    expect(living ? localizedLabel(living, 'nl') : undefined).toBe('Woonoppervlakte');
    expect(localizedLabel({ label: market.name, labels: market.names }, 'es')).toBe('Países Bajos');
    const international = marketFormResponseSchema.parse(
      (await owner.agent.get('/api/markets/international/1')).body,
    ).market;
    const type = international.facts.find((fact) => fact.key === 'property_type');
    expect(type?.type === 'enum' ? type.options.map((option) => option.labels.it) : []).toEqual([
      'Appartamento',
      'Casa',
    ]);
  });

  it('describes the capture inputs of the pinned service', async () => {
    const response = await owner.agent.get('/api/services/listing-launch/1');
    expect(response.status).toBe(200);
    expect(serviceResponseSchema.parse(response.body).service.inputs).toContainEqual({
      key: 'photos',
      type: 'images',
      min: 10,
      max: 30,
      required: true,
    });
  });

  it('answers 404 for unknown versions, 400 for malformed ones, 401 without a session', async () => {
    expect((await owner.agent.get('/api/markets/nl/9')).status).toBe(404);
    expect(errorOf(await owner.agent.get('/api/markets/nl/1.0')).error).toBe('validation_failed');
    expect((await owner.agent.get('/api/services/unknown/1')).status).toBe(404);
    expect((await request(app).get('/api/markets')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

describe('projects', () => {
  it('creates a draft project with the pinned service and an empty readiness list', async () => {
    const detail = await createProject();
    expect(detail.project).toMatchObject({
      title: NEW_PROJECT.title,
      status: 'draft',
      officeProfile: NEW_PROJECT.officeProfile,
      market: { id: 'nl', version: 1, name: 'Netherlands' },
      outputLanguage: 'en',
      service: { id: 'listing-launch', version: 1 },
    });
    expect(detail.factForm.values).toEqual({});
    expect(detail.materials).toEqual([]);
    expect(detail.latestRun).toBeNull();
    expect(detail.readiness.canStartRun).toBe(false);
    expect(detail.readiness.missing).toContainEqual({ kind: 'voice_memo' });
  });

  it('validates the market, language, and body', async () => {
    const unknownMarket = await owner.agent
      .post('/api/projects')
      .send({ ...NEW_PROJECT, market: { id: 'nl', version: 7 } });
    expect(unknownMarket.status).toBe(400);
    expect(errorOf(unknownMarket).issues).toEqual([
      { path: ['market'], message: 'Unknown market profile' },
    ]);

    const language = await owner.agent
      .post('/api/projects')
      .send({ ...NEW_PROJECT, outputLanguage: 'de' });
    expect(language.status).toBe(400);
    expect(errorOf(language).issues?.[0]?.path).toEqual(['outputLanguage']);

    const extra = await owner.agent
      .post('/api/projects')
      .send({ ...NEW_PROJECT, status: 'active' });
    expect(errorOf(extra).error).toBe('validation_failed');

    const form = await owner.agent
      .post('/api/projects')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('title=x');
    expect(form.status).toBe(415);
  });

  it("lists only the owner's projects with counts, and hides other users' projects", async () => {
    const own = await createProject();
    expect((await uploadPhoto(own.project.id, await tinyJpeg(1))).status).toBe(201);
    const theirs = await createProject(stranger);

    const list = await owner.agent.get('/api/projects');
    expect(list.status).toBe(200);
    const projects = projectListResponseSchema.parse(list.body).projects;
    expect(projects.map((p) => p.id)).toContain(own.project.id);
    expect(projects.map((p) => p.id)).not.toContain(theirs.project.id);
    expect(projects.find((p) => p.id === own.project.id)).toMatchObject({
      photoCount: 1,
      hasVoiceMemo: false,
      latestRun: null,
    });

    for (const response of [
      await owner.agent.get(`/api/projects/${theirs.project.id}`),
      await owner.agent.patch(`/api/projects/${theirs.project.id}`).send({ title: 'Mine now' }),
      await owner.agent
        .put(`/api/projects/${theirs.project.id}/fact-form`)
        .send({ values: { build_year: 1990 } }),
      await uploadPhoto(theirs.project.id, await tinyJpeg(2)),
      await owner.agent.post(`/api/projects/${theirs.project.id}/runs`).send({}),
      await owner.agent.get(`/api/projects/${randomUUID()}`),
    ]) {
      expect(response.status).toBe(404);
      expect(errorOf(response).error).toBe('not_found');
    }
    expect((await getProject(theirs.project.id, stranger)).project.title).toBe(NEW_PROJECT.title);
  });

  it('updates the title and the office profile', async () => {
    const { project } = await createProject();
    const response = await owner.agent.patch(`/api/projects/${project.id}`).send({
      title: 'Renamed',
      officeProfile: { agencyName: 'Other Office', contactBlock: 'info@example.invalid' },
    });
    expect(response.status).toBe(200);
    expect(projectDetailResponseSchema.parse(response.body).project).toMatchObject({
      title: 'Renamed',
      officeProfile: { agencyName: 'Other Office', contactBlock: 'info@example.invalid' },
    });
    expect((await owner.agent.patch(`/api/projects/${project.id}`).send({})).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
// Fact form
// ---------------------------------------------------------------------------------------------

describe('PUT /api/projects/:projectId/fact-form', () => {
  it('saves a partial draft and reports the missing required facts in readiness', async () => {
    const { project } = await createProject();
    const response = await owner.agent
      .put(`/api/projects/${project.id}/fact-form`)
      .send({ values: { build_year: 1987, street_name: ' Kwartelhoflaan ', energy_label: null } });
    expect(response.status).toBe(200);
    const detail = projectDetailResponseSchema.parse(response.body);
    expect(detail.factForm.values).toEqual({ build_year: 1987, street_name: 'Kwartelhoflaan' });
    expect(detail.readiness.missing).toEqual(
      expect.arrayContaining([
        { kind: 'fact', key: 'energy_label', problem: 'missing' },
        { kind: 'fact', key: 'living_area', problem: 'missing' },
      ]),
    );
  });

  it('refuses invalid values with a field map and keeps the stored form', async () => {
    const { project } = await createProject();
    await owner.agent
      .put(`/api/projects/${project.id}/fact-form`)
      .send({ values: { build_year: 1987 } });
    const response = await owner.agent.put(`/api/projects/${project.id}/fact-form`).send({
      values: { energy_label: 'Z', living_area: -3, build_year: 1987.5, 'Bad Key': 'x' },
    });
    expect(response.status).toBe(400);
    const error = errorOf(response);
    expect(error.error).toBe('validation_failed');
    expect(error.fields).toEqual({
      energy_label: 'not_allowed',
      living_area: 'out_of_range',
      build_year: 'not_an_integer',
      'Bad Key': 'invalid_key',
    });
    expect(error.issues).toContainEqual({
      path: ['values', 'energy_label'],
      message: 'Not one of the allowed values',
    });
    expect((await getProject(project.id)).factForm.values).toEqual({ build_year: 1987 });
  });

  it('refuses a malformed body', async () => {
    const { project } = await createProject();
    const nested = await owner.agent
      .put(`/api/projects/${project.id}/fact-form`)
      .send({ values: { energy_label: { class: 'B' } } });
    expect(errorOf(nested).error).toBe('validation_failed');
    const missing = await owner.agent.put(`/api/projects/${project.id}/fact-form`).send({});
    expect(missing.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------------------------

describe('photo uploads', () => {
  it('stores a re-encoded JPEG without metadata and returns its material', async () => {
    const { project } = await createProject();
    const withGps = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#3080c0' },
    })
      .withMetadata({ orientation: 6 })
      .withExifMerge({
        IFD0: { Make: 'TestCam', Artist: 'Test Agent' },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '52/1 22/1 1234/100',
          GPSLongitudeRef: 'E',
          GPSLongitude: '4/1 53/1 5678/100',
        },
      })
      .jpeg({ quality: 60 })
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();

    const response = await uploadPhoto(project.id, withGps);
    expect(response.status).toBe(201);
    const { material } = uploadMaterialResponseSchema.parse(response.body);
    // Orientation 6 is applied (portrait), then the long edge is capped at 2048 px.
    expect(material).toMatchObject({
      kind: 'photo',
      status: 'ready',
      position: 1,
      mimeType: 'image/jpeg',
      width: 1365,
      height: 2048,
      durationMs: null,
      failureReason: null,
    });

    const [row] = await listMaterials(testDb.db, project.id);
    if (row === undefined) throw new Error('no material row');
    const stored = await readFile(path.join(storageDir, row.storageKey));
    const metadata = await sharp(stored).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(stored.includes(Buffer.from('TestCam'))).toBe(false);
    expect(row.sizeBytes).toBe(stored.length);
  });

  it('keeps upload order as photo order and renumbers after a delete', async () => {
    const { project } = await createProject();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await uploadPhoto(project.id, await tinyJpeg(i));
      const { material } = uploadMaterialResponseSchema.parse(response.body);
      expect(material.position).toBe(i + 1);
      ids.push(material.id);
    }
    const [first, second, third] = ids;
    const deleted = await owner.agent.delete(`/api/projects/${project.id}/materials/${second}`);
    expect(deleted.status).toBe(204);
    const detail = await getProject(project.id);
    expect(detail.materials.map((m) => [m.id, m.position])).toEqual([
      [first, 1],
      [third, 2],
    ]);
    expect(await storedFiles()).not.toContainEqual(expect.stringContaining(String(second)));

    expect(
      (await owner.agent.delete(`/api/projects/${project.id}/materials/${second}`)).status,
    ).toBe(404);
    expect(
      (await stranger.agent.delete(`/api/projects/${project.id}/materials/${String(first)}`))
        .status,
    ).toBe(404);
  });

  it('accepts concurrent uploads and gives each a distinct position', async () => {
    const { project } = await createProject();
    const responses = await Promise.all(
      [0, 1, 2, 3].map(async (i) => uploadPhoto(project.id, await tinyJpeg(10 + i))),
    );
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const detail = await getProject(project.id);
    expect(detail.materials.map((m) => m.position)).toEqual([1, 2, 3, 4]);
  });

  it('refuses invalid files by content, stores nothing, and leaves no temp file', async () => {
    const { project } = await createProject();
    const filesBefore = await storedFiles();
    const jpeg = await tinyJpeg(5);
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftypheicmif1heic'),
      Buffer.alloc(64),
    ]);
    const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } })
      .gif()
      .toBuffer();
    const cases: { body: Buffer; type: string; status: number; reason: string }[] = [
      { body: heic, type: 'image/heic', status: 422, reason: 'heic_not_supported' },
      // The client's type is not trusted: HEIC content labeled as JPEG is still HEIC.
      { body: heic, type: 'image/jpeg', status: 422, reason: 'heic_not_supported' },
      { body: gif, type: 'image/jpeg', status: 422, reason: 'unsupported_format' },
      {
        body: jpeg.subarray(0, jpeg.length - 40),
        type: 'image/jpeg',
        status: 422,
        reason: 'undecodable',
      },
      {
        body: Buffer.alloc(LIMITS.photoMaxBytes + 1, 0xff),
        type: 'image/jpeg',
        status: 413,
        reason: 'file_too_large',
      },
      { body: Buffer.alloc(0), type: 'image/jpeg', status: 422, reason: 'empty_file' },
    ];
    for (const testCase of cases) {
      const response = await uploadPhoto(project.id, testCase.body, testCase.type);
      expect([response.status, errorOf(response)]).toEqual([
        testCase.status,
        { error: 'upload_rejected', reason: testCase.reason },
      ]);
    }
    const wrongType = await uploadPhoto(project.id, jpeg, 'text/plain');
    expect([wrongType.status, errorOf(wrongType).error]).toEqual([415, 'unsupported_media_type']);

    expect(await listMaterials(testDb.db, project.id)).toEqual([]);
    expect(await storedFiles()).toEqual(filesBefore);
    expect(await readdir(uploadTempDir)).toEqual([]);
  });

  it('refuses a cross-origin upload before reading it', async () => {
    const { project } = await createProject();
    const response = await owner.agent
      .post(`/api/projects/${project.id}/materials/photos`)
      .set('Origin', 'https://evil.example')
      .set('Content-Type', 'image/jpeg')
      .send(await tinyJpeg(3));
    expect([response.status, errorOf(response).error]).toEqual([403, 'forbidden_origin']);
  });

  it('accepts exactly one of three racing uploads for the last photo slot', async () => {
    const { project } = await createProject();
    for (let i = 0; i < 29; i += 1) {
      expect((await uploadPhoto(project.id, await tinyJpeg(300 + i))).status).toBe(201);
    }
    // All three pass the unlocked pre-check; the count under the project lock decides.
    const responses = await Promise.all(
      [0, 1, 2].map(async (i) => uploadPhoto(project.id, await tinyJpeg(400 + i))),
    );
    const outcomes = responses.map((r) =>
      r.status === 201 ? 201 : `${r.status} ${errorOf(r).error}`,
    );
    expect(outcomes.sort()).toEqual([201, '409 photo_limit_reached', '409 photo_limit_reached']);
    expect(await listMaterials(testDb.db, project.id, { kind: 'photo' })).toHaveLength(30);
  });

  it('stops at the service maximum of 30 photos', async () => {
    const { project } = await createProject();
    for (let i = 0; i < 30; i += 1) {
      expect((await uploadPhoto(project.id, await tinyJpeg(100 + i))).status).toBe(201);
    }
    const response = await uploadPhoto(project.id, await tinyJpeg(200));
    expect([response.status, errorOf(response).error]).toEqual([409, 'photo_limit_reached']);
    expect((await getProject(project.id)).readiness.photos.count).toBe(30);
  });

  it('serves a stored photo to its owner only, with the private file headers', async () => {
    const { project } = await createProject();
    const uploaded = await uploadPhoto(project.id, await tinyJpeg(42));
    const { material } = uploadMaterialResponseSchema.parse(uploaded.body);
    const [row] = await listMaterials(testDb.db, project.id);
    if (row === undefined) throw new Error('no material row');
    const url = projectMaterialFileUrl(project.id, material.id);

    const response = await binary(owner.agent.get(url));
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      'content-type': 'image/jpeg',
      'cache-control': 'private, no-cache, no-transform',
      etag: `"${row.sha256}"`,
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'content-disposition': `inline; filename="photo-${material.id}.jpg"`,
      'accept-ranges': 'bytes',
    });
    expect(
      Buffer.compare(bodyBytes(response), await readFile(path.join(storageDir, row.storageKey))),
    ).toBe(0);

    const revalidated = await owner.agent.get(url).set('If-None-Match', `"${row.sha256}"`);
    expect(revalidated.status).toBe(304);
    const download = await owner.agent.get(
      projectMaterialFileUrl(project.id, material.id, { download: true }),
    );
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename="photo-${material.id}.jpg"`,
    );
    expect((await owner.agent.get(`${url}?download=yes`)).status).toBe(400);
    expect((await owner.agent.get(projectMaterialFileUrl(project.id, 'nope'))).status).toBe(400);

    // Another user's project, another project's material, and an unknown ID are all 404.
    expect((await stranger.agent.get(url)).status).toBe(404);
    const other = await createProject();
    expect(
      (await owner.agent.get(projectMaterialFileUrl(other.project.id, material.id))).status,
    ).toBe(404);
    expect((await owner.agent.get(projectMaterialFileUrl(project.id, randomUUID()))).status).toBe(
      404,
    );
    expect((await request(app).get(url)).status).toBe(401);
  });
});

describe.skipIf(!runFfmpegTests)('voice memo uploads', () => {
  it('stores the transcription WAV and replaces an earlier memo', async () => {
    const { project } = await createProject();
    const first = await uploadMemo(project.id, await tone(2));
    expect(first.status).toBe(200);
    const firstMaterial = uploadMaterialResponseSchema.parse(first.body).material;
    expect(firstMaterial).toMatchObject({
      kind: 'voice_memo',
      status: 'ready',
      position: 1,
      mimeType: 'audio/wav',
      width: null,
    });
    expect(firstMaterial.durationMs).toBeGreaterThanOrEqual(1900);
    const [firstRow] = await listMaterials(testDb.db, project.id);
    if (firstRow === undefined) throw new Error('no memo row');

    const second = await uploadMemo(project.id, await tone(3), 'audio/ogg; codecs=opus');
    expect(second.status).toBe(200);
    const memos = await listMaterials(testDb.db, project.id, { kind: 'voice_memo' });
    expect(memos.map((m) => m.id)).toEqual([
      uploadMaterialResponseSchema.parse(second.body).material.id,
    ]);
    expect(await storedFiles()).not.toContain(firstRow.storageKey);
  });

  it('serves the stored memo with Range support for playback before a run', async () => {
    const { project } = await createProject();
    const { material } = uploadMaterialResponseSchema.parse(
      (await uploadMemo(project.id, await tone(2))).body,
    );
    const url = projectMaterialFileUrl(project.id, material.id);
    const full = await binary(owner.agent.get(url));
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('audio/wav');
    const bytes = bodyBytes(full);
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');

    const partial = await binary(owner.agent.get(url).set('Range', 'bytes=4-11'));
    expect(partial.status).toBe(206);
    expect(partial.headers['content-range']).toBe(`bytes 4-11/${bytes.length}`);
    expect(Buffer.compare(bodyBytes(partial), bytes.subarray(4, 12))).toBe(0);
    const beyond = await owner.agent.get(url).set('Range', `bytes=${bytes.length}-`);
    expect([beyond.status, beyond.headers['content-range']]).toEqual([
      416,
      `bytes */${bytes.length}`,
    ]);
  });

  it('keeps exactly one memo when two uploads race', async () => {
    const { project } = await createProject();
    const [a, b] = await Promise.all([
      uploadMemo(project.id, await tone(1)),
      uploadMemo(project.id, await tone(2)),
    ]);
    expect([a?.status, b?.status]).toEqual([200, 200]);
    expect(await listMaterials(testDb.db, project.id, { kind: 'voice_memo' })).toHaveLength(1);
  });

  it('refuses a recording over the duration limit and a video-only type', async () => {
    const { project } = await createProject();
    const long = await uploadMemo(project.id, await tone(8));
    expect([long.status, errorOf(long)]).toEqual([
      422,
      { error: 'upload_rejected', reason: 'too_long' },
    ]);
    const garbage = await uploadMemo(project.id, Buffer.from('not audio at all'.repeat(10)));
    expect(errorOf(garbage).reason).toBe('unsupported_format');
    const video = await uploadMemo(project.id, await tone(1), 'video/webm');
    expect(video.status).toBe(415);
    expect(await listMaterials(testDb.db, project.id)).toEqual([]);
    expect(await readdir(uploadTempDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------------------------

describe.skipIf(!runFfmpegTests)('POST /api/projects/:projectId/runs', () => {
  it('lists what is missing as not_ready', async () => {
    const { project } = await createProject();
    expect((await uploadPhoto(project.id, await tinyJpeg(7))).status).toBe(201);
    const response = await owner.agent.post(`/api/projects/${project.id}/runs`).send({});
    expect(response.status).toBe(409);
    expect(errorOf(response)).toEqual({
      error: 'not_ready',
      missing: [
        { kind: 'photos', count: 1, min: 10, max: 30 },
        { kind: 'voice_memo' },
        { kind: 'fact', key: 'energy_label', problem: 'missing' },
        { kind: 'fact', key: 'living_area', problem: 'missing' },
      ],
    });
  });

  it('starts the run through the engine, then locks the inputs', async () => {
    const ready = await readyProject();
    const projectId = ready.project.id;
    expect(ready.readiness).toMatchObject({ canStartRun: true, missing: [] });
    expect(ready.materials.filter((m) => m.kind === 'photo').map((m) => m.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);

    const response = await owner.agent.post(`/api/projects/${projectId}/runs`);
    expect(response.status).toBe(201);
    const { run } = startRunResponseSchema.parse(response.body);
    expect(run).toMatchObject({ status: 'running', gate: null });
    const stored = await getRun(testDb.db, run.id);
    expect(stored).toMatchObject({
      projectId,
      serviceId: 'listing-launch',
      serviceVersion: 1,
      marketProfileId: 'nl',
      marketProfileVersion: 1,
      outputLanguage: 'en',
      currentStepId: 'intake',
    });
    expect(await stepJobCount(run.id)).toBe(1);
    // Every material predates the run, so the steps see all of them.
    const materials = await listMaterials(testDb.db, projectId);
    expect(materials.every((m) => m.createdAt.getTime() < (stored?.createdAt.getTime() ?? 0))).toBe(
      true,
    );

    const detail = await getProject(projectId);
    expect(detail.project.status).toBe('active');
    expect(detail.latestRun).toMatchObject({ id: run.id, status: 'running' });
    expect(detail.readiness).toMatchObject({
      canStartRun: false,
      inputsLocked: true,
      activeRunId: run.id,
    });

    const again = await owner.agent.post(`/api/projects/${projectId}/runs`).send({});
    expect([again.status, errorOf(again).error]).toEqual([409, 'run_active']);
    const photoId = detail.materials[0]?.id;
    for (const locked of [
      await uploadPhoto(projectId, await tinyJpeg(9)),
      await uploadMemo(projectId, await tone(1)),
      await owner.agent.delete(`/api/projects/${projectId}/materials/${String(photoId)}`),
      await owner.agent
        .put(`/api/projects/${projectId}/fact-form`)
        .send({ values: { ...WALKTHROUGH_FACT_FORM, build_year: 1990 } }),
      await owner.agent
        .patch(`/api/projects/${projectId}`)
        .send({ officeProfile: { agencyName: 'Changed' } }),
    ]) {
      expect([locked.status, errorOf(locked).error]).toEqual([409, 'inputs_locked']);
    }
    const renamed = await owner.agent
      .patch(`/api/projects/${projectId}`)
      .send({ title: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(await stepJobCount(run.id)).toBe(1);

    const list = projectListResponseSchema.parse((await owner.agent.get('/api/projects')).body);
    expect(list.projects.find((p) => p.id === projectId)).toMatchObject({
      photoCount: 10,
      hasVoiceMemo: true,
      latestRun: { id: run.id, status: 'running' },
    });
  });

  it('starts exactly one run when two starts race', async () => {
    const { project } = await readyProject();
    const responses = await Promise.all([
      owner.agent.post(`/api/projects/${project.id}/runs`).send({}),
      owner.agent.post(`/api/projects/${project.id}/runs`).send({}),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('refuses a start when the daily budget is spent', async () => {
    const { project } = await readyProject();
    const noBudget = buildApp({
      dailyCapUsd: '0',
      engine: {
        resumeAfterGate: () => Promise.reject(new Error('unused')),
        startRun: () => Promise.reject(new Error('must not start')),
        resumeRun: () => Promise.reject(new Error('unused')),
        discardPendingJobs: () => Promise.reject(new Error('unused')),
      },
    });
    const agent = await loginOn(noBudget, owner);
    const response = await agent.post(`/api/projects/${project.id}/runs`).send({});
    expect([response.status, errorOf(response).error]).toEqual([409, 'daily_budget_reached']);
    expect((await getProject(project.id)).latestRun).toBeNull();
  });

  it('requires the access code and applies the run limits in front of the real route (P4-10)', async () => {
    const accessCode = 'synthetic-integration-code';
    const guarded = buildApp({
      runStartGuards: createRunStartGuards({
        accessCode,
        limits: {
          perAccount: { limit: 1, windowMs: 86_400_000 },
          perIp: { limit: 10, windowMs: 86_400_000 },
          accessCodeFailuresPerIp: { limit: 10, windowMs: 3_600_000 },
        },
        logger,
      }),
    });
    const agent = await loginOn(guarded, owner);
    const start = (projectId: string, body?: object) => {
      const test = agent.post(`/api/projects/${projectId}/runs`);
      return body === undefined ? test : test.send(body);
    };

    // Not ready: the guards pass, the route refuses, and the allowance is not used.
    const draft = await createProject();
    const notReady = await start(draft.project.id, { accessCode });
    expect([notReady.status, errorOf(notReady).error]).toEqual([409, 'not_ready']);

    const { project } = await readyProject();
    for (const body of [undefined, {}, { accessCode: 'not-the-code' }]) {
      const refused = await start(project.id, body);
      expect([refused.status, errorOf(refused).error]).toEqual([403, 'access_code_invalid']);
    }
    expect((await getProject(project.id)).latestRun).toBeNull();

    const started = await start(project.id, { accessCode });
    expect(started.status).toBe(201);
    const runId = startRunResponseSchema.parse(started.body).run.id;
    expect(await stepJobCount(runId)).toBe(1);

    // The account's one start is used: the next ready project is refused before the route.
    const second = await readyProject();
    const limited = await start(second.project.id, { accessCode });
    expect([limited.status, errorOf(limited).error]).toEqual([429, 'run_limit_reached']);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(86_000);
    expect((await getProject(second.project.id)).latestRun).toBeNull();
  });
});

describe.skipIf(!runFfmpegTests)('races between a run start and an upload', () => {
  it('a run whose transaction began before an upload committed still sorts after it', async () => {
    const { project } = await readyProject();
    let start: Promise<request.Response> | undefined;
    let uploadedAt: Date | undefined;
    await testDb.db.transaction(async (tx) => {
      // Stands in for an upload holding the project lock while it commits its row.
      await lockProject(tx, project.id);
      start = owner.agent
        .post(`/api/projects/${project.id}/runs`)
        .send({})
        .then((response) => response);
      // The start's transaction has begun and waits for the lock.
      await expect
        .poll(async () => {
          const result = await testDb.db.execute<{ count: string }>(
            sql`select count(*)::text as count from pg_stat_activity where wait_event_type = 'Lock'`,
          );
          return Number(result.rows[0]?.count ?? 0);
        })
        .toBeGreaterThan(0);
      const material = await addMaterial(tx, {
        projectId: project.id,
        kind: 'photo',
        storageKey: `projects/${project.id}/materials/${randomUUID()}.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        sha256: 'b'.repeat(64),
        status: 'ready',
        metadata: {
          width: 32,
          height: 24,
          sourceFormat: 'jpeg',
          sourceWidth: 32,
          sourceHeight: 24,
        },
      });
      uploadedAt = material.createdAt;
    });
    const response = await start;
    expect(response?.status).toBe(201);
    const run = await getRun(testDb.db, startRunResponseSchema.parse(response?.body).run.id);
    // With `now()` the run would carry its transaction's start time, before the upload, and the
    // steps (materials created up to the run) would silently skip the photo.
    expect(run?.createdAt.getTime()).toBeGreaterThan(uploadedAt?.getTime() ?? Infinity);
  });

  it('either takes the upload into the run or refuses it, never half', async () => {
    const { project } = await readyProject();
    const [start, upload] = await Promise.all([
      owner.agent.post(`/api/projects/${project.id}/runs`).send({}),
      uploadPhoto(project.id, await tinyJpeg(77)),
    ]);
    expect(start.status).toBe(201);
    const run = await getRun(testDb.db, startRunResponseSchema.parse(start.body).run.id);
    if (upload.status === 201) {
      const { material } = uploadMaterialResponseSchema.parse(upload.body);
      expect(Date.parse(material.createdAt)).toBeLessThan(run?.createdAt.getTime() ?? 0);
    } else {
      expect([upload.status, errorOf(upload).error]).toEqual([409, 'inputs_locked']);
      expect(await listMaterials(testDb.db, project.id, { kind: 'photo' })).toHaveLength(10);
    }
  });
});

describe.skipIf(!runFfmpegTests)('input lock after runs', () => {
  it('unlocks the inputs when every run has failed, and locks them again for a completed run', async () => {
    const { project, materials } = await readyProject();
    const first = startRunResponseSchema.parse(
      (await owner.agent.post(`/api/projects/${project.id}/runs`).send({})).body,
    ).run;
    await transitionRun(testDb.db, first.id, { to: 'failed', reason: 'Step "intake" failed' });

    const unlocked = await getProject(project.id);
    expect(unlocked.readiness).toMatchObject({ inputsLocked: false, canStartRun: true });
    expect((await uploadPhoto(project.id, await tinyJpeg(88))).status).toBe(201);
    const photoId = materials[0]?.id;
    expect(
      (await owner.agent.delete(`/api/projects/${project.id}/materials/${String(photoId)}`)).status,
    ).toBe(204);
    expect(
      (
        await owner.agent
          .put(`/api/projects/${project.id}/fact-form`)
          .send({ values: { ...WALKTHROUGH_FACT_FORM, build_year: 1990 } })
      ).status,
    ).toBe(200);
    expect(
      (
        await owner.agent
          .patch(`/api/projects/${project.id}`)
          .send({ officeProfile: { agencyName: 'Corrected Office' } })
      ).status,
    ).toBe(200);

    const second = await owner.agent.post(`/api/projects/${project.id}/runs`).send({});
    expect(second.status).toBe(201);
    const secondRun = startRunResponseSchema.parse(second.body).run;
    await transitionRun(testDb.db, secondRun.id, { to: 'completed' });

    expect((await getProject(project.id)).readiness.inputsLocked).toBe(true);
    for (const locked of [
      await uploadPhoto(project.id, await tinyJpeg(89)),
      await owner.agent
        .put(`/api/projects/${project.id}/fact-form`)
        .send({ values: WALKTHROUGH_FACT_FORM }),
    ]) {
      expect([locked.status, errorOf(locked).error]).toEqual([409, 'inputs_locked']);
    }
  });

  it('records every input change after a failed run, so that run is no longer resumable', async () => {
    const { project, materials } = await readyProject();
    const failed = startRunResponseSchema.parse(
      (await owner.agent.post(`/api/projects/${project.id}/runs`).send({})).body,
    ).run;
    await transitionRun(testDb.db, failed.id, { to: 'failed', reason: 'Step "intake" failed' });
    // Starting the run wrote the project (`draft → active`) without counting as a change.
    expect(await projectChangedSinceRun(testDb.db, failed.id)).toBe(false);

    const updatedAt = async (): Promise<number> =>
      (await getProjectRow(testDb.db, project.id))?.updatedAt.getTime() ?? Number.NaN;
    const changes: [string, () => Promise<{ status: number }>][] = [
      ['upload', async () => uploadPhoto(project.id, await tinyJpeg(91))],
      [
        'material deletion',
        () =>
          owner.agent.delete(`/api/projects/${project.id}/materials/${String(materials[0]?.id)}`),
      ],
    ];
    for (const [change, act] of changes) {
      const before = await updatedAt();
      expect([change, (await act()).status]).toEqual([change, change === 'upload' ? 201 : 204]);
      expect([change, (await updatedAt()) > before]).toEqual([change, true]);
    }
    expect(await projectChangedSinceRun(testDb.db, failed.id)).toBe(true);
  });
});

describe('upload slots', () => {
  let server: Server;
  let port: number;
  const held: ClientRequest[] = [];

  beforeAll(async () => {
    server = buildApp({ uploadSlots: { perUser: 2, total: 3 } }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const req of held) req.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function cookieOf(operator: Operator): Promise<string> {
    const response = await request(server)
      .post('/api/auth/login')
      .send({ email: await emailOf(operator.id), password: PASSWORD });
    const header: unknown = response.headers['set-cookie'];
    const first: unknown = Array.isArray(header) ? header[0] : undefined;
    if (typeof first !== 'string') throw new Error('no session cookie');
    return first.split(';')[0] ?? '';
  }

  /** An upload that sends its headers and a first chunk, then keeps its slot until destroyed. */
  function holdUpload(projectId: string, cookie: string): ClientRequest {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: `/api/projects/${projectId}/materials/photos`,
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '200000', Cookie: cookie },
    });
    req.on('error', () => undefined);
    req.write(Buffer.alloc(1024, 0xff));
    held.push(req);
    return req;
  }

  it('answers 429 with Retry-After over the per-user and the process limits, and frees slots on abort', async () => {
    const { project } = await createProject();
    const other = await signUp();
    const theirs = await createProject(other);
    const ownerAgent = await loginOn(server, owner);
    const otherAgent = await loginOn(server, other);
    const send = (agent: typeof ownerAgent, projectId: string) =>
      agent
        .post(`/api/projects/${projectId}/materials/photos`)
        .set('Content-Type', 'image/jpeg')
        .send(Buffer.alloc(512, 0xff));

    const ownerCookie = await cookieOf(owner);
    const holds = [holdUpload(project.id, ownerCookie), holdUpload(project.id, ownerCookie)];
    // A held upload has its slot once it is receiving into its temp file.
    const receiving = async (): Promise<number> => (await readdir(uploadTempDir)).length;
    await expect.poll(receiving).toBe(2);
    const limited = await send(ownerAgent, project.id);
    expect([limited.status, errorOf(limited).error]).toEqual([429, 'too_many_uploads']);
    expect(limited.headers['retry-after']).toBe('5');

    // Another user still gets a slot: one left of the process limit (3)...
    holds.push(holdUpload(theirs.project.id, await cookieOf(other)));
    await expect.poll(receiving).toBe(3);
    // ...and then none.
    const full = await send(otherAgent, theirs.project.id);
    expect([full.status, errorOf(full).error]).toEqual([429, 'too_many_uploads']);

    for (const req of holds) req.destroy();
    await expect.poll(receiving).toBe(0);
    // Aborted uploads give their slots back; this body is no photo, so it is rejected by content.
    await expect
      .poll(async () => (await send(otherAgent, theirs.project.id)).status, { timeout: 5000 })
      .toBe(422);
    await expect
      .poll(async () => (await send(ownerAgent, project.id)).status, { timeout: 5000 })
      .toBe(422);
    expect(await readdir(uploadTempDir)).toEqual([]);
  });
});

describe('failure handling', () => {
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

  it('deletes the row and answers 204 when the file delete fails, logging the key', async () => {
    const captured = capturingLogger();
    const failingDelete: Storage = {
      ...storage,
      delete: () => Promise.reject(new Error('disk gone')),
    };
    const target = buildApp({ storage: failingDelete, logger: captured.logger });
    const agent = await loginOn(target, owner);
    const { project } = await createProject();
    const uploaded = await agent
      .post(`/api/projects/${project.id}/materials/photos`)
      .set('Content-Type', 'image/jpeg')
      .send(await tinyJpeg(55));
    const { material } = uploadMaterialResponseSchema.parse(uploaded.body);
    const [row] = await listMaterials(testDb.db, project.id);

    const deleted = await agent.delete(`/api/projects/${project.id}/materials/${material.id}`);
    expect(deleted.status).toBe(204);
    expect(await listMaterials(testDb.db, project.id)).toEqual([]);
    expect(captured.output()).toContain('could not delete a removed material file');
    expect(captured.output()).toContain(String(row?.storageKey));
  });

  it.skipIf(!runFfmpegTests)('rolls the run back when the engine cannot start it', async () => {
    const { project } = await readyProject();
    const target = buildApp({
      engine: {
        resumeAfterGate: () => Promise.reject(new Error('unused')),
        startRun: () => Promise.reject(new Error('enqueue failed')),
        resumeRun: () => Promise.reject(new Error('unused')),
        discardPendingJobs: () => Promise.reject(new Error('unused')),
      },
    });
    const agent = await loginOn(target, owner);
    const response = await agent.post(`/api/projects/${project.id}/runs`).send({});
    expect([response.status, errorOf(response).error]).toEqual([500, 'internal_error']);
    expect(await listRunsForProject(testDb.db, project.id)).toEqual([]);
    expect((await getProjectRow(testDb.db, project.id))?.status).toBe('draft');
    expect((await getProject(project.id)).readiness.inputsLocked).toBe(false);
  });

  it('keeps a project whose market version is gone in the list, with a null market name', async () => {
    const orphan = await seedProject(testDb.db, owner.id, { marketProfileVersion: 99 });
    const list = await owner.agent.get('/api/projects');
    expect(list.status).toBe(200);
    expect(
      projectListResponseSchema.parse(list.body).projects.find((p) => p.id === orphan.id)?.market,
    ).toEqual({ id: 'nl', version: 99, name: null });
    // The detail needs the definition (form, readiness).
    expect((await owner.agent.get(`/api/projects/${orphan.id}`)).status).toBe(500);
  });
});

async function emailOf(userId: string): Promise<string> {
  const result = await testDb.db.execute<{ email: string }>(
    sql`select email from users where id = ${userId}`,
  );
  const email = result.rows[0]?.email;
  if (email === undefined) throw new Error('unknown user');
  return email;
}
