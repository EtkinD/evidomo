import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  photoInventoryContentSchema,
  photosInventoriedPayloadSchema,
  type ServiceDefinition,
} from '@evidomo/shared';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listArtifacts } from '../../db/repositories/artifacts.ts';
import { listFacts } from '../../db/repositories/facts.ts';
import { addMaterial, listMaterials, setMaterialStatus } from '../../db/repositories/materials.ts';
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
import { createMetaReplay, type MetaReplay } from '../../meta/replay.ts';
import { createRunEngine, type RunEngine } from '../../runs/engine.ts';
import { testRegistry, waitFor } from '../../runs/testing.ts';
import { createLocalStorage } from '../../storage/local.ts';
import { newMaterialStorageKey, type Storage } from '../../storage/storage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { createVisionInventoryHandler } from './handler.ts';
import {
  readSampleBytes,
  SAMPLE_PHOTOS,
  VISION_CASSETTE,
  VISION_INCLUDED_CASSETTES,
  visionOnlyService,
} from './testing.ts';

// The vision inventory step through the run engine, against PostgreSQL (Testcontainers), local
// storage holding the six synthetic interiors, and the recorded responses (P2-08 plus the P1-05
// SAM cassettes it includes). No credit is spent.

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let replay: MetaReplay;
let storage: Storage;
let storageDir: string;
let definitions: DefinitionRegistry;
let service: ServiceDefinition;

/** A project whose photos are the samples, stored as the upload step would leave them. */
async function seedProjectWithPhotos(
  names: readonly (typeof SAMPLE_PHOTOS)[number][] = SAMPLE_PHOTOS,
): Promise<{ projectId: string; materialIds: string[] }> {
  const user = await seedUser(testDb.db);
  const project = await seedProject(testDb.db, user.id);
  const materialIds: string[] = [];
  for (const name of names) {
    const bytes = await readSampleBytes(name);
    const stored = await storage.put(newMaterialStorageKey(project.id, 'jpg'), bytes);
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
    materialIds.push(material.id);
  }
  return { projectId: project.id, materialIds };
}

