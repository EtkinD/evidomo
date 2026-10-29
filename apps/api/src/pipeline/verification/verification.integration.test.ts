import {
  CLAIM_AUDIT_ARTIFACT_KIND,
  LISTING_COPY_ARTIFACT_KIND,
  PHOTO_INVENTORY_ARTIFACT_KIND,
  claimAuditContentSchema,
  claimVerifierDetailsSchema,
  claimsAuditedPayloadSchema,
  copyGeneratedPayloadSchema,
  listingCopyContentSchema,
  type ServiceDefinition,
} from '@evidomo/shared';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertArtifact, listArtifacts } from '../../db/repositories/artifacts.ts';
import { listClaims } from '../../db/repositories/claims.ts';
import { insertFacts, type NewFact } from '../../db/repositories/facts.ts';
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
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { createRunEngine, type RunEngine } from '../../runs/engine.ts';
import type { StepHandler } from '../../runs/steps.ts';
import { testRegistry, waitFor } from '../../runs/testing.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { createCreativeHandler } from '../creative/handler.ts';
import {
  placeholderArtifactIds,
  RECORDED_OFFICE_PROFILE,
  replayPostGateFacts,
  type PostGateFacts,
} from '../creative/testing.ts';
import { createVerificationHandler } from './handler.ts';
import {
  VERIFICATION_INCLUDED_CASSETTES,
  VERIFICATION_MATCH,
  verificationCassette,
  verificationService,
} from './testing.ts';

// Creative copy, then verification, through the run engine against PostgreSQL (Testcontainers)
// and the recorded answers: P3-01's drafts (en, nl) and P3-06's audits and revisions. The facts
// are the recorded post-Gate-1 state, inserted directly as reconciliation and Gate 1 leave them.

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let replay: MetaReplay;
let definitions: DefinitionRegistry;
let service: ServiceDefinition;
let noLoops: ServiceDefinition;
let recorded: PostGateFacts;
let beforeVerification: ((run: Run) => Promise<void>) | undefined;

