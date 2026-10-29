import { randomUUID } from 'node:crypto';
import {
  APPROVED_PACK_ARTIFACT_KIND,
  CLAIM_AUDIT_ARTIFACT_KIND,
  INTEGRITY_CHECKS_ARTIFACT_KIND,
  LISTING_COPY_ARTIFACT_KIND,
  PHOTO_INVENTORY_ARTIFACT_KIND,
  STAGED_IMAGE_ARTIFACT_KIND,
  STAGED_IMAGE_LABEL,
  apiErrorSchema,
  approvedPackContentSchema,
  authUserResponseSchema,
  claimAuditContentSchema,
  claimAuditGateResponseSchema,
  gateDecidedPayloadSchema,
  integrityChecksContentSchema,
  listingCopyContentSchema,
  stagedImageContentSchema,
  type ClaimAuditCategory,
  type ClaimAuditFlag,
  type ClaimAuditGateResponse,
  type ClaimAuditGateSegment,
  type ClaimDecisionRequest,
  type ClaimFindingCode,
  type IntegrityAttempt,
  type IntegrityOutcome,
  type IntegrityPhoto,
  type IntegritySegmentation,
  type ListingCopyContent,
  type ServiceDefinition,
  type StagedImageContent,
  type StagedImageDecisionRequest,
  type StagingOperationId,
} from '@evidomo/shared';
import { sql } from 'drizzle-orm';
import type { Express } from 'express';
import { PgBoss } from 'pg-boss';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appConfigFromEnv, createApp } from '../app.ts';
import type { Executor } from '../db/client.ts';
import { insertArtifact, listArtifacts } from '../db/repositories/artifacts.ts';
import { listClaims, recordVerifierVerdict, type Claim } from '../db/repositories/claims.ts';
import { insertFacts, type NewFact } from '../db/repositories/facts.ts';
import { listRunEvents } from '../db/repositories/run-events.ts';
import { getRun, type Run } from '../db/repositories/runs.ts';
import { seedProject, seedRun, startTestDatabase, type TestDatabase } from '../db/testing.ts';
import { loadDefinitions, type DefinitionRegistry } from '../definitions/loader.ts';
import { loadEnv } from '../env.ts';
import { createLogger } from '../logger.ts';
import { createMetaClients } from '../meta/clients.ts';
import { createMetaReplay, REPLAY_PLACEHOLDER_API_KEY } from '../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../meta/usage.ts';
import { createCreativeHandler } from '../pipeline/creative/handler.ts';
import {
  COPY_CASSETTES,
  COPY_INCLUDED_CASSETTES,
  COPY_MATCH,
  placeholderArtifactIds,
  RECORDED_OFFICE_PROFILE,
  replayPostGateFacts,
  type PostGateFacts,
} from '../pipeline/creative/testing.ts';
import {
  compareFixedElements,
  DEFAULT_INTEGRITY_THRESHOLDS,
} from '../pipeline/integrity/compare.ts';
import {
  STAGING_PROMPT_VERSION,
  stagingOperation,
  stagingPrompt,
} from '../pipeline/staging/operations.ts';
import { verificationService } from '../pipeline/verification/testing.ts';
import { createRunEngine, type RunEngine } from '../runs/engine.ts';
import { RUN_STEP_QUEUE } from '../runs/queue.ts';
import type { StepHandler } from '../runs/steps.ts';
import { testRegistry, waitFor } from '../runs/testing.ts';
import { createPriceTableCostEstimator } from '../usage/ledger.ts';
import { CLAIM_AUDIT_GATE_STEP_ID } from './claim-audit.ts';

// Gate 2 through HTTP, against PostgreSQL (Testcontainers) and the run engine, so every run waits
// at `claim_audit` exactly as the engine leaves it. The creative step is real and replays the
// recorded P3-01 English draft (no live calls). The verification step is a stand-in that stores a
// schema-valid `claim_audit` with the flags each test chooses, plus staged images and an
// `integrity_checks` record (passed, passed on retry, fallback) built with the real comparison.
//
// The recorded draft's segments used here: 0 "…offers 92 m² of living space." (living area),
// 2 "It has energy label B." (the portal's only energy-label segment), 13 "Parking …, and a 6 m²
// external storage is included." (the claim P3-06's verifier flags). Portal is 0–13, social
// 14–16.

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });
const PASSWORD = 'correct horse battery staple';
const APP_ORIGIN = 'http://localhost:3000';

interface FlagSpec {
  readonly index: number;
  readonly category: ClaimAuditCategory;
  readonly problem: string;
  /** Present: a validator flag with this code; absent: a verifier flag. */
  readonly code?: ClaimFindingCode;
  readonly suggestion?: string;
}

interface ImageSpec {
  readonly outcome: IntegrityOutcome;
  readonly operationId: StagingOperationId;
}

interface Scenario {
  readonly flags: readonly FlagSpec[];
  readonly images: readonly ImageSpec[];
}