async function seedVisionRun(projectId: string): Promise<Run> {
  return seedRun(testDb.db, projectId, {
    serviceId: service.id,
    serviceVersion: service.version,
    marketProfileId: 'nl',
    marketProfileVersion: 1,
  });
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
  service = visionOnlyService(definitions);
  storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-p2-08-storage-'));
  storage = createLocalStorage({ rootDir: storageDir });

  replay = createMetaReplay({
    cassette: VISION_CASSETTE,
    include: VISION_INCLUDED_CASSETTES,
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
    registry: testRegistry(service),
    logger,
    dailyCapUsd: '5.00',
    handlers: { vision: createVisionInventoryHandler({ storage, markets: definitions }) },
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

describe('vision inventory step', () => {
  it('stores the inventory, privacy checks, and photo facts, metered and summarized', async () => {
    const { projectId, materialIds } = await seedProjectWithPhotos();
    const run = await seedVisionRun(projectId);

    await engine.startRun(run.id);
    await waitForStatus(run.id, 'completed');
    replay.assertAllMatched();

    const artifacts = await listArtifacts(testDb.db, run.id, { kind: 'photo_inventory' });
    expect(artifacts).toHaveLength(1);
    const [artifact] = artifacts;
    const content = photoInventoryContentSchema.parse(artifact?.content);
    expect(content).toMatchObject({
      model: 'muse-spark-1.3',
      reasoningEffort: 'low',
      maxOutputTokens: 4000,
      segmentationModel: 'sam-3.1',
      privacyPhrases: ['person', 'license plate'],
    });

    // Done when: each photo has room/subject, quality, and cover rank; privacy masks for people
    // and plates were computed on every photo; evidence stays within the cap.
    expect(content.photos.map((p) => p.materialId)).toEqual(materialIds);
    const ranks = content.photos.map((p) =>
      p.classification.status === 'ok' ? p.classification.coverRank : 0,
    );
    expect([...ranks].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const photo of content.photos) {
      expect(photo.classification).toMatchObject({ status: 'ok' });
      expect(photo.privacy.status).toBe('clear');
      expect(photo.privacy.phrases.map((p) => [p.phrase, p.status])).toEqual([
        ['person', 'checked'],
        ['license plate', 'checked'],
      ]);
    }
    expect(content.evidence.requestCount).toBeLessThanOrEqual(12);
    expect(content.evidence.maskCount).toBeLessThanOrEqual(12);

    // Facts: one candidate per stored observation, citing the photo and, when segmented, the
    // inventory artifact that holds its masks.
    const facts = await listFacts(testDb.db, run.id);
    expect(facts).toHaveLength(content.counts.facts);
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect(fact).toMatchObject({
        stepId: 'vision_inventory',
        status: 'candidate',
        assertion: 'stated',
        unit: null,
        basis: null,
      });
      const source = fact.source;
      if (source.kind !== 'photo_region') throw new Error('expected a photo_region fact');
      expect(materialIds).toContain(source.materialId);
      const photo = content.photos.find((p) => p.materialId === source.materialId);
      const observation = photo?.observations.find((o) => o.key === fact.key);
      expect(observation?.factStored).toBe(true);
      expect(source.region).toEqual(observation?.region);
      if (observation?.evidence.status === 'segmented') {
        expect(source.maskArtifactId).toBe(artifact?.id);
        expect(fact.value).toBe(observation.evidence.instanceCount);
      } else {
        expect(source.maskArtifactId).toBeUndefined();
        expect(fact.value).toBe(observation?.modelCount);
      }
    }

    const steps = await listRunSteps(testDb.db, run.id);
    expect(steps.map((s) => [s.stepId, s.status, s.executions, s.outputArtifactIds])).toEqual([
      ['vision_inventory', 'completed', 1, [artifact?.id]],
    ]);

    // One ledger row per call: 6 Spark classifications, 12 privacy and the evidence requests.
    const usage = await listUsageForRun(testDb.db, run.id);
    const spark = usage.filter((u) => u.modelId === 'muse-spark-1.3');
    const sam = usage.filter((u) => u.modelId === 'sam-3.1');
    expect(spark).toHaveLength(6);
    expect(sam).toHaveLength(12 + content.evidence.requestCount);
    expect(sam.every((u) => u.images === 1 && u.estimatedCostUsd === '0.00250000')).toBe(true);

    const events = await listRunEvents(testDb.db, run.id);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'usage_recorded')).toHaveLength(usage.length);
    expect(types.filter((t) => t !== 'usage_recorded')).toEqual([
      'run_status_changed',
      'step_started',
      'photos_inventoried',
      'step_completed',
      'run_status_changed',
    ]);
    const summary = events.find((e) => e.type === 'photos_inventoried');
    expect(photosInventoriedPayloadSchema.parse(summary?.payload)).toEqual({
      stepId: 'vision_inventory',
      artifactId: artifact?.id,
      photoCount: 6,
      classifiedCount: 6,
      classificationFailedCount: 0,
      privacyClearCount: 6,
      privacyMaskedCount: 0,
      privacyReviewCount: 0,
      privacyFailedCount: 0,
      privacyRegionCount: 0,
      observationCount: content.counts.observations,
      evidenceRequestCount: content.evidence.requestCount,
      evidenceMaskCount: content.evidence.maskCount,
      factCount: facts.length,
    });
    // No subjects, summaries, or object names in any event.
    const serialized = JSON.stringify(events.map((e) => e.payload));
    expect(serialized).not.toMatch(/kitchen|bedroom|window|radiator|living_room|other:/);

    // Inventory and facts describe the property: deleting the project removes them.
    await deleteProject(testDb.db, projectId);
    expect(await listFacts(testDb.db, run.id)).toEqual([]);
  });

  it('fails the run without a model call when the project has no photos', async () => {
    const user = await seedUser(testDb.db);
    const project = await seedProject(testDb.db, user.id);
    const run = await seedVisionRun(project.id);

    await engine.startRun(run.id);
    const failed = await waitForStatus(run.id, 'failed');
    expect(failed.failureReason).toBe(
      'Step "vision_inventory" failed after 1 execution: The project has no processed photos to inventory',
    );
    expect(await listUsageForRun(testDb.db, run.id)).toEqual([]);
  });

  it('fails the run without a model call when a stored photo does not match its checksum', async () => {
    const { projectId } = await seedProjectWithPhotos(['living-empty', 'hallway']);
    const [, second] = await listMaterials(testDb.db, projectId, { kind: 'photo' });
    if (second === undefined) throw new Error('expected two materials');
    await storage.put(second.storageKey, await readSampleBytes('kitchen-cluttered'));
    const run = await seedVisionRun(projectId);

    await engine.startRun(run.id);
    const failed = await waitForStatus(run.id, 'failed');
    expect(failed.failureReason).toBe(
      'Step "vision_inventory" failed after 1 execution: A stored photo does not match its recorded checksum',
    );
    expect(await listUsageForRun(testDb.db, run.id)).toEqual([]);
  });
});
