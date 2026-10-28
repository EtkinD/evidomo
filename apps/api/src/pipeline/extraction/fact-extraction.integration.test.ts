import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  factsExtractedPayloadSchema,
  transcriptArtifactContentSchema,
  type JsonObject,
  type ServiceDefinition,
  type TranscriptArtifactContent,
} from '@evidomo/shared';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertArtifact,
  insertSingletonArtifact,
  listArtifacts,
} from '../../db/repositories/artifacts.ts';
import { listFacts, setFactStatus } from '../../db/repositories/facts.ts';
import { addMaterial, setMaterialStatus } from '../../db/repositories/materials.ts';
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
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { createRunEngine, type RunEngine, type StepJob } from '../../runs/engine.ts';
import type { StepJobData } from '../../runs/queue.ts';
import type { StepHandler } from '../../runs/steps.ts';
import { testRegistry, waitFor } from '../../runs/testing.ts';
import { createLocalStorage } from '../../storage/local.ts';
import { newMaterialStorageKey, type Storage } from '../../storage/storage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { createIntakeHandler } from '../intake/handler.ts';
import { WALKTHROUGH_FACT_FORM } from '../intake/testing.ts';
import { createFactExtractionHandler } from './handler.ts';
import { factExtractionReportSchema } from './schema.ts';
import {
  EXTRACTION_CASSETTE,
  EXTRACTION_INCLUDED_CASSETTES,
  EXTRACTION_MATCH,
  intakeAndExtractionService,
  replayWalkthroughTurns,
  walkthroughExtractionStep,
} from './testing.ts';

// Intake → fact extraction through the run engine, against PostgreSQL (Testcontainers), local
// storage, and the recorded responses: the P2-06 Voice Transcribe call (silent WAV, matched by
// filename) and the P2-07 Spark extraction over that transcript. No credit is spent.

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let replay: MetaReplay;
let storage: Storage;
let storageDir: string;
let definitions: DefinitionRegistry;
let pipeline: ServiceDefinition;
/** Fact extraction alone, for runs whose transcript the test inserts. */
let extractionOnly: ServiceDefinition;
let walkthroughTranscript: TranscriptArtifactContent;
let holdResult: ((runId: string, execution: number) => Promise<void>) | undefined;

async function seedProjectWithMemo(factForm: JsonObject = WALKTHROUGH_FACT_FORM): Promise<string> {
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
  await setMaterialStatus(testDb.db, material.id, 'ready', {
    durationMs: 1000,
    sampleRate: 16_000,
    sourceContainer: 'wav',
    sourceCodec: 'pcm_s16le',
  });
  return project.id;
}

async function seedPipelineRun(projectId: string, service: ServiceDefinition): Promise<Run> {
  return seedRun(testDb.db, projectId, {
    serviceId: service.id,
    serviceVersion: service.version,
    marketProfileId: 'nl',
    marketProfileVersion: 1,
  });
}

