import { randomUUID } from 'node:crypto';
import {
  PHOTO_INVENTORY_ARTIFACT_KIND,
  apiErrorSchema,
  authUserResponseSchema,
  factConflictDecisionResponseSchema,
  factConflictsGateResponseSchema,
  gateDecidedPayloadSchema,
  transcriptArtifactContentSchema,
  type FactConflictDecisionRequest,
  type FactConflictsGateResponse,
  type GateConflict,
  type JsonObject,
  type ServiceDefinition,
  type TranscriptArtifactContent,
} from '@evidomo/shared';
import { sql } from 'drizzle-orm';
import type { Express } from 'express';
import { PgBoss } from 'pg-boss';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { appConfigFromEnv, createApp } from '../app.ts';
import { insertArtifact, insertSingletonArtifact } from '../db/repositories/artifacts.ts';
import { insertFacts, listFacts, type NewFact } from '../db/repositories/facts.ts';
import { listRunEvents } from '../db/repositories/run-events.ts';
import { getRun, type Run } from '../db/repositories/runs.ts';
import { seedProject, seedRun, startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { loadDefinitions, type DefinitionRegistry } from '../definitions/loader.ts';
import { loadEnv } from '../env.ts';
import { unusedProjectDeps, unusedStorage } from '../http/testing.ts';
import { createLogger } from '../logger.ts';
import { createMetaClients } from '../meta/clients.ts';
import { createMetaReplay, REPLAY_PLACEHOLDER_API_KEY } from '../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../meta/usage.ts';
import { WALKTHROUGH_FACT_FORM } from '../pipeline/intake/testing.ts';
import { createReconciliationHandler } from '../pipeline/reconciliation/handler.ts';
import type { ReconciliationStepOutput } from '../pipeline/reconciliation/schema.ts';
import {
  RECONCILIATION_CASSETTE,
  RECONCILIATION_INCLUDED_CASSETTES,
  RECONCILIATION_MATCH,
  reconciliationService,
  replayRecordedCandidates,
  type RecordedCandidates,
} from '../pipeline/reconciliation/testing.ts';
import { createRunEngine, type RunEngine } from '../runs/engine.ts';
import { RUN_STEP_QUEUE } from '../runs/queue.ts';
import { testRegistry, waitFor } from '../runs/testing.ts';
import { createPriceTableCostEstimator } from '../usage/ledger.ts';
import { GATE_DECISION_STEP_ID } from './fact-conflicts.ts';

// Gate 1 through HTTP, against PostgreSQL (Testcontainers) and the real reconciliation step in
// the run engine, so every run waits at `fact_conflicts` exactly as production leaves it. One run
// uses the recorded P2-09 Wonder answer (a model conflict between the walkthrough and a photo);
// the others stub the Meta API with an empty judgment and change form values, so code finds
// value conflicts against the recorded walkthrough. No live model calls.
//
// The recordings are served by MSW, which also intercepts (and, in replay, blocks) the local
// HTTP requests Supertest makes, so replay runs only while no request goes to the app.

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });
const PASSWORD = 'correct horse battery staple';
const APP_ORIGIN = 'http://localhost:3000';

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let definitions: DefinitionRegistry;
let service: ServiceDefinition;
let recorded: RecordedCandidates;
let transcriptContent: TranscriptArtifactContent;
let app: Express;
/** Run IDs, once per execution of the step after the gate. */
const exported: string[] = [];

interface Operator {
  readonly id: string;
  readonly agent: ReturnType<typeof request.agent>;
}
let owner: Operator;
let stranger: Operator;

async function signUp(): Promise<Operator> {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/auth/register')
    .send({ email: `operator-${randomUUID()}@example.test`, password: PASSWORD });
  expect(response.status).toBe(201);
  return { id: authUserResponseSchema.parse(response.body).user.id, agent };
}