/** Files stand-in for every staged artifact the verifier stub stores, per run. */
interface StoredImages {
  /** Per image spec: the attempt artifacts (first, then retry if any). */
  readonly attempts: string[][];
  readonly materials: string[];
}

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let definitions: DefinitionRegistry;
let service: ServiceDefinition;
let recorded: PostGateFacts;
let app: Express;
const scenarios = new Map<string, Scenario>();
const storedImages = new Map<string, StoredImages>();
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

// --- The verification stand-in ----------------------------------------------------------------

const FRAME = { width: 1000, height: 750 };
const WINDOW = { box: { x0: 100, y0: 100, x1: 300, y1: 400 }, score: 0.9 };

function segmentation(windows: number): IntegritySegmentation {
  return {
    ...FRAME,
    segments: { window: windows > 0 ? [WINDOW] : [], door: [], radiator: [] },
  };
}

function checkedAttempt(
  attempt: 1 | 2,
  stagedArtifactId: string,
  keepsWindow: boolean,
): IntegrityAttempt {
  const edit = segmentation(keepsWindow ? 1 : 0);
  const verdict = compareFixedElements(segmentation(1), edit);
  return {
    status: 'checked',
    attempt,
    stagedArtifactId,
    passed: verdict.passed,
    edit,
    verdict: {
      ...verdict,
      failures: [...verdict.failures],
      failedClasses: [...verdict.failedClasses],
      classes: verdict.classes.map((c) => ({
        ...c,
        matches: [...c.matches],
        unmatchedOriginal: [...c.unmatchedOriginal],
        unmatchedEdit: [...c.unmatchedEdit],
        failures: [...c.failures],
      })),
      thresholds: { ...verdict.thresholds },
    },
    privacy: { passed: true, phrases: [{ phrase: 'person', count: 0 }] },
  };
}

function stagedContent(materialId: string, operationId: StagingOperationId): StagedImageContent {
  const operation = stagingOperation(operationId);
  return stagedImageContentSchema.parse({
    schemaVersion: 1,
    promptVersion: STAGING_PROMPT_VERSION,
    original: { materialId, sha256: 'a'.repeat(64), ...FRAME },
    operation,
    prompt: stagingPrompt(operation),
    model: 'muse-image-1.0',
    requestedSize: '1000x750',
    toolsDisabled: true,
    modelOutput: { format: 'jpeg', ...FRAME },
    stored: { mimeType: 'image/jpeg', ...FRAME, sizeBytes: 120_000, sha256: 'b'.repeat(64) },
    aspectRatioChange: 0,
    disclosure: { label: STAGED_IMAGE_LABEL, visibleLabelRequired: true },
  } satisfies StagedImageContent);
}

async function storeStaged(
  tx: Executor,
  run: Run,
  stepId: string,
  content: StagedImageContent,
): Promise<string> {
  const artifact = await insertArtifact(tx, {
    runId: run.id,
    stepId,
    kind: STAGED_IMAGE_ARTIFACT_KIND,
    content,
    file: {
      storageKey: `projects/${run.projectId}/runs/${run.id}/artifacts/${randomUUID()}.jpg`,
      mimeType: 'image/jpeg',
    },
  });
  return artifact.id;
}

/** Stores the staged images and the integrity record, as P3-04 and P3-05 leave them. */
async function storeIntegrity(tx: Executor, run: Run, images: readonly ImageSpec[]): Promise<void> {
  const attempts: string[][] = [];
  const materials: string[] = [];
  const photos: IntegrityPhoto[] = [];
  for (const spec of images) {
    const materialId = randomUUID();
    const content = stagedContent(materialId, spec.operationId);
    const first = await storeStaged(tx, run, 'staging', content);
    let photoAttempts: IntegrityAttempt[];
    let final: string | null;
    switch (spec.outcome) {
      case 'passed':
        photoAttempts = [checkedAttempt(1, first, true)];
        final = first;
        attempts.push([first]);
        break;
      case 'passed_on_retry': {
        const retry = await storeStaged(tx, run, 'integrity', content);
        photoAttempts = [checkedAttempt(1, first, false), checkedAttempt(2, retry, true)];
        final = retry;
        attempts.push([first, retry]);
        break;
      }
      case 'fallback_original':
        photoAttempts = [
          checkedAttempt(1, first, false),
          { status: 'edit_failed', attempt: 2, reason: 'no_image' },
        ];
        final = null;
        attempts.push([first]);
        break;
      default: {
        const unreachable: never = spec.outcome;
        throw new Error(`Unhandled outcome ${String(unreachable)}`);
      }
    }
    materials.push(materialId);
    photos.push({
      materialId,
      operationId: spec.operationId,
      original: segmentation(1),
      attempts: photoAttempts,
      outcome: spec.outcome,
      finalStagedArtifactId: final,
    });
  }
  const count = (outcome: IntegrityOutcome): number =>
    images.filter((image) => image.outcome === outcome).length;
  await insertArtifact(tx, {
    runId: run.id,
    stepId: 'integrity',
    kind: INTEGRITY_CHECKS_ARTIFACT_KIND,
    content: integrityChecksContentSchema.parse({
      schemaVersion: 1,
      segmentationModel: 'sam-3.1',
      stagedImagesArtifactId: randomUUID(),
      fixedElements: [
        { phrase: 'window', occlusionTolerant: false },
        { phrase: 'door', occlusionTolerant: true },
        { phrase: 'radiator', occlusionTolerant: true },
      ],
      thresholds: DEFAULT_INTEGRITY_THRESHOLDS,
      editPrivacyPhrases: ['person'],
      counts: {
        photos: images.length,
        passed: count('passed'),
        passedOnRetry: count('passed_on_retry'),
        fallbackOriginal: count('fallback_original'),
        retries: images.filter((image) => image.outcome !== 'passed').length,
        unchecked: 0,
      },
      photos,
    }),
  });
  storedImages.set(run.id, { attempts, materials });
}

