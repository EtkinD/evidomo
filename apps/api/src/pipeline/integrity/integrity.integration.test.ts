import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  integrityCheckedPayloadSchema,
  integrityChecksContentSchema,
  STAGED_IMAGE_ARTIFACT_KIND,
  STAGED_IMAGES_ARTIFACT_KIND,
  stagedImageContentSchema,
  stagedImagesContentSchema,
  type ServiceDefinition,
  type StagingOperationId,
} from '@evidomo/shared';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertArtifact, listArtifacts } from '../../db/repositories/artifacts.ts';
import { addMaterial, setMaterialStatus } from '../../db/repositories/materials.ts';
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
import type { StepHandler } from '../../runs/steps.ts';
import { testRegistry, waitFor } from '../../runs/testing.ts';
import { createLocalStorage } from '../../storage/local.ts';
import {
  newMaterialStorageKey,
  newRunArtifactStorageKey,
  type Storage,
} from '../../storage/storage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { stagedImageContent } from '../staging/handler.ts';
import { sampleStagingStep } from '../staging/testing.ts';
import type { Restage } from './check.ts';
import { createIntegrityHandler } from './handler.ts';
import {
  draftFromImage,
  INTEGRITY_CASSETTE,
  INTEGRITY_INCLUDED_CASSETTES,
  readSampleImage,
  sampleIntegrityStep,
  sha256,
  type SampleEdit,
  type SampleOriginal,
} from './testing.ts';

// The integrity step through the run engine against PostgreSQL (Testcontainers) and local
// storage. A stand-in staging step stores committed synthetic edits as `staged_image`
// artifacts (the real step's re-encoded output could not key a SAM fixture on every platform,
// see testing.ts), and the retry returns committed images through the same seam. Every SAM call
// replays from the P1-05 and P3-05 recordings; no credit is spent.

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let replay: MetaReplay;
let storage: Storage;
let storageDir: string;
let definitions: DefinitionRegistry;
let service: ServiceDefinition;

interface StagedSpec {
  readonly original: SampleOriginal;
  readonly edit: SampleEdit;
  readonly operation: StagingOperationId;
  /** What the retry edit returns (omit: the photo must not be retried). */
  readonly retry?: SampleEdit;
}

/** Per run: the photos the stand-in staging step stores, with their material IDs. */
const scenarios = new Map<
  string,
  { readonly specs: readonly StagedSpec[]; readonly ids: ReadonlyMap<SampleOriginal, string> }
>();
/** Per material: what the retry returns. */
const retries = new Map<string, SampleEdit>();

const fakeStaging: StepHandler<'stager'> = async (ctx) => {
  const scenario = scenarios.get(ctx.run.id);
  if (scenario === undefined) throw new Error('no scenario for this run');
  const drafts = await Promise.all(
    scenario.specs.map(async (spec) => {
      const materialId = scenario.ids.get(spec.original) ?? '';
      const original = await readSampleImage(spec.original);
      const draft = draftFromImage(
        { materialId, width: 1024, height: 682 },
        spec.operation,
        await readSampleImage(spec.edit),
      );
      const stored = await storage.put(
        newRunArtifactStorageKey(ctx.run.projectId, ctx.run.id, 'jpg'),
        draft.encoded.bytes,
      );
      const sha = sha256(original);
      return { spec, materialId, draft, stored, sha };
    }),
  );
  return {
    async commit(tx) {
      const staged = [];
      for (const { materialId, draft, stored, sha } of drafts) {
        const artifact = await insertArtifact(tx, {
          runId: ctx.run.id,
          stepId: ctx.step.id,
          kind: STAGED_IMAGE_ARTIFACT_KIND,
          content: stagedImageContent(
            { materialId, sha256: sha, width: 1024, height: 682 },
            { draft, stored },
            'muse-image-1.0',
          ),
          file: { storageKey: stored.key, mimeType: 'image/jpeg' },
        });
        staged.push({
          status: 'staged' as const,
          materialId,
          operationId: draft.operation.id,
          stagedArtifactId: artifact.id,
        });
      }
      const manifest = await insertArtifact(tx, {
        runId: ctx.run.id,
        stepId: ctx.step.id,
        kind: STAGED_IMAGES_ARTIFACT_KIND,
        content: stagedImagesContentSchema.parse({
          schemaVersion: 1,
          promptVersion: 1,
          model: 'muse-image-1.0',
          maxStagedImages: 3,
          operationKinds: ['furnish', 'declutter'],
          inventoryArtifactId: randomUUID(),
          counts: {
            photos: staged.length,
            eligible: staged.length,
            requested: staged.length,
            staged: staged.length,
            failed: 0,
            skipped: 0,
          },
          photos: staged,
        }),
      });
      return { artifactIds: [manifest.id] };
    },
  };
};

