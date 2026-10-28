import { randomUUID } from 'node:crypto';
import {
  FACT_CONFLICTS_ARTIFACT_KIND,
  PHOTO_INVENTORY_ARTIFACT_KIND,
  VERIFIED_FACT_SHEET_ARTIFACT_KIND,
  factConflictsContentSchema,
  factsReconciledPayloadSchema,
  transcriptArtifactContentSchema,
  verifiedFactSheetContentSchema,
  type JsonObject,
  type ServiceDefinition,
  type TranscriptArtifactContent,
} from '@evidomo/shared';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  insertArtifact,
  insertSingletonArtifact,
  listArtifacts,
} from '../../db/repositories/artifacts.ts';
import { insertFacts, listFacts, type NewFact } from '../../db/repositories/facts.ts';
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
import { createMetaClients } from '../../meta/clients.ts';
import { createMetaReplay, type MetaReplay } from '../../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { createRunEngine, type RunEngine, type StepJob } from '../../runs/engine.ts';
import type { StepJobData } from '../../runs/queue.ts';
import type { StepHandler } from '../../runs/steps.ts';
import { testRegistry, waitFor } from '../../runs/testing.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { WALKTHROUGH_FACT_FORM } from '../intake/testing.ts';
import { createReconciliationHandler } from './handler.ts';
import type { ReconciliationStepOutput } from './schema.ts';
import {
  RECONCILIATION_CASSETTE,
  RECONCILIATION_INCLUDED_CASSETTES,
  RECONCILIATION_MATCH,
  reconciliationService,
  replayRecordedCandidates,
  type RecordedCandidates,
} from './testing.ts';

// Reconciliation through the run engine, against PostgreSQL (Testcontainers) and the recorded
// Wonder answer over the recorded P2-07/P2-08 candidates; the gate-release and fallback cases
// stub the Meta API instead (no spend). The earlier steps' outputs are inserted directly, exactly
// as those steps store them.

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });
const PLACEHOLDER_TRANSCRIPT_ID = randomUUID();
const PLACEHOLDER_INVENTORY_ID = randomUUID();

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let replay: MetaReplay;
let definitions: DefinitionRegistry;
let service: ServiceDefinition;
let recorded: RecordedCandidates;
let transcriptContent: TranscriptArtifactContent;
const exported: string[] = [];
let holdResult: ((runId: string, execution: number) => Promise<void>) | undefined;

/** The previous steps' outputs for one run: transcript, inventory, and candidate facts. */
async function seedReconciliationRun(
  change: (fact: NewFact) => NewFact = (fact) => fact,
  factForm: JsonObject = WALKTHROUGH_FACT_FORM,
): Promise<Run> {
  const user = await seedUser(testDb.db);
  const project = await seedProject(testDb.db, user.id, { factForm });
  const run = await seedRun(testDb.db, project.id, {
    serviceId: service.id,
    serviceVersion: service.version,
    marketProfileId: 'nl',
    marketProfileVersion: 1,
  });
  const { artifact: transcript } = await insertSingletonArtifact(testDb.db, {
    runId: run.id,
    stepId: 'intake',
    kind: 'transcript',
    content: transcriptContent,
  });
  const inventory = await insertArtifact(testDb.db, {
    runId: run.id,
    stepId: 'vision_inventory',
    kind: PHOTO_INVENTORY_ARTIFACT_KIND,
    content: recorded.inventory,
  });
  const facts = recorded.facts.map((fact): NewFact => {
    const { source } = fact;
    if (source.kind === 'transcript_turn') {
      return change({ ...fact, source: { ...source, transcriptArtifactId: transcript.id } });
    }
    if (source.kind === 'photo_region' && source.maskArtifactId !== undefined) {
      return change({ ...fact, source: { ...source, maskArtifactId: inventory.id } });
    }
    return change(fact);
  });
  await insertFacts(testDb.db, run.id, facts);
  return run;
}

async function waitForStatus(runId: string, status: Run['status']): Promise<Run> {
  return waitFor(`run to be ${status}`, async () => {
    const run = await getRun(testDb.db, runId);
    return run?.status === status ? run : undefined;
  });
}

