import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRun } from '../db/repositories/runs.ts';
import { createUser } from '../db/repositories/users.ts';
import { startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { loadDefinitions, type DefinitionRegistry } from '../definitions/loader.ts';
import { createFactConflictsGate } from '../gates/fact-conflicts.ts';
import { createLogger } from '../logger.ts';
import { cassettePath, META_FIXTURES_DIR } from '../meta/fixtures.ts';
import { createRunEngine } from '../runs/engine.ts';
import { REPLAY_MISS_REASON } from '../runs/steps.ts';
import { waitFor } from '../runs/testing.ts';
import { createLocalStorage } from '../storage/local.ts';
import type { Storage } from '../storage/storage.ts';
import { planFactConflictDecisions } from './decisions.ts';
import { DevSeedError, seedDevRun, type DevSeedResult, type DevStopPoint } from './dev-seed-run.ts';
import { loadProject, projectFileSchema } from './project.ts';
import {
  pathFromDecisions,
  pathId,
  recordedPathsFile,
  recordGate1,
  snapshotConflicts,
} from './recorded-paths.ts';
import { startReplayWorker } from './replay-worker.ts';

// Recorded Gate 1 paths with the development seed and replay worker (docs/architecture.md §5
// "Development seed"), on the committed synthetic project only: a project whose cassette lives in
// a directory outside fixtures/meta (as raw-sample recordings must), the paths file next to it,
// seeding by a recorded path, refusing an unrecorded one, and an unrecorded Gate 1 decision
// failing the next step at once with the replay's reason and zero live calls. Needs Docker and
// ffmpeg.

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const DEMO_PROJECT = path.join(REPO_ROOT, 'fixtures/projects/synthetic-walkthrough');
const DEMO_CASSETTE = 'p3-10/synthetic-walkthrough';
const logger = createLogger({ LOG_LEVEL: 'error', NODE_ENV: 'test' });
const OWNER_EMAIL = 'dev-seed-paths@example.test';
const RUN_TIMEOUT_MS = 280_000;

let testDb: TestDatabase;
let storage: Storage;
let storageDir: string;
let scratch: string;
let externalProject: string;
let externalCassetteFile: string;
let definitions: DefinitionRegistry;
let ownerId: string;
let connectionString: string;

function seed(
  projectDir: string,
  stopAt: DevStopPoint,
  pathOption?: string,
): Promise<DevSeedResult> {
  return seedDevRun({
    projectDir,
    ownerEmail: OWNER_EMAIL,
    stopAt,
    ...(pathOption === undefined ? {} : { path: pathOption }),
    db: testDb.db,
    connectionString,
    storage,
    logger,
    progress: () => undefined,
    nodeEnv: 'test',
  });
}

function expectNoLiveCalls(result: DevSeedResult): void {
  expect(result.liveRequests).toBe(0);
  expect(result.calls).toBeGreaterThan(0);
  expect(result.servedFromCassette).toBe(result.calls);
}

/**
 * The synthetic project as an external project directory: its inputs referenced in place, its
 * cassette copied to `<scratch>/recordings/` (outside fixtures/meta) and named `run`.
 */
async function makeExternalProject(): Promise<void> {
  const recordings = path.join(scratch, 'recordings');
  externalProject = path.join(scratch, 'project');
  await mkdir(externalProject, { recursive: true });
  const source = cassettePath(DEMO_CASSETTE);
  externalCassetteFile = cassettePath('run', recordings);
  await mkdir(recordings, { recursive: true });
  await cp(source, externalCassetteFile);
  await cp(source.replace(/\.json$/, '.files'), externalCassetteFile.replace(/\.json$/, '.files'), {
    recursive: true,
  });
  const spec = projectFileSchema.parse(
    JSON.parse(await readFile(path.join(DEMO_PROJECT, 'project.json'), 'utf8')),
  );
  const relocate = (file: string): string =>
    path.relative(externalProject, path.resolve(DEMO_PROJECT, file));
  await writeFile(
    path.join(externalProject, 'project.json'),
    JSON.stringify({
      ...spec,
      photos: spec.photos.map(relocate),
      voiceMemo: spec.voiceMemo === null ? null : relocate(spec.voiceMemo),
      fixtureDir: path.relative(externalProject, recordings),
      fixture: 'run',
    }),
  );
  await cp(path.join(DEMO_PROJECT, 'decisions.json'), path.join(externalProject, 'decisions.json'));
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  connectionString = testDb.container.getConnectionUri();
  scratch = await mkdtemp(path.join(tmpdir(), 'evidomo-dev-seed-paths-'));
  storageDir = path.join(scratch, 'storage');
  storage = createLocalStorage({ rootDir: storageDir });
  definitions = await loadDefinitions();
  ownerId = (await createUser(testDb.db, { email: OWNER_EMAIL, passwordHash: 'not-a-real-hash' }))
    .id;
  await makeExternalProject();
});