/** The retry: one metered "edit" that returns a committed image. */
const fakeRestage: Restage = async (deps, settings, photo, operationId) => {
  const edit = retries.get(photo.materialId);
  if (edit === undefined) throw new Error('unexpected retry');
  const bytes = await readSampleImage(edit);
  return deps.meter(settings.imageModel, () => {
    deps.clients.recordUsage({
      sdk: 'openai',
      modelId: settings.imageModel,
      inputTokens: undefined,
      cachedInputTokens: undefined,
      outputTokens: undefined,
      reasoningTokens: undefined,
      totalTokens: undefined,
      responseId: undefined,
      latencyMs: 1,
      images: 1,
    });
    return Promise.resolve({ ok: true, value: draftFromImage(photo, operationId, bytes) });
  });
};

async function seedScenario(
  specs: readonly StagedSpec[],
): Promise<{ run: Awaited<ReturnType<typeof seedRun>>; ids: Map<SampleOriginal, string> }> {
  const user = await seedUser(testDb.db);
  const project = await seedProject(testDb.db, user.id);
  const ids = new Map<SampleOriginal, string>();
  for (const spec of specs) {
    const stored = await storage.put(
      newMaterialStorageKey(project.id, 'jpg'),
      await readSampleImage(spec.original),
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
    ids.set(spec.original, material.id);
    if (spec.retry !== undefined) retries.set(material.id, spec.retry);
  }
  const run = await seedRun(testDb.db, project.id, {
    serviceId: service.id,
    serviceVersion: service.version,
    marketProfileId: 'nl',
    marketProfileVersion: 1,
  });
  scenarios.set(run.id, { specs, ids });
  return { run, ids };
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
  const base = definitions.getService('listing-launch', 1);
  service = {
    ...base,
    id: 'staging-and-integrity',
    steps: [sampleStagingStep(definitions), sampleIntegrityStep(definitions)],
  };
  storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-p3-05-storage-'));
  storage = createLocalStorage({ rootDir: storageDir });

  replay = createMetaReplay({
    cassette: INTEGRITY_CASSETTE,
    include: INTEGRITY_INCLUDED_CASSETTES,
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
    handlers: {
      stager: fakeStaging,
      integrity_checker: createIntegrityHandler({ storage, restage: fakeRestage }),
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

describe('integrity step', () => {
  it('passes valid edits, retries a structure-altering one once, and names the final images', async () => {
    const { run, ids } = await seedScenario([
      {
        original: 'living-empty',
        edit: 'living-empty.edit-remove-window',
        operation: 'furnish_living_room',
        retry: 'living-empty.edit-add-sofa',
      },
      {
        original: 'bedroom-empty',
        edit: 'bedroom-empty.edit-add-bed',
        operation: 'furnish_bedroom',
      },
      {
        original: 'dining-chairs',
        edit: 'dining-chairs.edit-replace-chairs',
        operation: 'furnish_dining_room',
      },
    ]);
    await engine.startRun(run.id);
    await waitForStatus(run.id, 'completed');
    replay.assertAllMatched();

    const firstImages = await listArtifacts(testDb.db, run.id, {
      kind: STAGED_IMAGE_ARTIFACT_KIND,
      stepId: 'staging',
    });
    const retryImages = await listArtifacts(testDb.db, run.id, {
      kind: STAGED_IMAGE_ARTIFACT_KIND,
      stepId: 'integrity',
    });
    expect(retryImages).toHaveLength(1);
    const [retryImage] = retryImages;
    expect(stagedImageContentSchema.parse(retryImage?.content)).toMatchObject({
      original: { materialId: ids.get('living-empty'), width: 1024, height: 682 },
      operation: { id: 'furnish_living_room' },
      model: 'muse-image-1.0',
    });

    const reports = await listArtifacts(testDb.db, run.id, { kind: 'integrity_checks' });
    expect(reports).toHaveLength(1);
    const [reportArtifact] = reports;
    const report = integrityChecksContentSchema.parse(reportArtifact?.content);
    expect(report).toMatchObject({
      segmentationModel: 'sam-3.1',
      editPrivacyPhrases: ['person'],
      thresholds: { minIoU: 0.75, minContainment: 0.85, minAreaRatio: 0.4 },
      counts: {
        photos: 3,
        passed: 2,
        passedOnRetry: 1,
        fallbackOriginal: 0,
        retries: 1,
        unchecked: 0,
      },
    });
    const firstOf = (original: SampleOriginal): string | undefined =>
      firstImages.find(
        (a) => stagedImageContentSchema.parse(a.content).original.materialId === ids.get(original),
      )?.id;
    expect(report.photos.map((p) => [p.materialId, p.outcome, p.finalStagedArtifactId])).toEqual([
      [ids.get('living-empty'), 'passed_on_retry', retryImage?.id],
      [ids.get('bedroom-empty'), 'passed', firstOf('bedroom-empty')],
      [ids.get('dining-chairs'), 'passed', firstOf('dining-chairs')],
    ]);
    const living = report.photos[0];
    const [first, second] = living?.attempts ?? [];
    if (first?.status !== 'checked' || second?.status !== 'checked') throw new Error('unchecked');
    expect(first).toMatchObject({
      stagedArtifactId: firstOf('living-empty'),
      passed: false,
      verdict: { failedClasses: ['window'] },
    });
    expect(second).toMatchObject({ attempt: 2, stagedArtifactId: retryImage?.id, passed: true });
    expect(living?.original?.segments['window']).toHaveLength(1);

    const steps = await listRunSteps(testDb.db, run.id);
    const integrity = steps.find((s) => s.stepId === 'integrity');
    expect(integrity?.status).toBe('completed');
    expect([...(integrity?.outputArtifactIds ?? [])].sort()).toEqual(
      [reportArtifact?.id, retryImage?.id].sort(),
    );

    // 3 photos × (3 + 4) SAM calls, plus the retry's 4 and its one edit.
    const rows = (await listUsageForRun(testDb.db, run.id)).filter((u) => u.stepId === 'integrity');
    expect(rows.filter((u) => u.modelId === 'sam-3.1')).toHaveLength(25);
    expect(rows.filter((u) => u.modelId === 'muse-image-1.0')).toHaveLength(1);

    const events = await listRunEvents(testDb.db, run.id);
    const summary = events.find((e) => e.type === 'integrity_checked');
    expect(integrityCheckedPayloadSchema.parse(summary?.payload)).toEqual({
      stepId: 'integrity',
      artifactId: reportArtifact?.id,
      photoCount: 3,
      passedCount: 2,
      passedOnRetryCount: 1,
      fallbackCount: 0,
      retryCount: 1,
      uncheckedCount: 0,
    });
    expect(JSON.stringify(summary?.payload)).not.toMatch(/window|person|furnish/);
  });

  it('falls back to the original when the retry fails as well', async () => {
    const { run } = await seedScenario([
      {
        original: 'living-empty',
        edit: 'living-empty.edit-remove-window',
        operation: 'furnish_living_room',
        retry: 'living-empty.edit-remove-window',
      },
    ]);
    await engine.startRun(run.id);
    await waitForStatus(run.id, 'completed');
    replay.assertAllMatched();

    const [reportArtifact] = await listArtifacts(testDb.db, run.id, { kind: 'integrity_checks' });
    const report = integrityChecksContentSchema.parse(reportArtifact?.content);
    expect(report.counts).toMatchObject({ passedOnRetry: 0, fallbackOriginal: 1, retries: 1 });
    const [photo] = report.photos;
    expect(photo).toMatchObject({ outcome: 'fallback_original', finalStagedArtifactId: null });
    expect(photo?.attempts.map((a) => a.status === 'checked' && a.passed)).toEqual([false, false]);
    // The failed retry stays stored for Gate 2 to show, but is never final.
    const retryImages = await listArtifacts(testDb.db, run.id, {
      kind: STAGED_IMAGE_ARTIFACT_KIND,
      stepId: 'integrity',
    });
    expect(retryImages).toHaveLength(1);
    expect(photo?.attempts[1]).toMatchObject({ stagedArtifactId: retryImages[0]?.id });
  });

  it('completes without a model call when nothing was staged', async () => {
    const { run } = await seedScenario([]);
    await engine.startRun(run.id);
    await waitForStatus(run.id, 'completed');
    const [reportArtifact] = await listArtifacts(testDb.db, run.id, { kind: 'integrity_checks' });
    expect(integrityChecksContentSchema.parse(reportArtifact?.content).photos).toEqual([]);
    expect(await listUsageForRun(testDb.db, run.id)).toEqual([]);
  });
});
