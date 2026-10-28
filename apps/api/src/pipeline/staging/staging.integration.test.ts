import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  imagesStagedPayloadSchema,
  photoInventoryContentSchema,
  STAGED_IMAGE_LABEL,
  stagedImageContentSchema,
  stagedImagesContentSchema,
  type ServiceDefinition,
} from '@evidomo/shared';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listArtifacts } from '../../db/repositories/artifacts.ts';
import { addMaterial, setMaterialStatus } from '../../db/repositories/materials.ts';
import { deleteProject } from '../../db/repositories/projects.ts';
import { listRunEvents } from '../../db/repositories/run-events.ts';
import { listRunSteps } from '../../db/repositories/run-steps.ts';
import { getRun, type Run } from '../../db/repositories/runs.ts';
import { listUsageForRun } from '../../db/repositories/usage.ts';
import {
  seedProject,
  seedRun,
  seedUser,
  startTestDatabase,
  type TestDatabase,
} from '../../db/testing.ts';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createLogger } from '../../logger.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { imageDimensions } from '../../meta/images.ts';
import { createMetaReplay, type MetaReplay } from '../../meta/replay.ts';
import { createRunEngine, type RunEngine } from '../../runs/engine.ts';
import { testRegistry, waitFor } from '../../runs/testing.ts';
import { createLocalStorage } from '../../storage/local.ts';
import { newMaterialStorageKey, type Storage } from '../../storage/storage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { createVisionInventoryHandler } from '../vision/handler.ts';
import { readSampleBytes, SAMPLE_PHOTOS, type SamplePhoto } from '../vision/testing.ts';
import { createStagingHandler } from './handler.ts';
import { stagingOperation, stagingPrompt } from './operations.ts';
import {
  sampleStagingStep,
  STAGING_CASSETTE,
  STAGING_INCLUDED_CASSETTES,
  visionAndStagingService,
} from './testing.ts';

// The staging step through the run engine, after a real (replayed) vision inventory, against
// PostgreSQL (Testcontainers), local storage holding the six synthetic interiors, and the
// recorded edits (P3-04). No credit is spent.

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let replay: MetaReplay;
let storage: Storage;
let storageDir: string;
let definitions: DefinitionRegistry;
let service: ServiceDefinition;
let stagingOnly: ServiceDefinition;

async function seedProjectWithPhotos(): Promise<{
  projectId: string;
  materials: Map<SamplePhoto, { id: string; sha256: string }>;
}> {
  const user = await seedUser(testDb.db);
  const project = await seedProject(testDb.db, user.id);
  const materials = new Map<SamplePhoto, { id: string; sha256: string }>();
  for (const name of SAMPLE_PHOTOS) {
    const stored = await storage.put(
      newMaterialStorageKey(project.id, 'jpg'),
      await readSampleBytes(name),
    );
    const material = await addMaterial(testDb.db, {
      projectId: project.id,
      kind: 'photo',
      storageKey: stored.key,
      mimeType: 'image/jpeg',
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      status: 'processing',
    });
    await setMaterialStatus(testDb.db, material.id, 'ready', {
      width: 1024,
      height: 682,
      sourceFormat: 'jpeg',
      sourceWidth: 1024,
      sourceHeight: 682,
    });
    materials.set(name, { id: material.id, sha256: stored.sha256 });
  }
  return { projectId: project.id, materials };
}