function auditFlag(
  spec: FlagSpec,
  draftId: string,
  draft: ListingCopyContent,
  claims: readonly Claim[],
): ClaimAuditFlag {
  for (const variant of draft.variants) {
    const segment = variant.segments.findIndex((s) => s.index === spec.index);
    if (segment === -1) continue;
    const claim = claims.find((c) => c.segmentIndex === spec.index);
    if (claim === undefined) throw new Error(`no claim for segment ${spec.index}`);
    const common = {
      category: spec.category,
      artifactId: draftId,
      variant: variant.kind,
      segment,
      segmentIndex: spec.index,
      claimId: claim.id,
      problem: spec.problem,
      carried: false,
    };
    return spec.code === undefined
      ? { ...common, source: 'verifier', code: null, suggestion: spec.suggestion ?? null }
      : { ...common, source: 'validator', code: spec.code, suggestion: null };
  }
  throw new Error(`no segment ${spec.index}`);
}

const verifierStub: StepHandler<'verifier'> = async (context) => {
  const { run } = context;
  const scenario = scenarios.get(run.id);
  if (scenario === undefined) throw new Error('no scenario for this run');
  const [draftArtifact] = await listArtifacts(context.db, run.id, {
    kind: LISTING_COPY_ARTIFACT_KIND,
  });
  if (draftArtifact === undefined) throw new Error('no draft');
  const draft = listingCopyContentSchema.parse(draftArtifact.content);
  const claims = await listClaims(context.db, draftArtifact.id);
  const flags = scenario.flags.map((spec) => auditFlag(spec, draftArtifact.id, draft, claims));
  const segments = draft.counts.segments;
  return {
    async commit(tx) {
      await storeIntegrity(tx, run, scenario.images);
      const audit = await insertArtifact(tx, {
        runId: run.id,
        stepId: 'verification',
        kind: CLAIM_AUDIT_ARTIFACT_KIND,
        content: claimAuditContentSchema.parse({
          schemaVersion: 1,
          promptVersion: 1,
          outputLanguage: draft.outputLanguage,
          market: { id: 'nl', version: 1 },
          rubric: [{ category: 'claim_support', rule: 'Every statement follows from its facts.' }],
          maxRevisionLoops: 0,
          stopReason: flags.length === 0 ? 'clean' : 'loop_limit',
          initialDraftArtifactId: draftArtifact.id,
          finalDraftArtifactId: draftArtifact.id,
          passes: [
            {
              draftArtifactId: draftArtifact.id,
              revision: 0,
              segments,
              auditedSegments: segments,
              carriedSegments: 0,
              modelRun: null,
              flags,
              dropped: {
                unknownSegment: 0,
                notAudited: 0,
                unknownCategory: 0,
                emptyProblem: 0,
                duplicate: 0,
              },
            },
          ],
          remainingFlags: flags,
          counts: {
            passes: 1,
            revisions: 0,
            verifierCalls: 0,
            remainingFlags: flags.length,
            remainingValidatorFlags: flags.filter((f) => f.source === 'validator').length,
            remainingVerifierFlags: flags.filter((f) => f.source === 'verifier').length,
            flaggedClaims: new Set(flags.map((f) => f.claimId)).size,
            finalClaims: segments,
          },
          fallbackUsed: false,
        }),
      });
      for (const flag of flags.filter((f) => f.source === 'verifier')) {
        await recordVerifierVerdict(tx, flag.claimId, 'flagged');
      }
      return { artifactIds: [audit.id] };
    },
  };
};

// --- Helpers -----------------------------------------------------------------------------------

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

async function seedGate2Run(ownerId: string): Promise<Run> {
  const project = await seedProject(testDb.db, ownerId, { officeProfile: RECORDED_OFFICE_PROFILE });
  const run = await seedRun(testDb.db, project.id, {
    serviceId: service.id,
    serviceVersion: service.version,
  });
  const inventory = await insertArtifact(testDb.db, {
    runId: run.id,
    stepId: 'vision_inventory',
    kind: PHOTO_INVENTORY_ARTIFACT_KIND,
    content: recorded.inventory,
  });
  await insertFacts(
    testDb.db,
    run.id,
    recorded.facts.map((fact): NewFact => {
      const { source } = fact;
      if (source.kind === 'photo_region' && source.maskArtifactId !== undefined) {
        return { ...fact, source: { ...source, maskArtifactId: inventory.id } };
      }
      return fact;
    }),
  );
  return run;
}

