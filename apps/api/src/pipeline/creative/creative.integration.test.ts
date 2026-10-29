import { randomUUID } from 'node:crypto';
import {
  LISTING_COPY_ARTIFACT_KIND,
  PHOTO_INVENTORY_ARTIFACT_KIND,
  claimValidatorDetailsSchema,
  copyGeneratedPayloadSchema,
  listingCopyContentSchema,
  type ServiceDefinition,
} from '@evidomo/shared';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertArtifact, listArtifacts } from '../../db/repositories/artifacts.ts';
import { listClaims } from '../../db/repositories/claims.ts';
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
import { buildCopyInput, buildListingCopyContent } from './generate.ts';
import { createCreativeHandler, loadCopySources, storeListingCopy } from './handler.ts';
import {
  COPY_CASSETTES,
  COPY_INCLUDED_CASSETTES,
  COPY_MATCH,
  creativeService,
  placeholderArtifactIds,
  RECORDED_OFFICE_PROFILE,
  replayPostGateFacts,
  type PostGateFacts,
} from './testing.ts';

// The creative step through the run engine, against PostgreSQL (Testcontainers) and the recorded
// Spark answers (en and nl) over the recorded post-Gate-1 facts, which are inserted directly,
// exactly as reconciliation and the Gate 1 API leave them.

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let replay: MetaReplay;
let definitions: DefinitionRegistry;
let service: ServiceDefinition;
let recorded: PostGateFacts;
let holdResult: ((runId: string, execution: number) => Promise<void>) | undefined;