async function readStored(key: string): Promise<Buffer> {
  const stream: Readable = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (!(chunk instanceof Buffer)) throw new Error('expected binary chunks');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function waitForStatus(runId: string, status: Run['status']): Promise<Run> {
  return waitFor(`run to be ${status}`, async () => {
    const run = await getRun(testDb.db, runId);
    return run?.status === status ? run : undefined;
  });
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  definitions = await loadDefinitions();
  service = visionAndStagingService(definitions);
  stagingOnly = { ...service, id: 'staging-only', steps: [sampleStagingStep(definitions)] };
  storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-p3-04-storage-'));
  storage = createLocalStorage({ rootDir: storageDir });

  replay = createMetaReplay({
    cassette: STAGING_CASSETTE,
    include: STAGING_INCLUDED_CASSETTES,
    mode: 'replay',
  });
  await replay.start();

  boss = new PgBoss({
    connectionString: testDb.container.getConnectionUri(),
    superviseIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
  });
  boss.on('error', (error) => {
    logger.error({ err: error }, 'pg-boss error in test');
  });
  await boss.start();

  const estimateCost = createPriceTableCostEstimator();
  engine = createRunEngine({
    db: testDb.db,
    boss,
    registry: testRegistry(service, stagingOnly),
    logger,
    dailyCapUsd: '5.00',
    handlers: {
      vision: createVisionInventoryHandler({ storage, markets: definitions }),
      stager: createStagingHandler({ storage }),
    },
    createMetaClients: (usage) =>
      createMetaClients({ apiKey: replay.apiKey, usage, estimateCost, maxRetries: 0 }),
    heartbeatSeconds: 10,
    expiryGraceSeconds: 5,
    retryDelaySeconds: 0,
  });
  await engine.startWorkers({ pollingIntervalSeconds: 0.5 });
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await replay?.stop();
  await testDb?.stop();
  if (storageDir !== undefined) await rm(storageDir, { recursive: true, force: true });
});