/** A run of `owner` paused at Gate 2 with the scenario's flags and images. */
async function gate2Run(scenario: Scenario, ownerId: string = owner.id): Promise<Run> {
  const run = await seedGate2Run(ownerId);
  scenarios.set(run.id, scenario);
  // The replay intercepts Supertest's local requests too, so it runs only until the gate.
  const replay = createMetaReplay({
    cassette: COPY_CASSETTES.en,
    include: COPY_INCLUDED_CASSETTES,
    match: COPY_MATCH,
    mode: 'replay',
  });
  await replay.start();
  try {
    await engine.startRun(run.id);
    const paused = await waitForStatus(run.id, 'awaiting_gate');
    replay.assertAllMatched();
    expect(paused.gate).toBe('claim_audit');
    return paused;
  } finally {
    await replay.stop();
  }
}

const gatePath = (runId: string): string => `/api/runs/${runId}/gates/claim-audit`;
const claimPath = (runId: string, claimId: string): string =>
  `${gatePath(runId)}/claims/${claimId}/decision`;
const imagePath = (runId: string, artifactId: string): string =>
  `${gatePath(runId)}/images/${artifactId}/decision`;
const approvePath = (runId: string): string => `${gatePath(runId)}/approve`;

async function getGate(runId: string, as: Operator = owner): Promise<ClaimAuditGateResponse> {
  const response = await as.agent.get(gatePath(runId));
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return claimAuditGateResponseSchema.parse(response.body);
}

function decideClaim(
  runId: string,
  claimId: string,
  body: ClaimDecisionRequest,
  as: Operator = owner,
) {
  return as.agent.put(claimPath(runId, claimId)).send(body);
}

function decideImage(
  runId: string,
  artifactId: string,
  body: StagedImageDecisionRequest,
  as: Operator = owner,
) {
  return as.agent.put(imagePath(runId, artifactId)).send(body);
}

function approve(runId: string, as: Operator = owner) {
  return as.agent.post(approvePath(runId));
}

function parsed(response: request.Response): ClaimAuditGateResponse {
  expect(response.status).toBe(200);
  return claimAuditGateResponseSchema.parse(response.body);
}

function errorCode(response: request.Response): string {
  return apiErrorSchema.parse(response.body).error;
}

function segmentAt(gate: ClaimAuditGateResponse, index: number): ClaimAuditGateSegment {
  const segment = gate.variants.flatMap((v) => v.segments).find((s) => s.index === index);
  if (segment === undefined) throw new Error(`no segment ${index}`);
  return segment;
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

async function approvedPacks(runId: string) {
  return listArtifacts(testDb.db, runId, { kind: APPROVED_PACK_ARTIFACT_KIND });
}

const FULL_SCENARIO: Scenario = {
  flags: [
    {
      index: 0,
      category: 'claim_support',
      code: 'number_not_in_facts',
      problem: 'The number 92 is not stated by any cited fact.',
    },
    {
      index: 2,
      category: 'unverifiable_superlative',
      problem: 'Synthetic flag on the energy label sentence.',
      suggestion: 'It has energy label B.',
    },
    {
      index: 13,
      category: 'claim_support',
      problem: '"included" is not stated by any cited fact.',
      suggestion: 'Parking is in front of the door without paid parking; there is a 6 m² storage.',
    },
    {
      index: 13,
      category: 'investment_promise',
      problem: 'Synthetic second flag on the parking sentence.',
    },
  ],
  images: [
    { outcome: 'passed', operationId: 'furnish_living_room' },
    { outcome: 'passed_on_retry', operationId: 'furnish_bedroom' },
    { outcome: 'fallback_original', operationId: 'furnish_dining_room' },
  ],
};

beforeAll(async () => {
  testDb = await startTestDatabase();
  definitions = await loadDefinitions();
  service = verificationService(definitions);

  const replay = createMetaReplay({
    cassette: COPY_CASSETTES.en,
    include: COPY_INCLUDED_CASSETTES,
    match: COPY_MATCH,
    mode: 'replay',
  });
  await replay.start();
  try {
    const usage = createInMemoryUsageRecorder();
    recorded = await replayPostGateFacts(
      createMetaClients({ apiKey: replay.apiKey, usage, maxRetries: 0 }),
      usage,
      definitions,
      placeholderArtifactIds(),
    );
  } finally {
    await replay.stop();
  }

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
      creative: createCreativeHandler({ markets: definitions }),
      verifier: verifierStub,
      exporter: (context) => {
        exported.push(context.run.id);
        return Promise.resolve(undefined);
      },
    },
    createMetaClients: (usage) =>
      createMetaClients({
        apiKey: REPLAY_PLACEHOLDER_API_KEY,
        usage,
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
    runs: { engine, markets: definitions },
  });
  owner = await signUp();
  stranger = await signUp();
}, 180_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await testDb?.stop();
});