/** A run of `extractionOnly` whose intake transcript already exists. */
async function seedRunWithTranscript(
  factForm: JsonObject = WALKTHROUGH_FACT_FORM,
): Promise<{ run: Run; transcriptId: string }> {
  const user = await seedUser(testDb.db);
  const project = await seedProject(testDb.db, user.id, { factForm });
  const run = await seedPipelineRun(project.id, extractionOnly);
  const { artifact } = await insertSingletonArtifact(testDb.db, {
    runId: run.id,
    stepId: 'intake',
    kind: 'transcript',
    content: walkthroughTranscript,
  });
  return { run, transcriptId: artifact.id };
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
  pipeline = intakeAndExtractionService(definitions);
  extractionOnly = {
    ...pipeline,
    id: 'extraction-only',
    steps: [walkthroughExtractionStep(definitions)],
  };
  storageDir = await mkdtemp(path.join(tmpdir(), 'evidomo-p2-07-storage-'));
  storage = createLocalStorage({ rootDir: storageDir });

  replay = createMetaReplay({
    cassette: EXTRACTION_CASSETTE,
    include: EXTRACTION_INCLUDED_CASSETTES,
    mode: 'replay',
    match: EXTRACTION_MATCH,
  });
  await replay.start();

  // The transcript the intake step stores, for runs that start at fact extraction.
  const usage = createInMemoryUsageRecorder();
  const turns = await replayWalkthroughTurns(
    createMetaClients({ apiKey: replay.apiKey, usage, maxRetries: 0 }),
    usage,
    definitions,
  );
  walkthroughTranscript = transcriptArtifactContentSchema.parse({
    schemaVersion: 1,
    materialId: randomUUID(),
    materialSha256: '0'.repeat(64),
    model: 'muse-voice-transcribe-1.0',
    mode: 'DIARIZATION',
    sessionId: 'synthetic-session',
    audioDurationMs: 168_800,
    languageBias: ['Dutch', 'English'],
    keywords: [],
    maxTurnMs: 30_000,
    turns,
  } satisfies TranscriptArtifactContent);

  boss = new PgBoss({
    connectionString: testDb.container.getConnectionUri(),
    superviseIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
  });
  boss.on('error', (error) => {
    logger.error({ err: error }, 'pg-boss error in test');
  });
  await boss.start();

  const extract = createFactExtractionHandler({ markets: definitions });
  const extractor: StepHandler<'extractor'> = async (context) => {
    const result = await extract(context);
    await holdResult?.(context.run.id, context.execution);
    return result;
  };
  const estimateCost = createPriceTableCostEstimator();
  engine = createRunEngine({
    db: testDb.db,
    boss,
    registry: testRegistry(pipeline, extractionOnly),
    logger,
    dailyCapUsd: '5.00',
    handlers: { intake: createIntakeHandler({ storage, markets: definitions }), extractor },
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

describe('fact extraction step', () => {
  it('stores form and transcript candidates with provenance after intake, metered and summarized', async () => {
    const projectId = await seedProjectWithMemo();
    const run = await seedPipelineRun(projectId, pipeline);

    await engine.startRun(run.id);
    await waitForStatus(run.id, 'completed');
    replay.assertAllMatched();

    const [transcriptArtifact] = await listArtifacts(testDb.db, run.id, { kind: 'transcript' });
    const transcript = transcriptArtifactContentSchema.parse(transcriptArtifact?.content);
    const reports = await listArtifacts(testDb.db, run.id, { kind: 'fact_extraction' });
    expect(reports).toHaveLength(1);
    const [reportArtifact] = reports;
    expect(reportArtifact?.stepId).toBe('fact_extraction');
    const report = factExtractionReportSchema.parse(reportArtifact?.content);
    expect(report).toMatchObject({
      schemaVersion: 1,
      promptVersion: 1,
      transcriptArtifactId: transcriptArtifact?.id,
      model: 'muse-spark-1.3',
      reasoningEffort: 'low',
      maxOutputTokens: 14_000,
    });
    expect(report.counts.formFacts).toBe(7);
    expect(report.counts.modelFacts).toBe(report.counts.transcriptFacts + report.rejected.length);

    const facts = await listFacts(testDb.db, run.id);
    expect(facts.every((fact) => fact.status === 'candidate')).toBe(true);
    expect(facts.every((fact) => fact.stepId === 'fact_extraction')).toBe(true);
    const formFacts = facts.filter((fact) => fact.source.kind === 'form');
    const spoken = facts.filter((fact) => fact.source.kind === 'transcript_turn');
    expect(formFacts).toHaveLength(report.counts.formFacts);
    expect(spoken).toHaveLength(report.counts.transcriptFacts);
    expect(spoken.filter((fact) => fact.assertion === 'opinion')).toHaveLength(
      report.counts.opinionFacts,
    );

    // Form values: the field as reference, the profile's unit and basis, always `stated`.
    expect(formFacts.map((f) => [f.key, f.value, f.unit, f.basis, f.source, f.assertion])).toEqual(
      expect.arrayContaining([
        ['living_area', 92, 'm2', 'NEN2580', { kind: 'form', field: 'living_area' }, 'stated'],
        ['ground_lease', false, null, null, { kind: 'form', field: 'ground_lease' }, 'stated'],
        [
          'other:street_name',
          'Kwartelhoflaan',
          null,
          null,
          { kind: 'form', field: 'street_name' },
          'stated',
        ],
      ]),
    );

    // Transcript facts cite the stored transcript: turn index, its timestamps, a verbatim quote.
    for (const fact of spoken) {
      if (fact.source.kind !== 'transcript_turn') continue;
      const turn = transcript.turns[fact.source.turnIndex];
      expect(fact.source.transcriptArtifactId).toBe(transcriptArtifact?.id);
      expect([fact.source.startMs, fact.source.endMs]).toEqual([turn?.startMs, turn?.endMs]);
      expect(turn?.text).toContain(fact.source.quote);
    }
    // The planted inconsistency of the walkthrough survives as candidates for reconciliation:
    // 92 m2 (NEN 2580, turn 2) and "zo'n 95" m2 (no basis, the closing turn 14), both on the
    // profile's living_area key next to the form's 92.
    const livingArea = facts
      .filter((fact) => fact.key === 'living_area')
      .map((fact) => [
        fact.value,
        fact.basis,
        fact.source.kind === 'transcript_turn' ? fact.source.turnIndex : fact.source.kind,
      ]);
    expect(livingArea).toEqual(
      expect.arrayContaining([
        [92, 'NEN2580', 'form'],
        [92, 'NEN2580', 2],
        [95, 'unspecified', 14],
      ]),
    );

    const steps = await listRunSteps(testDb.db, run.id);
    expect(steps.map((s) => [s.stepId, s.status, s.executions, s.outputArtifactIds])).toEqual([
      ['intake', 'completed', 1, [transcriptArtifact?.id]],
      ['fact_extraction', 'completed', 1, [reportArtifact?.id]],
    ]);

    // One ledger row per call: 168.8 s of audio, then 2,092 in + 8,357 out on Spark.
    const usage = await listUsageForRun(testDb.db, run.id);
    expect(
      usage.map((u) => [u.stepId, u.modelId, u.inputTokens, u.outputTokens, u.estimatedCostUsd]),
    ).toEqual([
      ['intake', 'muse-voice-transcribe-1.0', 0, 0, '0.00844000'],
      ['fact_extraction', 'muse-spark-1.3', 2092, 8357, '0.03813225'],
    ]);
    expect(usage[1]?.reasoningTokens).toBe(3969);

    const events = await listRunEvents(testDb.db, run.id);
    expect(events.map((e) => e.type)).toEqual([
      'run_status_changed',
      'step_started',
      'usage_recorded',
      'transcript_stored',
      'step_completed',
      'step_started',
      'usage_recorded',
      'facts_extracted',
      'step_completed',
      'run_status_changed',
    ]);
    const summary = events.find((e) => e.type === 'facts_extracted');
    expect(factsExtractedPayloadSchema.parse(summary?.payload)).toEqual({
      stepId: 'fact_extraction',
      artifactId: reportArtifact?.id,
      formFactCount: 7,
      modelFactCount: report.counts.modelFacts,
      transcriptFactCount: report.counts.transcriptFacts,
      opinionCount: report.counts.opinionFacts,
      repairedCount: report.counts.repairedFacts,
      rejectedCount: report.rejected.length,
    });
    // No fact value, key, quote, or transcript text in any event.
    const serialized = JSON.stringify(events.map((e) => e.payload));
    expect(serialized).not.toMatch(/Kwartelhoflaan|Zandmeer|living_area|vierkante|NEN/);

    // Opinions stay candidates for context; the database refuses to verify one.
    const opinion = spoken.find((fact) => fact.assertion === 'opinion');
    expect(opinion).toBeDefined();
    await expect(
      setFactStatus(testDb.db, run.id, [opinion?.id ?? ''], 'verified'),
    ).rejects.toMatchObject({ cause: { constraint: 'facts_opinion_never_verified' } });

    // Facts are personal data: deleting the project removes them with the run.
    await deleteProject(testDb.db, projectId);
    expect(await listFacts(testDb.db, run.id)).toEqual([]);
  });

  it('commits one candidate set when a superseded execution finishes after its replacement', async () => {
    const { run } = await seedRunWithTranscript();
    // An open attempt whose job exists only in the test, so no worker picks it up.
    await transitionRun(testDb.db, run.id, { to: 'running' });
    const jobId = randomUUID();
    const data: StepJobData = { runId: run.id, stepId: 'fact_extraction', attempt: 1 };
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
      // Delivery 0 extracts, then stalls before committing; the re-delivery extracts again and
      // completes the step.
      const stalled = engine.processStepJob(delivery(0));
      await held;
      expect(await engine.processStepJob(delivery(1))).toEqual({ outcome: 'completed' });
      release();
      expect(await stalled).toEqual({ outcome: 'superseded' });
    } finally {
      holdResult = undefined;
    }
    await waitForStatus(run.id, 'completed');

    const reports = await listArtifacts(testDb.db, run.id, { kind: 'fact_extraction' });
    expect(reports).toHaveLength(1);
    const report = factExtractionReportSchema.parse(reports[0]?.content);
    const facts = await listFacts(testDb.db, run.id);
    expect(facts).toHaveLength(report.counts.formFacts + report.counts.transcriptFacts);
    const events = await listRunEvents(testDb.db, run.id);
    expect(events.filter((e) => e.type === 'facts_extracted')).toHaveLength(1);
    // Both executions called the model, so both are billed.
    expect(await listUsageForRun(testDb.db, run.id)).toHaveLength(2);

    // A repeated commit finds the report and adds no facts; the database refuses a second one.
    const again = await insertSingletonArtifact(testDb.db, {
      runId: run.id,
      stepId: 'fact_extraction',
      kind: 'fact_extraction',
      content: { replaced: true },
    });
    expect(again).toEqual({ artifact: reports[0], created: false });
    await expect(
      insertArtifact(testDb.db, {
        runId: run.id,
        stepId: 'fact_extraction',
        kind: 'fact_extraction',
        content: { duplicate: true },
      }),
    ).rejects.toMatchObject({ cause: { constraint: 'artifacts_singleton_kind_key' } });
    expect(await listFacts(testDb.db, run.id)).toHaveLength(facts.length);
  });

  it('fails the run without a model call when the run has no transcript', async () => {
    const user = await seedUser(testDb.db);
    const project = await seedProject(testDb.db, user.id, { factForm: WALKTHROUGH_FACT_FORM });
    const run = await seedPipelineRun(project.id, extractionOnly);

    await engine.startRun(run.id);
    const failed = await waitForStatus(run.id, 'failed');
    expect(failed.failureReason).toBe(
      'Step "fact_extraction" failed after 1 execution: The run has no transcript to extract facts from',
    );
    expect(await listUsageForRun(testDb.db, run.id)).toEqual([]);
    expect(await listFacts(testDb.db, run.id)).toEqual([]);
  });

  it('fails the run without a model call when the fact form does not match the profile', async () => {
    const { run } = await seedRunWithTranscript({ living_area: 'ninety-two' });

    await engine.startRun(run.id);
    const failed = await waitForStatus(run.id, 'failed');
    expect(failed.failureReason).toBe(
      'Step "fact_extraction" failed after 1 execution: The fact form does not match its market profile: missing required field(s): energy_label; invalid value for field(s): living_area',
    );
    expect(await listUsageForRun(testDb.db, run.id)).toEqual([]);
    expect(await listFacts(testDb.db, run.id)).toEqual([]);
  });
});