afterAll(async () => {
  await testDb?.stop();
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

describe('dev:seed with a cassette outside fixtures/meta and recorded Gate 1 paths', () => {
  let defaultId: string;

  it(
    'seeds from the external cassette; without a paths file it prints the scripted decisions',
    async () => {
      expect(path.relative(META_FIXTURES_DIR, externalCassetteFile).startsWith('..')).toBe(true);
      const gate1 = await seed(externalProject, 'gate1');
      expectNoLiveCalls(gate1);
      expect(gate1.recordedPaths).toBeNull();
      expect(gate1.path).toBeNull();
      expect(gate1.stopped?.gate).toBe('fact_conflicts');

      // Record the run's own Gate 1 path into the paths file, as a record session does.
      const gate = await createFactConflictsGate({
        db: testDb.db,
        engine: { resumeAfterGate: () => Promise.reject(new Error('read-only here')) },
        markets: definitions,
      }).get(ownerId, gate1.runId);
      const project = await loadProject(externalProject, definitions, (id, version) =>
        definitions.getService(id, version),
      );
      const applied = planFactConflictDecisions(gate, project.decisions.factConflicts).decisions;
      const entries = pathFromDecisions(gate.conflicts, applied);
      if (entries === null) throw new Error('the synthetic decisions have no edit');
      const conflicts = snapshotConflicts(gate.conflicts);
      defaultId = pathId(conflicts, entries);
      await recordGate1({
        file: recordedPathsFile(externalCassetteFile),
        cassette: 'run',
        conflicts,
        path: {
          decisions: entries,
          fromProjectDecisions: true,
          recordedAt: new Date().toISOString(),
          liveRequests: 0,
        },
      });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'lists the recorded paths at Gate 1 and completes by the default path',
    async () => {
      const gate1 = await seed(externalProject, 'gate1');
      expect(gate1.recordedPaths?.paths.map((p) => p.id)).toEqual([defaultId]);

      const completed = await seed(externalProject, 'completed');
      expectNoLiveCalls(completed);
      expect(completed.status).toBe('completed');
      expect(completed.path).toBe(defaultId);

      const byId = await seed(externalProject, 'gate2', defaultId);
      expectNoLiveCalls(byId);
      expect(byId.gate).toBe('claim_audit');
      expect(byId.path).toBe(defaultId);
    },
    RUN_TIMEOUT_MS * 2,
  );

  it('refuses a path that was not recorded, and --path at gate1, before running anything', async () => {
    const unrecorded = defaultId === 'x-x-x' ? '1-x-x' : 'x-x-x';
    await expect(seed(externalProject, 'gate2', unrecorded)).rejects.toThrow(
      new RegExp(`Gate 1 path "${unrecorded}" was not recorded; recorded paths: ${defaultId}`),
    );
    await expect(seed(externalProject, 'gate1', defaultId)).rejects.toBeInstanceOf(DevSeedError);
    await expect(seed(DEMO_PROJECT, 'completed', defaultId)).rejects.toThrow(
      /--path needs recorded Gate 1 paths/,
    );
  });
});

describe('dev:worker:replay on an unrecorded Gate 1 path', () => {
  it(
    'fails the next step at once, not retried, with the replay reason and zero live calls',
    async () => {
      const gate1 = await seed(DEMO_PROJECT, 'gate1');
      const apiBoss = new PgBoss({ connectionString, supervise: false, schedule: false });
      await apiBoss.start();
      const engine = createRunEngine({
        db: testDb.db,
        boss: apiBoss,
        registry: definitions,
        logger,
        dailyCapUsd: '5.00',
      });
      const factGate = createFactConflictsGate({ db: testDb.db, engine, markets: definitions });
      const worker = await startReplayWorker({
        env: {
          DATABASE_URL: connectionString,
          STORAGE_DIR: storageDir,
          DEFINITIONS_DIR: undefined,
        },
        projectDir: DEMO_PROJECT,
        storage,
        logger,
        nodeEnv: 'test',
      });
      try {
        // Reject every side of every conflict: the recording decided otherwise.
        const open = await factGate.get(ownerId, gate1.runId);
        for (const conflict of open.conflicts) {
          await factGate.decide(ownerId, gate1.runId, conflict.id, { choice: 'reject' });
        }
        const failed = await waitFor(
          'the run to fail',
          async () => {
            const run = await getRun(testDb.db, gate1.runId);
            return run?.status === 'failed' ? run : undefined;
          },
          { timeoutMs: RUN_TIMEOUT_MS - 20_000, intervalMs: 500 },
        );
        expect(failed.failureReason).toBe(
          `Step "creative" failed after 1 execution: ${REPLAY_MISS_REASON}`,
        );
        const executions = await testDb.db.execute<{ executions: number }>(
          sql`select executions from run_steps where run_id = ${gate1.runId} and step_id = 'creative'`,
        );
        expect(executions.rows.map((row) => Number(row.executions))).toEqual([1]);
        expect(worker.replay.liveRequestCount).toBe(0);
        // The primary call only: no fallback was tried on a replay miss.
        expect(worker.replay.unmatched).toHaveLength(1);
      } finally {
        await worker.shutdown();
        await apiBoss.stop({ graceful: false });
      }
    },
    RUN_TIMEOUT_MS,
  );
});