/** The earlier steps' outputs for one run of `owner`, as P2-09's integration test seeds them. */
async function seedGateRun(
  ownerId: string,
  change: (fact: NewFact) => NewFact = (fact) => fact,
  factForm: JsonObject = WALKTHROUGH_FACT_FORM,
): Promise<Run> {
  const project = await seedProject(testDb.db, ownerId, { factForm });
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

/** Form label C and form living area 93 against the walkthrough's B (twice) and 92: two conflicts. */
const twoCodeConflicts = (fact: NewFact): NewFact => {
  if (fact.source.kind !== 'form') return fact;
  if (fact.key === 'energy_label') return { ...fact, value: 'C' };
  if (fact.key === 'living_area') return { ...fact, value: 93 };
  return fact;
};

/** Runs `body` with the P2-09 recordings served, and fails on any request without one. */
async function withRecordings<T>(body: () => Promise<T>): Promise<T> {
  const replay = createMetaReplay({
    cassette: RECONCILIATION_CASSETTE,
    include: RECONCILIATION_INCLUDED_CASSETTES,
    match: RECONCILIATION_MATCH,
    mode: 'replay',
  });
  await replay.start();
  try {
    const result = await body();
    replay.assertAllMatched();
    return result;
  } finally {
    await replay.stop();
  }
}

async function waitForStatus(runId: string, status: Run['status']): Promise<Run> {
  return waitFor(
    `run to be ${status}`,
    async () => {
      const run = await getRun(testDb.db, runId);
      return run?.status === status ? run : undefined;
    },
    { timeoutMs: 60_000 },
  );
}

const EMPTY_ANSWER = JSON.stringify({
  verifiedFacts: [],
  conflicts: [],
  rejected: [],
} satisfies ReconciliationStepOutput);
const modelSchema = z.object({ model: z.string() });

/** Answers every Meta call with an empty judgment, so only code-detected conflicts remain. */
function stubEmptyJudgment(): void {
  vi.stubGlobal('fetch', (_input: string | URL | Request, init?: RequestInit) => {
    const { model } = modelSchema.parse(
      typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    );
    return Promise.resolve(
      Response.json({
        id: `resp_${model}`,
        object: 'response',
        created_at: 1_793_154_894,
        model,
        status: 'completed',
        error: null,
        incomplete_details: null,
        store: false,
        output: [
          {
            type: 'message',
            id: 'msg_stub',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: EMPTY_ANSWER, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 7000,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 3000,
          output_tokens_details: { reasoning_tokens: 1000 },
          total_tokens: 10000,
        },
      }),
    );
  });
}

/** A run of `owner` paused at Gate 1 with the two code conflicts. */
async function twoConflictRun(): Promise<Run> {
  stubEmptyJudgment();
  const run = await seedGateRun(owner.id, twoCodeConflicts);
  await engine.startRun(run.id);
  return waitForStatus(run.id, 'awaiting_gate');
}

const gatePath = (runId: string): string => `/api/runs/${runId}/gates/fact-conflicts`;
const decisionPath = (runId: string, conflictId: string): string =>
  `${gatePath(runId)}/conflicts/${conflictId}/decision`;

async function getGate(runId: string, as: Operator = owner): Promise<FactConflictsGateResponse> {
  const response = await as.agent.get(gatePath(runId));
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return factConflictsGateResponseSchema.parse(response.body);
}

function decide(
  runId: string,
  conflictId: string,
  body: FactConflictDecisionRequest,
  as: Operator = owner,
) {
  return as.agent.put(decisionPath(runId, conflictId)).send(body);
}

function conflictOn(gate: FactConflictsGateResponse, key: string): GateConflict {
  const conflict = gate.conflicts.find((c) => c.key === key);
  if (conflict === undefined) throw new Error(`no conflict on ${key}`);
  return conflict;
}

function sideWith(conflict: GateConflict, value: unknown): GateConflict['sides'][number] {
  const side = conflict.sides.find((s) => s.value === value);
  if (side === undefined) throw new Error(`no side with value ${String(value)}`);
  return side;
}

function errorCode(response: request.Response): string {
  return apiErrorSchema.parse(response.body).error;
}

async function stepJobCount(runId: string, stepId: string): Promise<number> {
  const result = await testDb.db.execute<{ count: string }>(sql`
    select count(*)::text as count from pgboss.job
    where name = ${RUN_STEP_QUEUE} and data->>'runId' = ${runId} and data->>'stepId' = ${stepId}
  `);
  return Number(result.rows[0]?.count);
}

async function gateDecidedEvents(runId: string) {
  return (await listRunEvents(testDb.db, runId))
    .filter((event) => event.type === 'gate_decided')
    .map((event) => gateDecidedPayloadSchema.parse(event.payload));
}

async function statusesOf(runId: string, factIds: readonly string[]): Promise<string[]> {
  const facts = new Map((await listFacts(testDb.db, runId)).map((f) => [f.id, f.status]));
  return factIds.map((id) => facts.get(id) ?? 'missing');
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  definitions = await loadDefinitions();
  service = reconciliationService(definitions);

  const usage = createInMemoryUsageRecorder();
  recorded = await withRecordings(() =>
    replayRecordedCandidates(
      createMetaClients({ apiKey: REPLAY_PLACEHOLDER_API_KEY, usage, maxRetries: 0 }),
      usage,
      definitions,
      { transcriptArtifactId: randomUUID(), inventoryArtifactId: randomUUID() },
    ),
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
  const estimateCost = createPriceTableCostEstimator();
  engine = createRunEngine({
    db: testDb.db,
    boss,
    registry: testRegistry(service),
    logger,
    dailyCapUsd: '5.00',
    handlers: {
      reconciler: createReconciliationHandler({ markets: definitions }),
      exporter: (context) => {
        exported.push(context.run.id);
        return Promise.resolve(undefined);
      },
    },
    createMetaClients: (recorder) =>
      createMetaClients({
        apiKey: REPLAY_PLACEHOLDER_API_KEY,
        usage: recorder,
        estimateCost,
        maxRetries: 0,
      }),
    heartbeatSeconds: 10,
    expiryGraceSeconds: 5,
    retryDelaySeconds: 0,
  });
  await engine.startWorkers({ pollingIntervalSeconds: 0.5 });

  const env = loadEnv({
    DATABASE_URL: testDb.container.getConnectionUri(),
    NODE_ENV: 'test',
    APP_ORIGIN,
  });
  app = createApp({
    db: testDb.client,
    logger,
    config: appConfigFromEnv(env),
    runs: { engine, markets: definitions, services: definitions },
    storage: unusedStorage(),
    projects: unusedProjectDeps(),
  });
  owner = await signUp();
  stranger = await signUp();
}, 180_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await testDb?.stop();
});

describe('Gate 1 API', () => {
  it('lists the recorded conflict with provenance and resumes the run once on accept', async () => {
    const run = await seedGateRun(owner.id);
    await withRecordings(async () => {
      await engine.startRun(run.id);
      await waitForStatus(run.id, 'awaiting_gate');
    });

    const gate = await getGate(run.id);
    expect(gate).toMatchObject({
      runId: run.id,
      runStatus: 'awaiting_gate',
      state: 'open',
      conflictCount: 1,
      openCount: 1,
    });
    expect(gate.conflictsArtifactId).not.toBeNull();
    expect(gate.factSheetArtifactId).not.toBeNull();
    const [conflict] = gate.conflicts;
    if (conflict === undefined) throw new Error('no conflict');
    expect(conflict).toMatchObject({
      id: 'K01',
      key: 'other:bedroom_floor',
      detectedBy: ['model'],
      decision: null,
    });
    // Each side lists its facts with the provenance the evidence inspector needs.
    const [spoken, photo] = conflict.sides;
    if (spoken === undefined || photo === undefined) throw new Error('missing sides');
    expect(spoken.facts.map((f) => f.source.kind)).toEqual(['transcript_turn']);
    expect(photo.facts.map((f) => f.source.kind)).toEqual(['photo_region']);
    for (const fact of [...spoken.facts, ...photo.facts]) {
      expect(fact.status).toBe('conflicted');
      expect(fact.key).toBe(fact.id === spoken.factIds[0] ? spoken.key : photo.key);
    }
    const turn = spoken.facts[0]?.source;
    expect(turn?.kind === 'transcript_turn' && turn.quote.length > 0).toBe(true);

    const photoFactId = photo.factIds[0] ?? '';
    const response = await decide(run.id, 'K01', { choice: 'accept', factId: photoFactId });
    expect(response.status).toBe(200);
    const decided = factConflictDecisionResponseSchema.parse(response.body);
    expect(decided).toMatchObject({ resumed: true, state: 'released', openCount: 0 });
    expect(decided.conflicts[0]?.decision).toMatchObject({
      choice: 'accept',
      factIds: photo.factIds,
    });
    // The resume committed with the decision: the run left the gate and the next step's job
    // exists, before any worker had to act.
    expect((await getRun(testDb.db, run.id))?.status).not.toBe('awaiting_gate');
    expect(await stepJobCount(run.id, 'export')).toBe(1);

    await waitForStatus(run.id, 'completed');
    expect(exported.filter((id) => id === run.id)).toHaveLength(1);
    expect(await statusesOf(run.id, photo.factIds)).toEqual(photo.factIds.map(() => 'verified'));
    expect(await statusesOf(run.id, spoken.factIds)).toEqual(spoken.factIds.map(() => 'rejected'));
    expect(await gateDecidedEvents(run.id)).toEqual([
      {
        gate: 'fact_conflicts',
        stepId: 'reconciliation',
        acceptedCount: 1,
        editedCount: 0,
        rejectedCount: 0,
        verifiedFactCount: photo.factIds.length,
        rejectedFactCount: spoken.factIds.length,
        createdFactCount: 0,
      },
    ]);
    // No property content in the event log.
    const events = JSON.stringify((await listRunEvents(testDb.db, run.id)).map((e) => e.payload));
    expect(events).not.toMatch(/bedroom|carpet|laminate/);

    // Released: decisions are final.
    const again = await decide(run.id, 'K01', { choice: 'accept', factId: photoFactId });
    expect([again.status, errorCode(again)]).toEqual([409, 'gate_not_open']);
    const after = await getGate(run.id);
    expect(after).toMatchObject({ state: 'released', runStatus: 'completed', openCount: 0 });
    expect(after.conflicts[0]?.decision?.choice).toBe('accept');
  });

  it('decides each choice, allows changes while open, and applies them at the last decision', async () => {
    const run = await twoConflictRun();
    const gate = await getGate(run.id);
    expect(gate).toMatchObject({ state: 'open', conflictCount: 2, openCount: 2 });
    const label = conflictOn(gate, 'energy_label');
    const area = conflictOn(gate, 'living_area');
    expect(label.kind).toBe('value_mismatch');
    const formLabel = sideWith(label, 'C');
    const spokenLabel = sideWith(label, 'B');
    expect(spokenLabel.factIds).toHaveLength(2);
    const formArea = sideWith(area, 93);
    expect(formArea.sourceKinds).toEqual(['form']);

    // reject, then the same body again (idempotent: the decision keeps its time)
    const rejected = await decide(run.id, label.id, { choice: 'reject' });
    expect(rejected.status).toBe(200);
    const first = factConflictDecisionResponseSchema.parse(rejected.body);
    expect(first).toMatchObject({ resumed: false, state: 'open', openCount: 1 });
    const firstDecision = conflictOn(first, 'energy_label').decision;
    expect(firstDecision?.choice).toBe('reject');
    const repeated = factConflictDecisionResponseSchema.parse(
      (await decide(run.id, label.id, { choice: 'reject' })).body,
    );
    expect(conflictOn(repeated, 'energy_label').decision).toEqual(firstDecision);

    // changed while the gate is open: accept the walkthrough's B
    const changed = factConflictDecisionResponseSchema.parse(
      (await decide(run.id, label.id, { choice: 'accept', factId: spokenLabel.factIds[1] ?? '' }))
        .body,
    );
    expect(conflictOn(changed, 'energy_label').decision).toMatchObject({
      choice: 'accept',
      factIds: spokenLabel.factIds,
    });
    expect(changed.openCount).toBe(1);

    // refusals leave the gate as it was
    const otherFact = await decide(run.id, area.id, {
      choice: 'accept',
      factId: formLabel.factIds[0] ?? '',
    });
    expect([otherFact.status, errorCode(otherFact)]).toEqual([400, 'fact_not_in_conflict']);
    const notAnArea = await decide(run.id, area.id, { choice: 'edit', value: 'ninety' });
    expect(notAnArea.status).toBe(400);
    expect(apiErrorSchema.parse(notAnArea.body)).toEqual({
      error: 'validation_failed',
      issues: [{ path: ['value'], message: expect.any(String) as unknown }],
    });
    const wrongUnit = await decide(run.id, area.id, { choice: 'edit', value: 92.5, unit: 'ft2' });
    expect(apiErrorSchema.parse(wrongUnit.body).issues?.[0]?.path).toEqual(['unit']);
    const wrongKey = await decide(run.id, area.id, {
      choice: 'edit',
      value: 'B',
      key: 'energy_label',
    });
    expect(apiErrorSchema.parse(wrongKey.body).issues?.[0]?.path).toEqual(['key']);
    const unknown = await decide(run.id, 'K99', { choice: 'reject' });
    expect([unknown.status, errorCode(unknown)]).toEqual([404, 'not_found']);
    const malformed = await owner.agent
      .put(decisionPath(run.id, area.id))
      .send({ choice: 'remove' });
    expect([malformed.status, errorCode(malformed)]).toEqual([400, 'validation_failed']);
    const extraField = await owner.agent
      .put(decisionPath(run.id, area.id))
      .send({ choice: 'reject', value: 1 });
    expect(extraField.status).toBe(400);

    // Nothing applied and nothing resumed while one conflict is open.
    expect((await getRun(testDb.db, run.id))?.status).toBe('awaiting_gate');
    expect(await stepJobCount(run.id, 'export')).toBe(0);
    expect(
      await statusesOf(
        run.id,
        label.sides.flatMap((s) => s.factIds),
      ),
    ).toEqual(['conflicted', 'conflicted', 'conflicted']);

    // edit: the last decision resumes the run
    const edited = await decide(run.id, area.id, { choice: 'edit', value: 92.5 });
    expect(edited.status).toBe(200);
    const final = factConflictDecisionResponseSchema.parse(edited.body);
    expect(final).toMatchObject({ resumed: true, state: 'released', openCount: 0 });
    expect(conflictOn(final, 'living_area').decision).toMatchObject({
      choice: 'edit',
      key: 'living_area',
      value: 92.5,
      unit: formArea.unit,
      basis: 'NEN2580',
    });
    expect(await stepJobCount(run.id, 'export')).toBe(1);
    await waitForStatus(run.id, 'completed');
    expect(exported.filter((id) => id === run.id)).toHaveLength(1);

    expect(await statusesOf(run.id, spokenLabel.factIds)).toEqual(['verified', 'verified']);
    expect(await statusesOf(run.id, formLabel.factIds)).toEqual(['rejected']);
    expect(
      await statusesOf(
        run.id,
        area.sides.flatMap((s) => s.factIds),
      ),
    ).toEqual(area.sides.flatMap((s) => s.factIds).map(() => 'rejected'));
    // The edited value is a new verified fact whose provenance is the decision, not a source.
    const created = (await listFacts(testDb.db, run.id)).filter(
      (fact) => fact.source.kind === 'gate_decision',
    );
    expect(created).toEqual([
      expect.objectContaining({
        stepId: GATE_DECISION_STEP_ID,
        key: 'living_area',
        value: 92.5,
        unit: formArea.unit,
        basis: 'NEN2580',
        status: 'verified',
        assertion: 'stated',
        source: {
          kind: 'gate_decision',
          gate: 'fact_conflicts',
          conflictsArtifactId: gate.conflictsArtifactId,
          conflictId: area.id,
        },
      }),
    ]);
    expect(await gateDecidedEvents(run.id)).toEqual([
      expect.objectContaining({
        acceptedCount: 1,
        editedCount: 1,
        rejectedCount: 0,
        verifiedFactCount: 2,
        rejectedFactCount: 1 + area.sides.flatMap((s) => s.factIds).length,
        createdFactCount: 1,
      }),
    ]);

    const late = await decide(run.id, area.id, { choice: 'reject' });
    expect([late.status, errorCode(late)]).toEqual([409, 'gate_not_open']);
  });

  it('resumes exactly once when the last two conflicts are decided concurrently', async () => {
    const run = await twoConflictRun();
    const gate = await getGate(run.id);
    const ids = gate.conflicts.map((c) => c.id);
    expect(ids).toHaveLength(2);

    const responses = await Promise.all(ids.map((id) => decide(run.id, id, { choice: 'reject' })));
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const resumed = responses.map((r) => factConflictDecisionResponseSchema.parse(r.body).resumed);
    expect(resumed.sort()).toEqual([false, true]);

    await waitForStatus(run.id, 'completed');
    expect(exported.filter((id) => id === run.id)).toHaveLength(1);
    expect(await stepJobCount(run.id, 'export')).toBe(1);
    expect(await gateDecidedEvents(run.id)).toEqual([
      expect.objectContaining({ acceptedCount: 0, editedCount: 0, rejectedCount: 2 }),
    ]);
    const conflicted = gate.conflicts.flatMap((c) => c.sides.flatMap((s) => s.factIds));
    expect(await statusesOf(run.id, conflicted)).toEqual(conflicted.map(() => 'rejected'));
    const leftGate = (await listRunEvents(testDb.db, run.id)).filter(
      (e) => e.type === 'run_status_changed' && e.payload['from'] === 'awaiting_gate',
    );
    expect(leftGate).toHaveLength(1);
  });

  it('answers 409 to the loser of two concurrent last decisions', async () => {
    const run = await twoConflictRun();
    const gate = await getGate(run.id);
    const label = conflictOn(gate, 'energy_label');
    const area = conflictOn(gate, 'living_area');
    expect((await decide(run.id, label.id, { choice: 'reject' })).status).toBe(200);

    const factId = sideWith(area, 93).factIds[0] ?? '';
    const responses = await Promise.all([
      decide(run.id, area.id, { choice: 'accept', factId }),
      decide(run.id, area.id, { choice: 'accept', factId }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(responses.map((r) => (r.status === 409 ? errorCode(r) : 'ok')).sort()).toEqual([
      'gate_not_open',
      'ok',
    ]);
    await waitForStatus(run.id, 'completed');
    expect(exported.filter((id) => id === run.id)).toHaveLength(1);
    expect(await gateDecidedEvents(run.id)).toHaveLength(1);
  });

  it('reports a released gate with nothing open when reconciliation found no conflicts', async () => {
    stubEmptyJudgment();
    const run = await seedGateRun(owner.id);
    await engine.startRun(run.id);
    await waitForStatus(run.id, 'completed');

    const gate = await getGate(run.id);
    expect(gate).toMatchObject({
      state: 'released',
      runStatus: 'completed',
      conflictCount: 0,
      openCount: 0,
      conflicts: [],
    });
    expect(gate.conflictsArtifactId).not.toBeNull();
    const response = await decide(run.id, 'K01', { choice: 'reject' });
    expect([response.status, errorCode(response)]).toEqual([409, 'gate_not_open']);
    expect(await gateDecidedEvents(run.id)).toEqual([]);
  });

  it('reports a gate that is not reached yet and refuses decisions on it', async () => {
    const run = await seedGateRun(owner.id);

    expect(await getGate(run.id)).toMatchObject({
      state: 'not_reached',
      runStatus: 'queued',
      conflictsArtifactId: null,
      conflictCount: 0,
      openCount: 0,
    });
    const response = await decide(run.id, 'K01', { choice: 'reject' });
    expect([response.status, errorCode(response)]).toEqual([409, 'gate_not_open']);
  });

  it('requires a session, hides other users’ runs, and refuses cross-origin and non-JSON writes', async () => {
    const run = await twoConflictRun();
    const gate = await getGate(run.id);
    const conflictId = gate.conflicts[0]?.id ?? 'K01';
    const anonymous = request(app);

    const noSessionGet = await anonymous.get(gatePath(run.id));
    expect([noSessionGet.status, errorCode(noSessionGet)]).toEqual([401, 'unauthenticated']);
    const noSessionPut = await anonymous
      .put(decisionPath(run.id, conflictId))
      .send({ choice: 'reject' });
    expect([noSessionPut.status, errorCode(noSessionPut)]).toEqual([401, 'unauthenticated']);

    // Another user's run and a run that does not exist look the same.
    const foreignGet = await stranger.agent.get(gatePath(run.id));
    expect([foreignGet.status, errorCode(foreignGet)]).toEqual([404, 'not_found']);
    const foreignPut = await decide(run.id, conflictId, { choice: 'reject' }, stranger);
    expect([foreignPut.status, errorCode(foreignPut)]).toEqual([404, 'not_found']);
    const missing = await owner.agent.get(gatePath(randomUUID()));
    expect([missing.status, errorCode(missing)]).toEqual([404, 'not_found']);
    const malformed = await owner.agent.get(gatePath('not-a-uuid'));
    expect([malformed.status, errorCode(malformed)]).toEqual([400, 'validation_failed']);

    const crossOrigin = await owner.agent
      .put(decisionPath(run.id, conflictId))
      .set('Origin', 'https://attacker.example')
      .send({ choice: 'reject' });
    expect([crossOrigin.status, errorCode(crossOrigin)]).toEqual([403, 'forbidden_origin']);
    const formPost = await owner.agent
      .put(decisionPath(run.id, conflictId))
      .type('form')
      .send('choice=reject');
    expect([formPost.status, errorCode(formPost)]).toEqual([415, 'unsupported_media_type']);

    // None of them recorded anything.
    expect(await getGate(run.id)).toMatchObject({ state: 'open', openCount: 2 });
    const sameOrigin = await owner.agent
      .put(decisionPath(run.id, conflictId))
      .set('Origin', APP_ORIGIN)
      .send({ choice: 'reject' });
    expect(sameOrigin.status).toBe(200);
  });
});