/** A run whose earlier steps are done: the photo inventory and the post-Gate-1 facts. */
async function seedCreativeRun(
  options: { outputLanguage?: string; facts?: (facts: NewFact[]) => NewFact[] } = {},
): Promise<Run> {
  const outputLanguage = options.outputLanguage ?? 'en';
  const user = await seedUser(testDb.db);
  const project = await seedProject(testDb.db, user.id, {
    officeProfile: RECORDED_OFFICE_PROFILE,
    outputLanguage,
  });
  const run = await seedRun(testDb.db, project.id, {
    serviceId: service.id,
    serviceVersion: service.version,
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
  await insertFacts(testDb.db, run.id, options.facts?.(facts) ?? facts);
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
  service = creativeService(definitions);

  replay = createMetaReplay({
    cassette: COPY_CASSETTES.en,
    include: [...COPY_INCLUDED_CASSETTES, COPY_CASSETTES.nl],
    match: COPY_MATCH,
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

  const create = createCreativeHandler({ markets: definitions });
  const creative: StepHandler<'creative'> = async (context) => {
    const result = await create(context);
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
    handlers: { creative, exporter: () => Promise.resolve(undefined) },
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

describe('creative step', () => {
  it('stores the copy artifact, one claim per segment citing verified facts, and a count-only event', async () => {
    const run = await seedCreativeRun();

    await engine.startRun(run.id);
    await waitForStatus(run.id, 'completed');
    replay.assertAllMatched();

    const [artifact, ...more] = await listArtifacts(testDb.db, run.id, {
      kind: LISTING_COPY_ARTIFACT_KIND,
    });
    expect(more).toEqual([]);
    const content = listingCopyContentSchema.parse(artifact?.content);
    expect(content).toMatchObject({
      outputLanguage: 'en',
      tone: RECORDED_OFFICE_PROFILE.tone,
      revision: 0,
      previousArtifactId: null,
      modelRun: {
        model: 'muse-spark-1.3',
        reasoningEffort: 'medium',
        maxOutputTokens: 16000,
        fallbackFrom: null,
      },
    });

    // Claims mirror the segments and cite only the run's verified facts (including the Gate 1
    // decision when cited); the claim validator passed every segment (P3-02), and nothing has
    // been verified yet.
    const segments = content.variants.flatMap((variant) => variant.segments);
    const claims = await listClaims(testDb.db, artifact?.id ?? '');
    expect(claims.map((c) => [c.segmentIndex, c.text, c.factIds])).toEqual(
      segments.map((s) => [s.index, s.text, s.factIds]),
    );
    expect(content.validation).toMatchObject({ result: 'pass', counts: { findings: 0 } });
    for (const claim of claims) {
      expect(claim.validatorResult).toBe('pass');
      expect(claim.validatorDetails).toEqual({ rulesVersion: 1, findings: [] });
      expect(claim.verifierVerdict).toBeNull();
    }
    const verified = new Set(
      (await listFacts(testDb.db, run.id, { status: 'verified' })).map((f) => f.id),
    );
    for (const claim of claims) {
      expect(claim.factIds.length).toBeGreaterThan(0);
      for (const id of claim.factIds) expect(verified.has(id)).toBe(true);
    }
    expect(new Set(content.catalog.flatMap((entry) => entry.factIds))).toEqual(verified);

    const steps = await listRunSteps(testDb.db, run.id);
    expect(steps.find((s) => s.stepId === 'creative')).toMatchObject({
      status: 'completed',
      outputArtifactIds: [artifact?.id],
    });

    // One Spark call: 4,648 in + 7,064 out.
    const usage = await listUsageForRun(testDb.db, run.id);
    expect(
      usage.map((u) => [u.modelId, u.inputTokens, u.outputTokens, u.estimatedCostUsd]),
    ).toEqual([['muse-spark-1.3', 4648, 7064, '0.03583200']]);

    const events = await listRunEvents(testDb.db, run.id);
    const summary = copyGeneratedPayloadSchema.parse(
      events.find((e) => e.type === 'copy_generated')?.payload,
    );
    const portal = content.variants[0]?.segments.length ?? 0;
    expect(summary).toEqual({
      stepId: 'creative',
      artifactId: artifact?.id,
      revision: 0,
      outputLanguage: 'en',
      catalogFactCount: content.counts.catalogFacts,
      citedFactCount: content.counts.citedCatalogFacts,
      portalSegmentCount: portal,
      socialSegmentCount: segments.length - portal,
      claimCount: claims.length,
      mergedUncitedCount: 0,
      droppedUncitedParagraphCount: 0,
      validatorResult: 'pass',
      validatorFailedSegmentCount: 0,
      validatorFindingCount: 0,
      model: 'muse-spark-1.3',
      fallbackUsed: false,
    });
    // No copy text, fact key, or value in any event.
    const serialized = JSON.stringify(events.map((e) => e.payload));
    expect(serialized).not.toMatch(/Zandmeer|living|balcony|m²|apartment|energy/i);

    // Copy and claims are personal data: deleting the project removes them with the run.
    await deleteProject(testDb.db, run.projectId);
    expect(await listArtifacts(testDb.db, run.id)).toEqual([]);
    expect(await listClaims(testDb.db, artifact?.id ?? '')).toEqual([]);
  });

  it('writes the copy in the run output language (nl)', async () => {
    const run = await seedCreativeRun({ outputLanguage: 'nl' });

    await engine.startRun(run.id);
    await waitForStatus(run.id, 'completed');
    replay.assertAllMatched();

    const [artifact] = await listArtifacts(testDb.db, run.id, { kind: LISTING_COPY_ARTIFACT_KIND });
    const content = listingCopyContentSchema.parse(artifact?.content);
    expect(content.outputLanguage).toBe('nl');
    expect(content.variants.map((v) => [v.kind, v.languageCheck])).toEqual([
      ['portal', 'match'],
      ['social', 'match'],
    ]);
  });

  it('keeps a draft that fails the claim validator and stores the findings on its claims', async () => {
    // A revision-style draft with seeded defects, stored the way the creative step and
    // verification's revisions store copy: nothing is dropped, failing segments are marked.
    const run = await seedCreativeRun();
    const market = definitions.getMarket(run.marketProfileId, run.marketProfileVersion);
    const sources = await loadCopySources(testDb.db, run, market);
    const catalogId = (key: string): string => {
      const entry = sources.catalog.facts.find((fact) => fact.key === key && !fact.presence);
      if (entry === undefined) throw new Error(`No catalog fact ${key}`);
      return entry.id;
    };
    const area = catalogId('living_area');
    const year = catalogId('build_year');
    const factIdsOf = (id: string): string[] => [...(sources.catalog.byId.get(id)?.factIds ?? [])];
    const segment = (index: number, text: string, ids: string[]) => ({
      index,
      paragraph: 0,
      text,
      catalogIds: ids,
      factIds: ids.flatMap(factIdsOf),
    });
    const input = buildCopyInput(sources);
    const content = buildListingCopyContent({
      generated: {
        copy: {
          variants: [
            {
              kind: 'portal',
              languageCheck: 'inconclusive',
              segments: [
                segment(0, 'This apartment offers 92 m² of living space.', [area]),
                segment(1, 'It was built in about 1987, renovated in 2015.', [year]),
              ],
            },
            {
              kind: 'social',
              languageCheck: 'inconclusive',
              segments: [segment(2, 'Some 95 m² to enjoy.', [area])],
            },
          ],
          repairs: { mergedUncited: 0, droppedUncitedParagraphs: 0, droppedEmpty: 0 },
          citedCatalogIds: [area, year],
        },
        modelRun: {
          model: 'muse-spark-1.3',
          reasoningEffort: 'medium',
          maxOutputTokens: 16000,
          fallbackFrom: null,
        },
      },
      catalog: sources.catalog,
      facts: sources.facts,
      input,
      revision: 0,
      previousArtifactId: null,
    });

    const stored = await testDb.db.transaction((tx) =>
      storeListingCopy(tx, { runId: run.id, stepId: 'creative', content }),
    );

    const persisted = listingCopyContentSchema.parse(stored.artifact.content);
    expect(persisted.validation).toMatchObject({
      result: 'fail',
      counts: { segments: 3, failedSegments: 2, findings: 4 },
    });
    const claims = await listClaims(testDb.db, stored.artifact.id);
    expect(claims.map((c) => c.text)).toEqual(
      content.variants.flatMap((v) => v.segments.map((s) => s.text)),
    );
    expect(claims.map((c) => c.validatorResult)).toEqual(['pass', 'fail', 'fail']);
    const details = claims.map((claim) =>
      claimValidatorDetailsSchema
        .parse(claim.validatorDetails)
        .findings.map((f) => [f.variant, f.segmentIndex, f.code, f.token]),
    );
    expect(details).toEqual([
      [],
      [
        ['portal', 1, 'approximate_number', 'about 1987'],
        ['portal', 1, 'number_not_in_facts', '2015'],
      ],
      [
        ['social', 2, 'number_not_in_facts', '95 m²'],
        ['social', 2, 'approximate_number', 'Some 95 m²'],
      ],
    ]);
    expect(stored.summary).toMatchObject({
      validatorResult: 'fail',
      validatorFailedSegmentCount: 2,
      validatorFindingCount: 4,
    });
    // The event carries the counts only, never a token (digits would also match UUIDs).
    const events = await listRunEvents(testDb.db, run.id);
    const serialized = JSON.stringify(events.map((e) => e.payload));
    expect(serialized).not.toMatch(/m²|about|Some|number_not_in_facts|approximate/);
  });

  it('fails the run without a model call when nothing is citable or the language is not offered', async () => {
    const noFacts = await seedCreativeRun({
      facts: (facts) => facts.map((fact) => ({ ...fact, status: 'rejected' as const })),
    });
    await engine.startRun(noFacts.id);
    const failed = await waitForStatus(noFacts.id, 'failed');
    expect(failed.failureReason).toContain('no verified facts');

    const german = await seedCreativeRun({ outputLanguage: 'de' });
    await engine.startRun(german.id);
    const failedGerman = await waitForStatus(german.id, 'failed');
    expect(failedGerman.failureReason).toContain('Output language "de" is not offered');

    expect(await listUsageForRun(testDb.db, noFacts.id)).toEqual([]);
    expect(await listUsageForRun(testDb.db, german.id)).toEqual([]);
  });

  it('commits one copy when a superseded execution finishes after its replacement', async () => {
    const run = await seedCreativeRun();
    await transitionRun(testDb.db, run.id, { to: 'running' });
    const jobId = randomUUID();
    const data: StepJobData = { runId: run.id, stepId: 'creative', attempt: 1 };
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
    await waitForStatus(run.id, 'completed');

    const artifacts = await listArtifacts(testDb.db, run.id, { kind: LISTING_COPY_ARTIFACT_KIND });
    expect(artifacts).toHaveLength(1);
    const events = await listRunEvents(testDb.db, run.id);
    expect(events.filter((e) => e.type === 'copy_generated')).toHaveLength(1);
    // Both executions called Spark, so both are billed.
    expect(await listUsageForRun(testDb.db, run.id)).toHaveLength(2);
  });
});