async function seedVerificationRun(
  options: { outputLanguage?: string; service?: ServiceDefinition } = {},
): Promise<Run> {
  const outputLanguage = options.outputLanguage ?? 'en';
  const definition = options.service ?? service;
  const user = await seedUser(testDb.db);
  const project = await seedProject(testDb.db, user.id, {
    officeProfile: RECORDED_OFFICE_PROFILE,
    outputLanguage,
  });
  const run = await seedRun(testDb.db, project.id, {
    serviceId: definition.id,
    serviceVersion: definition.version,
    outputLanguage,
  });
  const inventory = await insertArtifact(testDb.db, {
    runId: run.id,
    stepId: 'vision_inventory',
    kind: PHOTO_INVENTORY_ARTIFACT_KIND,
    content: recorded.inventory,
  });
  const facts = recorded.facts.map((fact): NewFact => {
    const { source } = fact;
    if (source.kind === 'photo_region' && source.maskArtifactId !== undefined) {
      return { ...fact, source: { ...source, maskArtifactId: inventory.id } };
    }
    return fact;
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

beforeAll(async () => {
  testDb = await startTestDatabase();
  definitions = await loadDefinitions();
  service = verificationService(definitions);
  noLoops = {
    ...service,
    id: 'copy-verification-no-loops',
    steps: service.steps.map((step) =>
      step.agent === 'verifier' ? { ...step, max_revision_loops: 0 } : step,
    ),
  };

  replay = createMetaReplay({
    cassette: verificationCassette('loop-en'),
    include: [...VERIFICATION_INCLUDED_CASSETTES, verificationCassette('loop-nl')],
    match: VERIFICATION_MATCH,
    mode: 'replay',
  });
  await replay.start();
  const usage = createInMemoryUsageRecorder();
  recorded = await replayPostGateFacts(
    createMetaClients({ apiKey: replay.apiKey, usage, maxRetries: 0 }),
    usage,
    definitions,
    placeholderArtifactIds(),
  );

  boss = new PgBoss({
    connectionString: testDb.container.getConnectionUri(),
    superviseIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
  });
  boss.on('error', (error) => {
    logger.error({ err: error }, 'pg-boss error in test');
  });
  await boss.start();

  const verify = createVerificationHandler({ markets: definitions });
  const verifier: StepHandler<'verifier'> = async (context) => {
    await beforeVerification?.(context.run);
    return verify(context);
  };
  const estimateCost = createPriceTableCostEstimator();
  engine = createRunEngine({
    db: testDb.db,
    boss,
    registry: testRegistry(service, noLoops),
    logger,
    dailyCapUsd: '5.00',
    handlers: {
      creative: createCreativeHandler({ markets: definitions }),
      verifier,
      exporter: () => Promise.resolve(undefined),
    },
    createMetaClients: (usage) =>
      createMetaClients({ apiKey: replay.apiKey, usage, estimateCost, maxRetries: 0 }),
    heartbeatSeconds: 10,
    expiryGraceSeconds: 5,
    retryDelaySeconds: 0,
  });
  await engine.startWorkers({ pollingIntervalSeconds: 0.5 });
}, 180_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await replay?.stop();
  await testDb?.stop();
});

describe('verification step', () => {
  // The recorded nl draft loops once (two area_basis flags, one revision, a clean re-audit); the
  // recorded en draft is clean on its first pass (docs/model-notes.md, P3-06).
  it('audits the copy, stores the revision and every verdict, and stops at Gate 2 even when clean', async () => {
    const run = await seedVerificationRun({ outputLanguage: 'nl' });

    await engine.startRun(run.id);
    const paused = await waitForStatus(run.id, 'awaiting_gate');
    replay.assertAllMatched();
    expect(paused.gate).toBe('claim_audit');

    // The creative step's draft (revision 0) and verification's revision 1, linked.
    const drafts = await listArtifacts(testDb.db, run.id, { kind: LISTING_COPY_ARTIFACT_KIND });
    expect(drafts.map((d) => d.stepId)).toEqual(['creative', 'verification']);
    const [initial, revised] = drafts.map((d) => listingCopyContentSchema.parse(d.content));
    expect(revised).toMatchObject({ revision: 1, previousArtifactId: drafts[0]?.id });
    expect(revised?.modelRun.model).toBe('muse-spark-1.3');
    expect(initial?.revision).toBe(0);

    const [auditArtifact, ...moreAudits] = await listArtifacts(testDb.db, run.id, {
      kind: CLAIM_AUDIT_ARTIFACT_KIND,
    });
    expect(moreAudits).toEqual([]);
    const audit = claimAuditContentSchema.parse(auditArtifact?.content);
    expect(audit).toMatchObject({
      outputLanguage: 'nl',
      market: { id: 'nl', version: 1 },
      maxRevisionLoops: 2,
      stopReason: 'clean',
      initialDraftArtifactId: drafts[0]?.id,
      finalDraftArtifactId: drafts[1]?.id,
      remainingFlags: [],
      counts: { passes: 2, revisions: 1, verifierCalls: 2, remainingFlags: 0, flaggedClaims: 0 },
      fallbackUsed: false,
    });
    expect(audit.rubric.map((rule) => rule.category)).toEqual([
      'claim_support',
      'unverifiable_superlative',
      'investment_promise',
      'exclusionary',
      'area_basis',
    ]);
    // Portal segment 0 and the caption's first segment (15) state 92 m² without its basis.
    const flagged = new Set([0, 15]);
    const [first, second] = audit.passes;
    expect(
      first?.flags.map((f) => [f.source, f.category, f.code, f.variant, f.segmentIndex, f.carried]),
    ).toEqual([
      ['verifier', 'area_basis', null, 'portal', 0, false],
      ['verifier', 'area_basis', null, 'social', 15, false],
    ]);
    expect(first?.flags.every((f) => f.artifactId === drafts[0]?.id)).toBe(true);
    expect(second).toMatchObject({ auditedSegments: 2, carriedSegments: 16, flags: [] });

    // Verdicts on every claim of both drafts; the flagged claims are the ones the flags point at.
    const initialClaims = await listClaims(testDb.db, drafts[0]?.id ?? '');
    expect(first?.flags.map((f) => f.claimId)).toEqual(
      [0, 15].map((index) => initialClaims.find((c) => c.segmentIndex === index)?.id),
    );
    expect(initialClaims.map((c) => c.verifierVerdict)).toEqual(
      initialClaims.map((c) => (flagged.has(c.segmentIndex) ? 'flagged' : 'supported')),
    );
    const flaggedDetails = claimVerifierDetailsSchema.parse(
      initialClaims.find((c) => c.segmentIndex === 0)?.verifierDetails,
    );
    expect(flaggedDetails).toMatchObject({
      auditArtifactId: auditArtifact?.id,
      pass: 0,
      carried: false,
      flags: [{ category: 'area_basis' }],
    });
    const revisedClaims = await listClaims(testDb.db, drafts[1]?.id ?? '');
    expect(revisedClaims.every((c) => c.verifierVerdict === 'supported')).toBe(true);
    expect(revisedClaims.every((c) => c.validatorResult === 'pass')).toBe(true);
    expect(
      revisedClaims.map((c) => claimVerifierDetailsSchema.parse(c.verifierDetails).carried),
    ).toEqual(revisedClaims.map((c) => !flagged.has(c.segmentIndex)));

    // Step output, usage (Wonder, Spark, Wonder for verification), and count-only events.
    const steps = await listRunSteps(testDb.db, run.id);
    expect(steps.find((s) => s.stepId === 'verification')).toMatchObject({
      status: 'completed',
      outputArtifactIds: [auditArtifact?.id, drafts[1]?.id],
      gateReleasedAt: null,
    });
    const usage = await listUsageForRun(testDb.db, run.id);
    expect(usage.filter((u) => u.stepId === 'verification').map((u) => u.modelId)).toEqual([
      'muse-wonder-1.0',
      'muse-spark-1.3',
      'muse-wonder-1.0',
    ]);

    const events = await listRunEvents(testDb.db, run.id);
    const copies = events
      .filter((e) => e.type === 'copy_generated')
      .map((e) => copyGeneratedPayloadSchema.parse(e.payload));
    expect(copies.map((c) => [c.stepId, c.revision])).toEqual([
      ['creative', 0],
      ['verification', 1],
    ]);
    expect(
      claimsAuditedPayloadSchema.parse(events.find((e) => e.type === 'claims_audited')?.payload),
    ).toEqual({
      stepId: 'verification',
      artifactId: auditArtifact?.id,
      finalDraftArtifactId: drafts[1]?.id,
      passCount: 2,
      revisionCount: 1,
      verifierCallCount: 2,
      stopReason: 'clean',
      remainingFlagCount: 0,
      remainingValidatorFlagCount: 0,
      remainingVerifierFlagCount: 0,
      flaggedClaimCount: 0,
      model: 'muse-wonder-1.0',
      fallbackUsed: false,
    });
    expect(events.find((e) => e.type === 'gate_opened')?.payload).toEqual({
      gate: 'claim_audit',
      stepId: 'verification',
    });
    // No copy text, problem, or suggestion in any event.
    const serialized = JSON.stringify(events.map((e) => e.payload));
    expect(serialized).not.toMatch(/woonoppervlakte|NEN 2580|Zandmeer|m²|area_basis/i);
  });

  it('stops after one audit, without a revision, when the English copy is clean', async () => {
    const run = await seedVerificationRun();
    await engine.startRun(run.id);
    await waitForStatus(run.id, 'awaiting_gate');
    replay.assertAllMatched();

    const drafts = await listArtifacts(testDb.db, run.id, { kind: LISTING_COPY_ARTIFACT_KIND });
    expect(drafts.map((d) => d.stepId)).toEqual(['creative']);
    const [auditArtifact] = await listArtifacts(testDb.db, run.id, {
      kind: CLAIM_AUDIT_ARTIFACT_KIND,
    });
    const audit = claimAuditContentSchema.parse(auditArtifact?.content);
    expect(audit).toMatchObject({
      outputLanguage: 'en',
      stopReason: 'clean',
      initialDraftArtifactId: drafts[0]?.id,
      finalDraftArtifactId: drafts[0]?.id,
      remainingFlags: [],
      counts: { passes: 1, revisions: 0, verifierCalls: 1, remainingFlags: 0 },
    });
    expect(audit.passes.map((p) => [p.revision, p.flags.length, p.auditedSegments])).toEqual([
      [0, 0, 17],
    ]);
    const claims = await listClaims(testDb.db, drafts[0]?.id ?? '');
    expect(claims.every((c) => c.verifierVerdict === 'supported')).toBe(true);
    const usage = await listUsageForRun(testDb.db, run.id);
    expect(usage.filter((u) => u.stepId === 'verification').map((u) => u.modelId)).toEqual([
      'muse-wonder-1.0',
    ]);
  });

  it('stores the flags that remain for Gate 2 when no revision loop is left', async () => {
    const run = await seedVerificationRun({ service: noLoops, outputLanguage: 'nl' });
    await engine.startRun(run.id);
    const paused = await waitForStatus(run.id, 'awaiting_gate');
    replay.assertAllMatched();
    expect(paused.gate).toBe('claim_audit');

    const drafts = await listArtifacts(testDb.db, run.id, { kind: LISTING_COPY_ARTIFACT_KIND });
    expect(drafts.map((d) => d.stepId)).toEqual(['creative']);
    const [auditArtifact] = await listArtifacts(testDb.db, run.id, {
      kind: CLAIM_AUDIT_ARTIFACT_KIND,
    });
    const audit = claimAuditContentSchema.parse(auditArtifact?.content);
    const claims = await listClaims(testDb.db, drafts[0]?.id ?? '');
    expect(audit).toMatchObject({
      stopReason: 'loop_limit',
      maxRevisionLoops: 0,
      finalDraftArtifactId: drafts[0]?.id,
      counts: {
        passes: 1,
        revisions: 0,
        remainingFlags: 2,
        remainingVerifierFlags: 2,
        flaggedClaims: 2,
      },
    });
    expect(
      audit.remainingFlags.map((f) => [f.source, f.category, f.claimId, f.suggestion !== null]),
    ).toEqual(
      [0, 15].map((index) => [
        'verifier',
        'area_basis',
        claims.find((c) => c.segmentIndex === index)?.id,
        true,
      ]),
    );
    for (const flag of audit.remainingFlags) expect(flag.problem).toContain('92 m²');
    const events = await listRunEvents(testDb.db, run.id);
    expect(
      claimsAuditedPayloadSchema.parse(events.find((e) => e.type === 'claims_audited')?.payload),
    ).toMatchObject({ stopReason: 'loop_limit', remainingFlagCount: 2, flaggedClaimCount: 2 });
  });

  it('fails without a model call when the verified facts changed after the copy was written', async () => {
    const run = await seedVerificationRun();
    beforeVerification = async (current) => {
      if (current.id !== run.id) return;
      await insertFacts(testDb.db, run.id, [
        {
          stepId: 'test',
          key: 'other:late_fact',
          value: 'added after the copy',
          source: { kind: 'form', field: 'late_fact' },
          status: 'verified',
          assertion: 'stated',
        },
      ]);
    };
    try {
      await engine.startRun(run.id);
      const failed = await waitForStatus(run.id, 'failed');
      expect(failed.failureReason).toContain(
        'The verified facts changed after the copy was written',
      );
    } finally {
      beforeVerification = undefined;
    }
    const usage = await listUsageForRun(testDb.db, run.id);
    expect(usage.filter((u) => u.stepId === 'verification')).toEqual([]);
  });
});