describe('Gate 2 API', () => {
  it('reports a gate that is not reached yet and refuses writes on it', async () => {
    const run = await seedGate2Run(owner.id);
    expect(await getGate(run.id)).toMatchObject({
      state: 'not_reached',
      runStatus: 'queued',
      claimAuditArtifactId: null,
      openCount: 0,
      variants: [],
      images: [],
    });
    const decided = await decideClaim(run.id, randomUUID(), { choice: 'accept' });
    expect([decided.status, errorCode(decided)]).toEqual([409, 'gate_not_open']);
    const approved = await approve(run.id);
    expect([approved.status, errorCode(approved)]).toEqual([409, 'gate_not_open']);
  });

  it('lists the final draft with its flags, the offered images, and the integrity fallbacks', async () => {
    const run = await gate2Run(FULL_SCENARIO);
    const stored = storedImages.get(run.id);
    if (stored === undefined) throw new Error('no stored images');
    const gate = await getGate(run.id);

    expect(gate).toMatchObject({
      runId: run.id,
      runStatus: 'awaiting_gate',
      state: 'open',
      outputLanguage: 'en',
      stopReason: 'loop_limit',
      approvedPackArtifactId: null,
      approval: null,
      counts: { flaggedClaims: 3, openClaims: 3, offeredImages: 2, openImages: 2 },
      openCount: 5,
      warnings: [],
    });
    expect(gate.passes).toEqual([
      expect.objectContaining({ draftArtifactId: gate.finalDraftArtifactId, flagCount: 4 }),
    ]);
    expect(gate.variants.map((v) => [v.kind, v.segments.length])).toEqual([
      ['portal', 14],
      ['social', 3],
    ]);

    // One entry per flagged claim, every flag of the claim on it.
    const parking = segmentAt(gate, 13);
    expect(parking).toMatchObject({ position: 13, paragraph: 2, decision: null });
    expect(parking.text).toContain('included');
    expect(parking.flags.map((f) => [f.source, f.category])).toEqual([
      ['verifier', 'claim_support'],
      ['verifier', 'investment_promise'],
    ]);
    expect(parking.verifierVerdict).toBe('flagged');
    expect(segmentAt(gate, 0).flags).toEqual([
      expect.objectContaining({
        source: 'validator',
        code: 'number_not_in_facts',
        suggestion: null,
      }),
    ]);
    // Unflagged segments carry no flags and need no decision.
    const social = segmentAt(gate, 15);
    expect(social).toMatchObject({ position: 1, flags: [], decision: null });
    expect(social.validatorResult).toBe('pass');

    // Every cited fact comes with its provenance for the evidence inspector.
    const factIds = new Set(gate.facts.map((f) => f.id));
    for (const segment of gate.variants.flatMap((v) => v.segments)) {
      expect(segment.factIds.every((id) => factIds.has(id))).toBe(true);
    }
    expect(gate.facts.every((f) => f.status === 'verified')).toBe(true);

    // Only the integrity check's final images are offered, with their originals.
    const [livingAttempts, bedroomAttempts] = stored.attempts;
    expect(gate.images.map((i) => [i.artifactId, i.materialId, i.integrity.outcome])).toEqual([
      [livingAttempts?.[0], stored.materials[0], 'passed'],
      [bedroomAttempts?.[1], stored.materials[1], 'passed_on_retry'],
    ]);
    const bedroom = gate.images[1];
    expect(bedroom).toMatchObject({
      operation: { id: 'furnish_bedroom', kind: 'furnish' },
      disclosureLabel: 'Virtually staged',
      stored: { width: 1000, height: 750 },
      decision: null,
    });
    expect(bedroom?.integrity.attempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: 'checked',
        stagedArtifactId: bedroomAttempts?.[0],
        passed: false,
        failedClasses: ['window'],
      }),
      expect.objectContaining({ attempt: 2, status: 'checked', passed: true, failedClasses: [] }),
    ]);
    expect(bedroom?.integrity.classes).toContainEqual({
      label: 'window',
      originalCount: 1,
      editCount: 1,
      worstMatchedIoU: 1,
    });
    expect(gate.integrityFallbacks).toEqual([
      {
        materialId: stored.materials[2],
        operationId: 'furnish_dining_room',
        attempts: [
          expect.objectContaining({ attempt: 1, status: 'checked', passed: false }),
          expect.objectContaining({ attempt: 2, status: 'edit_failed', reason: 'no_image' }),
        ],
      },
    ]);
  });

  it('decides, changes, and validates decisions, and exports only after the approval', async () => {
    const run = await gate2Run(FULL_SCENARIO);
    const stored = storedImages.get(run.id);
    if (stored === undefined) throw new Error('no stored images');
    const gate = await getGate(run.id);
    const living = segmentAt(gate, 0);
    const label = segmentAt(gate, 2);
    const parking = segmentAt(gate, 13);
    const [passedImage, retryImage] = gate.images.map((i) => i.artifactId);
    if (passedImage === undefined || retryImage === undefined) throw new Error('no images');

    // Export is blocked while anything is undecided.
    const early = await approve(run.id);
    expect([early.status, errorCode(early)]).toEqual([409, 'gate_decisions_pending']);

    // accept, then the same body again: nothing changes, not even the time
    const accepted = parsed(await decideClaim(run.id, living.claimId, { choice: 'accept' }));
    expect(accepted).toMatchObject({ openCount: 4, state: 'open' });
    const firstDecision = segmentAt(accepted, 0).decision;
    expect(firstDecision?.choice).toBe('accept');
    const repeated = parsed(await decideClaim(run.id, living.claimId, { choice: 'accept' }));
    expect(segmentAt(repeated, 0).decision).toEqual(firstDecision);

    // An edit must pass the claim validator against the claim's own citations.
    const invalid = await decideClaim(run.id, parking.claimId, {
      choice: 'edit',
      text: 'Parking is in front of the door, and there is an external storage of about 8 m².',
    });
    expect([invalid.status, errorCode(invalid)]).toEqual([400, 'claim_edit_rejected']);
    const findings = apiErrorSchema.parse(invalid.body).findings ?? [];
    expect(findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(['approximate_number', 'number_not_in_facts']),
    );
    expect(findings.every((f) => f.segmentIndex === 13 && f.variant === 'portal')).toBe(true);
    expect(segmentAt(await getGate(run.id), 13).decision).toBeNull();

    const editedText =
      'Parking is in front of the door without paid parking, and there is a 6 m² external storage.';
    const edited = parsed(
      await decideClaim(run.id, parking.claimId, {
        choice: 'edit',
        text: `  ${editedText.replace(' and ', '\n and  ')}  `,
      }),
    );
    expect(segmentAt(edited, 13).decision).toMatchObject({ choice: 'edit', text: editedText });
    // The draft itself is unchanged: the edit lives in the decision.
    expect(segmentAt(edited, 13).text).toBe(parking.text);

    // remove: the portal's only energy-label segment, so the UI is warned
    const removed = parsed(await decideClaim(run.id, label.claimId, { choice: 'remove' }));
    expect(segmentAt(removed, 2).decision?.choice).toBe('remove');
    expect(removed.warnings).toEqual([
      {
        kind: 'market_fact_unmentioned',
        variant: 'portal',
        factKey: 'energy_label',
        required: true,
        removedClaimIds: [label.claimId],
      },
    ]);
    // changed while open: accepting it clears the warning; removing it again restores it
    const changed = parsed(await decideClaim(run.id, label.claimId, { choice: 'accept' }));
    expect(changed.warnings).toEqual([]);
    expect(
      parsed(await decideClaim(run.id, label.claimId, { choice: 'remove' })).warnings,
    ).toHaveLength(1);

    // images: accept one, reject the other, then change the rejection back and forth
    expect(parsed(await decideImage(run.id, passedImage, { choice: 'accept' })).openCount).toBe(1);
    parsed(await decideImage(run.id, retryImage, { choice: 'accept' }));
    const imagesDone = parsed(await decideImage(run.id, retryImage, { choice: 'reject' }));
    expect(imagesDone.images.map((i) => i.decision?.choice)).toEqual(['accept', 'reject']);
    expect(imagesDone).toMatchObject({ openCount: 0, state: 'open' });

    // refusals: unflagged claims, failed or unknown images, and malformed bodies
    const unflagged = await decideClaim(run.id, segmentAt(gate, 15).claimId, { choice: 'accept' });
    expect([unflagged.status, errorCode(unflagged)]).toEqual([404, 'not_found']);
    const failedAttempt = await decideImage(run.id, stored.attempts[1]?.[0] ?? '', {
      choice: 'accept',
    });
    expect([failedAttempt.status, errorCode(failedAttempt)]).toEqual([404, 'not_found']);
    const fallback = await decideImage(run.id, stored.attempts[2]?.[0] ?? '', { choice: 'accept' });
    expect([fallback.status, errorCode(fallback)]).toEqual([404, 'not_found']);
    const audit = await decideImage(run.id, gate.claimAuditArtifactId ?? '', { choice: 'accept' });
    expect([audit.status, errorCode(audit)]).toEqual([404, 'not_found']);
    for (const body of [
      { choice: 'reject' },
      { choice: 'edit' },
      { choice: 'edit', text: '   ' },
      { choice: 'edit', text: 'x'.repeat(2001) },
      { choice: 'edit', text: editedText, factIds: [] },
      { choice: 'accept', text: editedText },
    ]) {
      const response = await owner.agent.put(claimPath(run.id, parking.claimId)).send(body);
      expect([response.status, errorCode(response)]).toEqual([400, 'validation_failed']);
    }
    const removeImage = await owner.agent
      .put(imagePath(run.id, passedImage))
      .send({ choice: 'remove' });
    expect([removeImage.status, errorCode(removeImage)]).toEqual([400, 'validation_failed']);
    const approveBody = await owner.agent.post(approvePath(run.id)).send({ force: true });
    expect([approveBody.status, errorCode(approveBody)]).toEqual([400, 'validation_failed']);

    // Everything decided, but nothing is applied or resumed without the sign-off.
    expect((await getRun(testDb.db, run.id))?.status).toBe('awaiting_gate');
    expect(await stepJobCount(run.id, 'export')).toBe(0);
    expect(await approvedPacks(run.id)).toEqual([]);

    // The approval resumes the run in its own transaction: the export job exists at once.
    const released = parsed(await owner.agent.post(approvePath(run.id)).send({}));
    expect(released).toMatchObject({ state: 'released', openCount: 0 });
    expect(released.runStatus).not.toBe('awaiting_gate');
    expect(released.approval?.decidedBy).toBe(owner.id);
    expect(await stepJobCount(run.id, 'export')).toBe(1);
    await waitForStatus(run.id, 'completed');
    expect(exported.filter((id) => id === run.id)).toHaveLength(1);

    // The approved pack: what P3-09 exports.
    const [packArtifact, ...morePacks] = await approvedPacks(run.id);
    expect(morePacks).toEqual([]);
    expect(packArtifact?.id).toBe(released.approvedPackArtifactId);
    expect(packArtifact?.stepId).toBe(CLAIM_AUDIT_GATE_STEP_ID);
    const pack = approvedPackContentSchema.parse(packArtifact?.content);
    expect(pack).toMatchObject({
      claimAuditArtifactId: gate.claimAuditArtifactId,
      finalDraftArtifactId: gate.finalDraftArtifactId,
      integrityChecksArtifactId: gate.integrityChecksArtifactId,
      outputLanguage: 'en',
      removedClaimIds: [label.claimId],
      approvedBy: owner.id,
      approvedAt: released.approval?.decidedAt,
      warnings: released.warnings,
    });
    const [portal, socialVariant] = pack.variants;
    expect(portal?.segments.map((s) => s.index)).toEqual([
      0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(portal?.segments.find((s) => s.index === 0)?.origin).toBe('accepted');
    expect(portal?.segments.find((s) => s.index === 13)).toMatchObject({
      origin: 'edited',
      text: editedText,
      factIds: parking.factIds,
    });
    expect(portal?.segments.find((s) => s.index === 1)).toMatchObject({
      origin: 'unflagged',
      text: segmentAt(gate, 1).text,
    });
    expect(socialVariant?.segments.map((s) => s.origin)).toEqual([
      'unflagged',
      'unflagged',
      'unflagged',
    ]);
    expect(pack.images).toEqual([
      expect.objectContaining({
        materialId: stored.materials[0],
        decision: 'accept',
        publishedArtifactId: passedImage,
      }),
      expect.objectContaining({
        materialId: stored.materials[1],
        integrityOutcome: 'passed_on_retry',
        offeredArtifactId: retryImage,
        decision: 'reject',
        publishedArtifactId: null,
      }),
      expect.objectContaining({
        materialId: stored.materials[2],
        integrityOutcome: 'fallback_original',
        offeredArtifactId: null,
        decision: null,
        publishedArtifactId: null,
      }),
    ]);

    expect(await gateDecidedEvents(run.id)).toEqual([
      {
        gate: 'claim_audit',
        stepId: 'verification',
        approvedPackArtifactId: packArtifact?.id,
        flaggedClaimCount: 3,
        acceptedClaimCount: 1,
        editedClaimCount: 1,
        removedClaimCount: 1,
        offeredImageCount: 2,
        acceptedImageCount: 1,
        rejectedImageCount: 1,
        warningCount: 1,
      },
    ]);
    // No copy text in the event log.
    const events = JSON.stringify((await listRunEvents(testDb.db, run.id)).map((e) => e.payload));
    expect(events).not.toMatch(/Parking|storage|energy label|included/i);

    // Released: decisions and the approval are final.
    const late = await decideClaim(run.id, label.claimId, { choice: 'accept' });
    expect([late.status, errorCode(late)]).toEqual([409, 'gate_not_open']);
    const lateImage = await decideImage(run.id, retryImage, { choice: 'accept' });
    expect([lateImage.status, errorCode(lateImage)]).toEqual([409, 'gate_not_open']);
    const again = await approve(run.id);
    expect([again.status, errorCode(again)]).toEqual([409, 'gate_not_open']);
    const after = await getGate(run.id);
    expect(after).toMatchObject({ state: 'released', runStatus: 'completed', openCount: 0 });
    expect(segmentAt(after, 13).decision?.choice).toBe('edit');
  });

  it('still waits for an explicit approval when there is nothing to decide', async () => {
    const run = await gate2Run({
      flags: [],
      images: [{ outcome: 'fallback_original', operationId: 'furnish_living_room' }],
    });
    const gate = await getGate(run.id);
    expect(gate).toMatchObject({
      state: 'open',
      stopReason: 'clean',
      counts: { flaggedClaims: 0, openClaims: 0, offeredImages: 0, openImages: 0 },
      openCount: 0,
      images: [],
    });
    expect(gate.integrityFallbacks).toHaveLength(1);

    // Nothing open is not a release: the run waits for the sign-off.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await getRun(testDb.db, run.id))?.status).toBe('awaiting_gate');
    expect(await stepJobCount(run.id, 'export')).toBe(0);

    const released = parsed(await approve(run.id));
    expect(released.state).toBe('released');
    await waitForStatus(run.id, 'completed');
    expect(exported.filter((id) => id === run.id)).toHaveLength(1);
    const [packArtifact] = await approvedPacks(run.id);
    const pack = approvedPackContentSchema.parse(packArtifact?.content);
    expect(pack.variants.flatMap((v) => v.segments).every((s) => s.origin === 'unflagged')).toBe(
      true,
    );
    expect(pack.variants.flatMap((v) => v.segments)).toHaveLength(17);
    expect(pack).toMatchObject({ removedClaimIds: [], warnings: [] });
    expect(pack.images).toEqual([
      expect.objectContaining({ integrityOutcome: 'fallback_original', publishedArtifactId: null }),
    ]);
    expect(await gateDecidedEvents(run.id)).toEqual([
      expect.objectContaining({ gate: 'claim_audit', flaggedClaimCount: 0, offeredImageCount: 0 }),
    ]);
  });

  it('serializes concurrent decisions and resumes exactly once on concurrent approvals', async () => {
    const run = await gate2Run({
      flags: [{ index: 13, category: 'claim_support', problem: '"included" is not stated.' }],
      images: [{ outcome: 'passed', operationId: 'furnish_living_room' }],
    });
    const gate = await getGate(run.id);
    const parking = segmentAt(gate, 13);
    const image = gate.images[0]?.artifactId ?? '';

    // The last two decisions at once: both recorded, neither resumes.
    const decided = await Promise.all([
      decideClaim(run.id, parking.claimId, { choice: 'remove' }),
      decideImage(run.id, image, { choice: 'accept' }),
    ]);
    expect(decided.map((r) => r.status)).toEqual([200, 200]);
    expect(await getGate(run.id)).toMatchObject({ state: 'open', openCount: 0 });
    expect((await getRun(testDb.db, run.id))?.status).toBe('awaiting_gate');

    // Two approvals at once: one resumes, the other finds the gate released.
    const approvals = await Promise.all([approve(run.id), approve(run.id)]);
    expect(approvals.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(approvals.map((r) => (r.status === 409 ? errorCode(r) : 'ok')).sort()).toEqual([
      'gate_not_open',
      'ok',
    ]);
    await waitForStatus(run.id, 'completed');
    expect(exported.filter((id) => id === run.id)).toHaveLength(1);
    expect(await stepJobCount(run.id, 'export')).toBe(1);
    expect(await approvedPacks(run.id)).toHaveLength(1);
    expect(await gateDecidedEvents(run.id)).toHaveLength(1);
    const leftGate = (await listRunEvents(testDb.db, run.id)).filter(
      (e) => e.type === 'run_status_changed' && e.payload['from'] === 'awaiting_gate',
    );
    expect(leftGate).toHaveLength(1);
  });

  it('requires a session, hides other users’ runs, and refuses cross-origin and non-JSON writes', async () => {
    const run = await gate2Run({
      flags: [{ index: 13, category: 'claim_support', problem: '"included" is not stated.' }],
      images: [{ outcome: 'passed', operationId: 'furnish_living_room' }],
    });
    const gate = await getGate(run.id);
    const claimId = segmentAt(gate, 13).claimId;
    const image = gate.images[0]?.artifactId ?? '';
    const anonymous = request(app);

    for (const response of [
      await anonymous.get(gatePath(run.id)),
      await anonymous.put(claimPath(run.id, claimId)).send({ choice: 'accept' }),
      await anonymous.put(imagePath(run.id, image)).send({ choice: 'accept' }),
      await anonymous.post(approvePath(run.id)),
    ]) {
      expect([response.status, errorCode(response)]).toEqual([401, 'unauthenticated']);
    }

    // Another user's run and a run that does not exist look the same.
    for (const response of [
      await stranger.agent.get(gatePath(run.id)),
      await decideClaim(run.id, claimId, { choice: 'accept' }, stranger),
      await decideImage(run.id, image, { choice: 'accept' }, stranger),
      await approve(run.id, stranger),
      await owner.agent.get(gatePath(randomUUID())),
    ]) {
      expect([response.status, errorCode(response)]).toEqual([404, 'not_found']);
    }
    const malformed = await owner.agent.get(gatePath('not-a-uuid'));
    expect([malformed.status, errorCode(malformed)]).toEqual([400, 'validation_failed']);
    const malformedClaim = await owner.agent
      .put(claimPath(run.id, 'not-a-uuid'))
      .send({ choice: 'accept' });
    expect([malformedClaim.status, errorCode(malformedClaim)]).toEqual([400, 'validation_failed']);

    for (const response of [
      await owner.agent
        .put(claimPath(run.id, claimId))
        .set('Origin', 'https://attacker.example')
        .send({ choice: 'accept' }),
      await owner.agent.post(approvePath(run.id)).set('Sec-Fetch-Site', 'cross-site'),
    ]) {
      expect([response.status, errorCode(response)]).toEqual([403, 'forbidden_origin']);
    }
    for (const response of [
      await owner.agent.put(claimPath(run.id, claimId)).type('form').send('choice=accept'),
      await owner.agent.post(approvePath(run.id)).type('text').send('approve'),
    ]) {
      expect([response.status, errorCode(response)]).toEqual([415, 'unsupported_media_type']);
    }

    // None of them recorded anything.
    expect(await getGate(run.id)).toMatchObject({ state: 'open', openCount: 2, approval: null });
    const sameOrigin = await owner.agent
      .put(claimPath(run.id, claimId))
      .set('Origin', APP_ORIGIN)
      .send({ choice: 'accept' });
    expect(sameOrigin.status).toBe(200);
  });
});
