import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  transcriptArtifactContentSchema,
  type JsonObject,
  type ServiceDefinition,
} from '@evidomo/shared';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertArtifact,
  insertSingletonArtifact,
  listArtifacts,
} from '../../db/repositories/artifacts.ts';
import { addMaterial, setMaterialStatus, type Material } from '../../db/repositories/materials.ts';
import { deleteProject } from '../../db/repositories/projects.ts';
import { listRunEvents } from '../../db/repositories/run-events.ts';
import { createRunStep, listRunSteps } from '../../db/repositories/run-steps.ts';
import { getRun, transitionRun, type Run } from '../../db/repositories/runs.ts';
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
import { encodePcm16Wav } from '../../media/wav.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createMetaReplay, type MetaReplay } from '../../meta/replay.ts';
import { createRunEngine, type RunEngine, type StepJob } from '../../runs/engine.ts';
import type { StepJobData } from '../../runs/queue.ts';
import type { StepHandler } from '../../runs/steps.ts';
import { testRegistry, waitFor } from '../../runs/testing.ts';
import { createLocalStorage } from '../../storage/local.ts';
import { newMaterialStorageKey, type Storage } from '../../storage/storage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { createIntakeHandler } from './handler.ts';
import { buildTranscriptionKeywords } from './keywords.ts';
import {
  INTAKE_CASSETTE,
  intakeOnlyService,
  WALKTHROUGH_FACT_FORM,
  walkthroughIntakeStep,
  walkthroughMarket,
} from './testing.ts';

// The real intake handler inside the run engine, against PostgreSQL (Testcontainers), local
// storage, and the recorded Voice Transcribe response (fixtures/meta/p2-06). The stored memo is
// a generated 1-second silent WAV: the cassette matches the audio part by filename and type only,
// so it replays the walkthrough transcript (15 diarized turns, 168.8 s billed).

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let replay: MetaReplay;
let storage: Storage;
let storageDir: string;
let definitions: DefinitionRegistry;
let service: ServiceDefinition;
/** Lets a test hold the handler's result before it is committed (superseded-delivery test). */
let holdResult: ((runId: string, execution: number) => Promise<void>) | undefined;

async function seedProjectWithMemo(
  factForm: JsonObject = WALKTHROUGH_FACT_FORM,
): Promise<{ projectId: string; memo: Material }> {
  const user = await seedUser(testDb.db);
  const project = await seedProject(testDb.db, user.id, { factForm });
  const wav = encodePcm16Wav(new Int16Array(16_000), 16_000);
  const stored = await storage.put(newMaterialStorageKey(project.id, 'wav'), wav);
  const material = await addMaterial(testDb.db, {
    projectId: project.id,
    kind: 'voice_memo',
    storageKey: stored.key,
    mimeType: 'audio/wav',
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    status: 'processing',
  });
  const memo = await setMaterialStatus(testDb.db, material.id, 'ready', {
    durationMs: 1000,
    sampleRate: 16_000,
    sourceContainer: 'wav',
    sourceCodec: 'pcm_s16le',
  });
  return { projectId: project.id, memo };
}