describe('staging step', () => {
  it('stores labeled staged images linked to their originals and a manifest for every photo', async () => {
    const { projectId, materials } = await seedProjectWithPhotos();
    const idOf = (name: SamplePhoto): string => materials.get(name)?.id ?? '';
    const run = await seedRun(testDb.db, projectId, {
      serviceId: service.id,
      serviceVersion: service.version,
      marketProfileId: 'nl',
      marketProfileVersion: 1,
    });

    await engine.startRun(run.id);
    await waitForStatus(run.id, 'completed');
    replay.assertAllMatched();

    const [inventory] = await listArtifacts(testDb.db, run.id, { kind: 'photo_inventory' });
    expect(photoInventoryContentSchema.safeParse(inventory?.content).success).toBe(true);

    // The manifest: one outcome per inventoried photo, in inventory (upload) order.
    const manifests = await listArtifacts(testDb.db, run.id, { kind: 'staged_images' });
    expect(manifests).toHaveLength(1);
    const [manifestArtifact] = manifests;
    const manifest = stagedImagesContentSchema.parse(manifestArtifact?.content);
    expect(manifest).toMatchObject({
      model: 'muse-image-1.0',
      maxStagedImages: 3,
      operationKinds: ['furnish', 'declutter'],
      inventoryArtifactId: inventory?.id,
      counts: { photos: 6, eligible: 5, requested: 3, staged: 3, failed: 0, skipped: 3 },
    });
    expect(
      manifest.photos.map((p) => [
        p.materialId,
        p.status,
        p.operationId,
        p.status === 'skipped' ? p.reason : null,
      ]),
    ).toEqual([
      [idOf('living-empty'), 'staged', 'furnish_living_room', null],
      [idOf('living-dining-cluttered'), 'skipped', 'declutter', 'cap_reached'],
      [idOf('kitchen-cluttered'), 'skipped', 'declutter', 'cap_reached'],
      [idOf('bedroom-empty'), 'staged', 'furnish_bedroom', null],
      [idOf('hallway'), 'skipped', null, 'not_stageable'],
      [idOf('dining-chairs'), 'staged', 'furnish_dining_room', null],
    ]);

    // Done when: every staged image is labeled and linked to its original.
    const staged = await listArtifacts(testDb.db, run.id, { kind: 'staged_image' });
    expect(staged).toHaveLength(3);
    for (const artifact of staged) {
      const entry = manifest.photos.find(
        (p) => p.status === 'staged' && p.stagedArtifactId === artifact.id,
      );
      if (entry?.status !== 'staged') throw new Error('staged image missing from the manifest');
      const content = stagedImageContentSchema.parse(artifact.content);
      const original = [...materials.values()].find((m) => m.id === entry.materialId);
      const operation = stagingOperation(entry.operationId);
      expect(content).toMatchObject({
        original: {
          materialId: entry.materialId,
          sha256: original?.sha256,
          width: 1024,
          height: 682,
        },
        operation,
        prompt: stagingPrompt(operation),
        model: 'muse-image-1.0',
        requestedSize: '1024x682',
        toolsDisabled: true,
        modelOutput: { format: 'jpeg' },
        disclosure: { label: STAGED_IMAGE_LABEL, visibleLabelRequired: true },
      });
      expect(content.aspectRatioChange).toBeLessThan(0.03);
      expect(artifact).toMatchObject({ stepId: 'staging', mimeType: 'image/jpeg' });
      expect(artifact.storageKey).toMatch(
        new RegExp(`^projects/${projectId}/runs/${run.id}/artifacts/[0-9a-f-]{36}\\.jpg$`),
      );
      const bytes = await readStored(artifact.storageKey ?? '');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(content.stored.sha256);
      expect(bytes.byteLength).toBe(content.stored.sizeBytes);
      expect(imageDimensions(bytes)).toEqual({
        format: 'jpeg',
        width: content.stored.width,
        height: content.stored.height,
      });
    }

    const steps = await listRunSteps(testDb.db, run.id);
    const stagingStep = steps.find((s) => s.stepId === 'staging');
    expect(stagingStep?.status).toBe('completed');
    expect([...(stagingStep?.outputArtifactIds ?? [])].sort()).toEqual(
      [manifestArtifact?.id, ...staged.map((a) => a.id)].sort(),
    );

    // One ledger row per edit, at the flat image price.
    const edits = (await listUsageForRun(testDb.db, run.id)).filter(
      (u) => u.modelId === 'muse-image-1.0',
    );
    expect(edits).toHaveLength(3);
    expect(
      edits.every(
        (u) => u.stepId === 'staging' && u.images === 1 && u.estimatedCostUsd === '0.01000000',
      ),
    ).toBe(true);

    const events = await listRunEvents(testDb.db, run.id);
    const summary = events.find((e) => e.type === 'images_staged');
    expect(imagesStagedPayloadSchema.parse(summary?.payload)).toEqual({
      stepId: 'staging',
      artifactId: manifestArtifact?.id,
      cap: 3,
      photoCount: 6,
      eligibleCount: 5,
      requestedCount: 3,
      stagedCount: 3,
      failedCount: 0,
      skippedCount: 3,
      privacySkippedCount: 0,
    });
    // Counts only: no subjects, operations, or prompt text in any event.
    const serialized = JSON.stringify(events.map((e) => e.payload));
    expect(serialized).not.toMatch(/furnish|declutter|sofa|living_room|bedroom|Edit this photo/);

    // Staged images derive from customer photos: deleting the project returns their files.
    const { storageKeys } = await deleteProject(testDb.db, projectId);
    for (const artifact of staged) expect(storageKeys).toContain(artifact.storageKey);
  });

  it('fails the run without a model call when there is no photo inventory', async () => {
    const user = await seedUser(testDb.db);
    const project = await seedProject(testDb.db, user.id);
    const run = await seedRun(testDb.db, project.id, {
      serviceId: stagingOnly.id,
      serviceVersion: stagingOnly.version,
      marketProfileId: 'nl',
      marketProfileVersion: 1,
    });

    await engine.startRun(run.id);
    const failed = await waitForStatus(run.id, 'failed');
    expect(failed.failureReason).toBe(
      'Step "staging" failed after 1 execution: Staging needs the photo inventory, and the run has none',
    );
    expect(await listUsageForRun(testDb.db, run.id)).toEqual([]);
  });
});