async function readOutputs(runId: string) {
  const [sheetArtifact, ...moreSheets] = await listArtifacts(testDb.db, runId, {
    kind: VERIFIED_FACT_SHEET_ARTIFACT_KIND,
  });
  const [conflictsArtifact, ...moreConflicts] = await listArtifacts(testDb.db, runId, {
    kind: FACT_CONFLICTS_ARTIFACT_KIND,
  });
  expect(moreSheets).toEqual([]);
  expect(moreConflicts).toEqual([]);
  return {
    sheetArtifact,
    conflictsArtifact,
    sheet: verifiedFactSheetContentSchema.parse(sheetArtifact?.content),
    conflicts: factConflictsContentSchema.parse(conflictsArtifact?.content),
  };
}

// Stubbed Meta API for the cases that must not depend on one recording.
const stubUsage = {
  input_tokens: 7000,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 3000,
  output_tokens_details: { reasoning_tokens: 1000 },
  total_tokens: 10000,
};
function stubResponse(model: string, text: string, incomplete = false): Response {
  return Response.json({
    id: `resp_${model}`,
    object: 'response',
    created_at: 1_793_154_894,
    model,
    status: incomplete ? 'incomplete' : 'completed',
    error: null,
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
    store: false,
    output: [
      {
        type: 'message',
        id: 'msg_stub',
        role: 'assistant',
        status: incomplete ? 'incomplete' : 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: stubUsage,
  });
}
const modelSchema = z.object({ model: z.string() });
function stubMeta(answer: (model: string) => Response): string[] {
  const models: string[] = [];
  vi.stubGlobal('fetch', (_input: string | URL | Request, init?: RequestInit) => {
    const body = modelSchema.parse(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
    models.push(body.model);
    return Promise.resolve(answer(body.model));
  });
  return models;
}
const EMPTY_ANSWER = JSON.stringify({
  verifiedFacts: [],
  conflicts: [],
  rejected: [],
} satisfies ReconciliationStepOutput);

beforeAll(async () => {
  testDb = await startTestDatabase();
  definitions = await loadDefinitions();
  service = reconciliationService(definitions);

  replay = createMetaReplay({
    cassette: RECONCILIATION_CASSETTE,
    include: RECONCILIATION_INCLUDED_CASSETTES,
    match: RECONCILIATION_MATCH,
    mode: 'replay',
  });
  await replay.start();
  const usage = createInMemoryUsageRecorder();
  recorded = await replayRecordedCandidates(
    createMetaClients({ apiKey: replay.apiKey, usage, maxRetries: 0 }),
    usage,
    definitions,
    {
      transcriptArtifactId: PLACEHOLDER_TRANSCRIPT_ID,
      inventoryArtifactId: PLACEHOLDER_INVENTORY_ID,
    },
  );
  transcriptContent = transcriptArtifactContentSchema.parse({
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
    turns: recorded.turns,
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

  const reconcile = createReconciliationHandler({ markets: definitions });
  const reconciler: StepHandler<'reconciler'> = async (context) => {
    const result = await reconcile(context);
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
    handlers: {
      reconciler,
      exporter: (context) => {
        exported.push(context.run.id);
        return Promise.resolve(undefined);
      },
    },
    createMetaClients: (usage) =>
      createMetaClients({ apiKey: replay.apiKey, usage, estimateCost, maxRetries: 0 }),
    heartbeatSeconds: 10,
    expiryGraceSeconds: 5,
    retryDelaySeconds: 0,
  });
  await engine.startWorkers({ pollingIntervalSeconds: 0.5 });
}, 180_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await replay?.stop();
  await testDb?.stop();
});

describe('reconciliation step', () => {
  it('stores the fact sheet and conflicts, decides every candidate, and stops at Gate 1', async () => {
    const run = await seedReconciliationRun();

    await engine.startRun(run.id);
    const paused = await waitForStatus(run.id, 'awaiting_gate');
    replay.assertAllMatched();
    expect(paused.gate).toBe('fact_conflicts');
    expect(exported).not.toContain(run.id);

    const { sheetArtifact, conflictsArtifact, sheet, conflicts } = await readOutputs(run.id);
    expect(sheet.modelRun).toEqual({
      model: 'muse-wonder-1.0',
      reasoningEffort: 'low',
      maxOutputTokens: 12000,
      fallbackFrom: null,
    });
    expect(conflicts.factSheetArtifactId).toBe(sheetArtifact?.id);

    // Every candidate got exactly one outcome, and the stored statuses match it.
    const facts = await listFacts(testDb.db, run.id);
    expect(facts).toHaveLength(recorded.facts.length);
    expect(sheet.outcomes).toHaveLength(facts.length);
    const statusOf = new Map(sheet.outcomes.map((o) => [o.factId, o.status]));
    for (const fact of facts) expect(fact.status).toBe(statusOf.get(fact.id));
    expect(facts.some((fact) => fact.status === 'candidate')).toBe(false);
    for (const fact of facts.filter((f) => f.assertion === 'opinion')) {
      expect(fact.status).toBe('rejected');
    }

    // The planted living area: 92 verified from form + NEN 2580 turn, "zo'n 95" set aside.
    const living = facts.filter((fact) => fact.key === 'living_area');
    expect(living.map((f) => [f.value, f.basis, f.status]).sort()).toEqual([
      [92, 'NEN2580', 'verified'],
      [92, 'NEN2580', 'verified'],
      [95, 'unspecified', 'rejected'],
    ]);
    expect(sheet.basisNotes.map((note) => [note.key, note.value, note.reason])).toEqual([
      ['living_area', 95, 'different_basis'],
    ]);

    // The recorded answer finds one contradiction: laminate in the walkthrough, carpet in the
    // bedroom photo. Gate 1 lists it with both sides and their facts.
    expect(conflicts.conflicts).toHaveLength(1);
    const [conflict] = conflicts.conflicts;
    expect(conflict).toMatchObject({
      id: 'K01',
      key: 'other:bedroom_floor',
      detectedBy: ['model'],
    });
    expect(conflict?.sides.map((side) => [side.key, side.sourceKinds])).toEqual([
      ['other:bedroom_floor', ['transcript_turn']],
      ['other:carpet_floor', ['photo_region']],
    ]);
    for (const id of conflict?.factIds ?? []) {
      expect(facts.find((fact) => fact.id === id)?.status).toBe('conflicted');
    }

    const steps = await listRunSteps(testDb.db, run.id);
    expect(steps.map((s) => [s.stepId, s.status, s.outputArtifactIds, s.gateReleasedAt])).toEqual([
      ['reconciliation', 'completed', [sheetArtifact?.id, conflictsArtifact?.id], null],
    ]);

    // One Wonder call: 7,066 in + 3,405 out.
    const usage = await listUsageForRun(testDb.db, run.id);
    expect(
      usage.map((u) => [u.modelId, u.inputTokens, u.outputTokens, u.estimatedCostUsd]),
    ).toEqual([['muse-wonder-1.0', 7066, 3405, '0.09636400']]);

    const events = await listRunEvents(testDb.db, run.id);
    expect(events.map((e) => e.type)).toEqual([
      'run_status_changed',
      'step_started',
      'usage_recorded',
      'facts_reconciled',
      'step_completed',
      'run_status_changed',
      'gate_opened',
    ]);
    const summary = factsReconciledPayloadSchema.parse(
      events.find((e) => e.type === 'facts_reconciled')?.payload,
    );
    expect(summary).toEqual({
      stepId: 'reconciliation',
      artifactId: sheetArtifact?.id,
      conflictsArtifactId: conflictsArtifact?.id,
      candidateCount: sheet.counts.candidates,
      verifiedCount: sheet.counts.verified,
      conflictedCount: 2,
      rejectedCount: sheet.counts.rejected,
      entryCount: sheet.counts.entries,
      conflictCount: 1,
      basisNoteCount: 1,
      model: 'muse-wonder-1.0',
      fallbackUsed: false,
    });
    // No fact key, value, or explanation in any event.
    const serialized = JSON.stringify(events.map((e) => e.payload));
    expect(serialized).not.toMatch(/Kwartelhoflaan|living_area|laminate|NEN|bedroom/);

    // Gate 1 (P2-10) resumes the run past the gate.
    await engine.resumeAfterGate(run.id, { gate: 'fact_conflicts' });
    await waitForStatus(run.id, 'completed');
    expect(exported).toContain(run.id);

    // The outputs are personal data: deleting the project removes them with the run.
    await deleteProject(testDb.db, paused.projectId);
    expect(await listFacts(testDb.db, run.id)).toEqual([]);
    expect(await listArtifacts(testDb.db, run.id)).toEqual([]);
  });

  it('releases Gate 1 and continues when there is nothing to decide', async () => {
    const run = await seedReconciliationRun();
    const models = stubMeta((model) => stubResponse(model, EMPTY_ANSWER));

    await engine.startRun(run.id);
    await waitForStatus(run.id, 'completed');
    expect(models).toEqual(['muse-wonder-1.0']);
    expect(exported).toContain(run.id);

    const { conflicts, sheet } = await readOutputs(run.id);
    expect(conflicts.conflicts).toEqual([]);
    // With no valid model judgment, transcript `other:` candidates are never verified by default.
    expect(sheet.outcomes.filter((o) => o.reason === 'not_reconciled').length).toBeGreaterThan(40);
    const [step] = await listRunSteps(testDb.db, run.id);
    expect(step?.gateReleasedAt).toBeInstanceOf(Date);
    const events = await listRunEvents(testDb.db, run.id);
    expect(events.some((e) => e.type === 'gate_opened')).toBe(false);
  });

  it('falls back to Spark when Wonder fails, records both calls, and gates a code conflict', async () => {
    // The form says label C; the walkthrough says B twice: same key, same measure, two values.
    const run = await seedReconciliationRun((fact) =>
      fact.key === 'energy_label' && fact.source.kind === 'form' ? { ...fact, value: 'C' } : fact,
    );
    const models = stubMeta((model) =>
      model === 'muse-wonder-1.0'
        ? stubResponse(model, '{"verifiedFacts":[{"key":"other:addr', true)
        : stubResponse(model, EMPTY_ANSWER),
    );

    await engine.startRun(run.id);
    const paused = await waitForStatus(run.id, 'awaiting_gate');
    expect(paused.gate).toBe('fact_conflicts');
    expect(models).toEqual(['muse-wonder-1.0', 'muse-spark-1.3']);

    const { sheet, conflicts } = await readOutputs(run.id);
    expect(sheet.modelRun).toEqual({
      model: 'muse-spark-1.3',
      reasoningEffort: 'medium',
      maxOutputTokens: 12000,
      fallbackFrom: {
        model: 'muse-wonder-1.0',
        reasoningEffort: 'low',
        failure: 'NoObjectGeneratedError length',
      },
    });
    expect(conflicts.conflicts).toHaveLength(1);
    expect(conflicts.conflicts[0]).toMatchObject({
      key: 'energy_label',
      kind: 'value_mismatch',
      detectedBy: ['code'],
    });
    expect(conflicts.conflicts[0]?.sides.map((s) => [s.value, s.sourceKinds])).toEqual([
      ['C', ['form']],
      ['B', ['transcript_turn']],
    ]);

    // Both calls are in the ledger: the truncated Wonder answer was billed.
    const usage = await listUsageForRun(testDb.db, run.id);
    expect(usage.map((u) => [u.modelId, u.estimatedCostUsd])).toEqual([
      ['muse-wonder-1.0', '0.08800000'],
      ['muse-spark-1.3', '0.02150000'],
    ]);
    const events = await listRunEvents(testDb.db, run.id);
    const summary = factsReconciledPayloadSchema.parse(
      events.find((e) => e.type === 'facts_reconciled')?.payload,
    );
    expect([summary.model, summary.fallbackUsed]).toEqual(['muse-spark-1.3', true]);
  });

  it('commits one fact sheet when a superseded execution finishes after its replacement', async () => {
    const run = await seedReconciliationRun();
    await transitionRun(testDb.db, run.id, { to: 'running' });
    const jobId = randomUUID();
    const data: StepJobData = { runId: run.id, stepId: 'reconciliation', attempt: 1 };
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
      const stalled = engine.processStepJob(delivery(0));
      await held;
      expect(await engine.processStepJob(delivery(1))).toEqual({ outcome: 'completed' });
      release();
      expect(await stalled).toEqual({ outcome: 'superseded' });
    } finally {
      holdResult = undefined;
    }
    await waitForStatus(run.id, 'awaiting_gate');

    await readOutputs(run.id);
    const events = await listRunEvents(testDb.db, run.id);
    expect(events.filter((e) => e.type === 'facts_reconciled')).toHaveLength(1);
    // Both executions called Wonder, so both are billed.
    expect(await listUsageForRun(testDb.db, run.id)).toHaveLength(2);
  });
});