async function seedIntakeRun(projectId: string): Promise<Run> {
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
  // The database container starts before MSW intercepts HTTP (Testcontainers talks to Docker
  // over HTTP), and stops after it.
  testDb = await startTestDatabase();
  definitions = await loadDefinitions();
  const step = walkthroughIntakeStep(definitions);
  service = intakeOnlyService(definitions, step);
  storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-p2-06-storage-'));
  storage = createLocalStorage({ rootDir: storageDir });

  replay = createMetaReplay({
    cassette: INTAKE_CASSETTE,
    mode: 'replay',
    match: { ignoreFileContentFields: ['audio'] },
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

  const intake = createIntakeHandler({ storage, markets: definitions });
  const handler: StepHandler<'intake'> = async (context) => {
    const result = await intake(context);
    await holdResult?.(context.run.id, context.execution);
    return result;
  };
  const estimateCost = createPriceTableCostEstimator();
  engine = createRunEngine({
    db: testDb.db,
    boss,
    registry: testRegistry(service),
    logger,
    dailyCapUsd: '5.00',
    handlers: { intake: handler },
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

describe('intake step', () => {
  it('stores the transcript as timed turns, meters the call, and reports a summary event', async () => {
    const { projectId, memo } = await seedProjectWithMemo();
    const run = await seedIntakeRun(projectId);

    await engine.startRun(run.id);
    await waitForStatus(run.id, 'completed');
    replay.assertAllMatched();

    const artifacts = await listArtifacts(testDb.db, run.id);
    expect(artifacts).toHaveLength(1);
    const [artifact] = artifacts;
    expect(artifact).toMatchObject({ stepId: 'intake', kind: 'transcript' });
    const content = transcriptArtifactContentSchema.parse(artifact?.content);
    expect(content).toMatchObject({
      schemaVersion: 1,
      materialId: memo.id,
      materialSha256: memo.sha256,
      model: 'muse-voice-transcribe-1.0',
      mode: 'DIARIZATION',
      audioDurationMs: 168_800,
      languageBias: ['Dutch', 'English'],
      maxTurnMs: 30_000,
    });
    expect(content.keywords).toEqual(
      buildTranscriptionKeywords({
        factForm: WALKTHROUGH_FACT_FORM,
        market: walkthroughMarket(definitions),
      }),
    );
    // The recorded DIARIZATION response: 15 turns of 2-16 s, none long enough to split.
    expect(content.turns).toHaveLength(15);
    expect(content.turns[0]).toMatchObject({
      index: 0,
      sourceTurnIndex: 0,
      speaker: 'A',
      startMs: 60,
      endMs: 10_940,
      timing: 'model',
    });
    expect(content.turns[0]?.text).toMatch(/^Goedemiddag/);
    expect(content.turns.at(-1)).toMatchObject({ index: 14, startMs: 157_340, endMs: 168_300 });
    expect(content.turns.every((turn) => turn.timing === 'model')).toBe(true);
    expect(content.turns.some((turn) => /NEN 2580/.test(turn.text))).toBe(true);

    const steps = await listRunSteps(testDb.db, run.id);
    expect(steps.map((s) => [s.stepId, s.status, s.executions, s.outputArtifactIds])).toEqual([
      ['intake', 'completed', 1, [artifact?.id]],
    ]);

    // 168.8 s at $0.00005 per second.
    const usage = await listUsageForRun(testDb.db, run.id);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      stepId: 'intake',
      modelId: 'muse-voice-transcribe-1.0',
      audioSeconds: '168.800',
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: '0.00844000',
    });

    const events = await listRunEvents(testDb.db, run.id);
    expect(events.map((e) => e.type)).toEqual([
      'run_status_changed',
      'step_started',
      'usage_recorded',
      'transcript_stored',
      'step_completed',
      'run_status_changed',
    ]);
    const summary = events.find((e) => e.type === 'transcript_stored');
    expect(summary?.payload).toEqual({
      stepId: 'intake',
      artifactId: artifact?.id,
      mode: 'DIARIZATION',
      audioDurationMs: 168_800,
      sourceTurnCount: 15,
      turnCount: 15,
      approximateTurnCount: 0,
      speakerCount: 1,
      keywordCount: content.keywords.length,
    });
    // No transcript text or keyword in any event.
    const serialized = JSON.stringify(events.map((e) => e.payload));
    expect(serialized).not.toMatch(/Goedemiddag|Kwartelhoflaan|Zandmeer/);

    // Text is personal data: deleting the project removes the transcript with it.
    await deleteProject(testDb.db, projectId);
    expect(await listArtifacts(testDb.db, run.id)).toEqual([]);
    expect(await listUsageForRun(testDb.db, run.id)).toEqual([]);
  });

  it('commits one transcript when a superseded execution finishes after its replacement', async () => {
    const { projectId } = await seedProjectWithMemo();
    const run = await seedIntakeRun(projectId);
    // An open attempt whose job exists only in the test, so no worker picks it up.
    await transitionRun(testDb.db, run.id, { to: 'running' });
    const jobId = randomUUID();
    const data: StepJobData = { runId: run.id, stepId: 'intake', attempt: 1 };
    await createRunStep(testDb.db, { ...data, jobId });
    const delivery = (retryCount: number): StepJob => ({
      id: jobId,
      retryCount,
      data,
      signal: new AbortController().signal,
    });

    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstHeld = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      firstHeld = resolve;
    });
    holdResult = async (runId, execution) => {
      if (runId !== run.id || execution !== 1) return;
      firstHeld();
      await released;
    };
    try {
      // Delivery 0 transcribes, then stalls before committing (e.g. its worker froze); pg-boss
      // re-delivers the job, and the retry transcribes again and completes the step.
      const stalled = engine.processStepJob(delivery(0));
      await held;
      expect(await engine.processStepJob(delivery(1))).toEqual({ outcome: 'completed' });
      release();
      expect(await stalled).toEqual({ outcome: 'superseded' });
    } finally {
      holdResult = undefined;
    }
    await waitForStatus(run.id, 'completed');

    const artifacts = await listArtifacts(testDb.db, run.id);
    expect(artifacts).toHaveLength(1);
    const events = await listRunEvents(testDb.db, run.id);
    expect(events.filter((e) => e.type === 'transcript_stored')).toHaveLength(1);
    // Both executions called the model, so both are billed.
    expect(await listUsageForRun(testDb.db, run.id)).toHaveLength(2);

    // A repeated commit keeps the first transcript (facts cite it by ID); the database refuses
    // a second transcript for the step outright.
    const again = await insertSingletonArtifact(testDb.db, {
      runId: run.id,
      stepId: 'intake',
      kind: 'transcript',
      content: { replaced: true },
    });
    expect(again).toEqual({ artifact: artifacts[0], created: false });
    await expect(
      insertArtifact(testDb.db, {
        runId: run.id,
        stepId: 'intake',
        kind: 'transcript',
        content: { duplicate: true },
      }),
    ).rejects.toThrow();
    expect(await listArtifacts(testDb.db, run.id)).toHaveLength(1);
  });

  it('fails the run without a model call when the project has no voice memo', async () => {
    const user = await seedUser(testDb.db);
    const project = await seedProject(testDb.db, user.id, { factForm: WALKTHROUGH_FACT_FORM });
    const run = await seedIntakeRun(project.id);

    await engine.startRun(run.id);
    const failed = await waitForStatus(run.id, 'failed');
    expect(failed.failureReason).toBe(
      'Step "intake" failed after 1 execution: The project has no processed voice memo to transcribe',
    );
    expect(await listUsageForRun(testDb.db, run.id)).toEqual([]);
    expect(await listArtifacts(testDb.db, run.id)).toEqual([]);
  });

  it('fails the run when the stored memo does not match its checksum', async () => {
    const { projectId, memo } = await seedProjectWithMemo();
    await storage.put(memo.storageKey, encodePcm16Wav(new Int16Array(8_000), 16_000));
    const run = await seedIntakeRun(projectId);

    await engine.startRun(run.id);
    const failed = await waitForStatus(run.id, 'failed');
    expect(failed.failureReason).toMatch(/does not match its recorded checksum$/);
    expect(await listUsageForRun(testDb.db, run.id)).toEqual([]);
  });
});
