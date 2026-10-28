import { randomUUID } from 'node:crypto';
import {
  CLAIM_AUDIT_ARTIFACT_KIND,
  INTEGRITY_CHECKS_ARTIFACT_KIND,
  STAGED_IMAGE_ARTIFACT_KIND,
  STAGED_IMAGE_LABEL,
  claimAuditContentSchema,
  integrityChecksContentSchema,
  type ClaimAuditContent,
  type ClaimAuditFlag,
  type IntegrityPhoto,
  type JsonValue,
  type StagedImageContent,
} from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertArtifact } from '../../db/repositories/artifacts.ts';
import { listClaims, type Claim } from '../../db/repositories/claims.ts';
import { insertFacts } from '../../db/repositories/facts.ts';
import type { Run } from '../../db/repositories/runs.ts';
import {
  seedProject,
  seedRun,
  seedUser,
  startTestDatabase,
  type TestDatabase,
} from '../../db/testing.ts';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createMetaReplay, type MetaReplay } from '../../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { storeListingCopy } from '../creative/handler.ts';
import type { PostGateFacts } from '../creative/testing.ts';
import { evaluatePublicationChecklist } from './evaluate.ts';
import {
  loadPublicationChecklistInput,
  PublicationChecklistInputError,
  type PublicationChecklistRunInput,
} from './load.ts';
import {
  CHECKLIST_REPLAY,
  placeholderArtifactIds,
  replayPostGateFacts,
  replayRecordedNlCopy,
} from './testing.ts';

// The checklist loader against PostgreSQL (Testcontainers): the recorded walkthrough's verified
// facts and recorded "nl" copy (replayed, no model call) stored as the pipeline stores them, a
// claim audit with one remaining flag, and an integrity record with two final staged images.

let testDb: TestDatabase;
let replay: MetaReplay;
let registry: DefinitionRegistry;
let recorded: PostGateFacts;

const usage = createInMemoryUsageRecorder();

interface SeededPack {
  readonly run: Run;
  readonly claims: Claim[];
  readonly flagged: Claim;
  /** Final staged images in manifest order: the first labeled, the second without disclosure. */
  readonly finals: readonly [string, string];
  /** A staged image that failed the integrity check (stored, never final). */
  readonly notFinal: string;
}

function stagedContent(materialId: string): StagedImageContent {
  return {
    schemaVersion: 1,
    promptVersion: 1,
    original: { materialId, sha256: 'a'.repeat(64), width: 1024, height: 682 },
    operation: { id: 'furnish_living_room', kind: 'furnish', text: 'add a sofa' },
    prompt: 'Edit this photo: add a sofa. Change nothing else.',
    model: 'muse-image-1.0',
    requestedSize: '1024x682',
    toolsDisabled: true,
    modelOutput: { format: 'jpeg', width: 1920, height: 1280 },
    stored: {
      mimeType: 'image/jpeg',
      width: 1920,
      height: 1280,
      sizeBytes: 1000,
      sha256: 'b'.repeat(64),
    },
    aspectRatioChange: 0.001,
    disclosure: { label: STAGED_IMAGE_LABEL, visibleLabelRequired: true },
  };
}

function integrityPhoto(
  materialId: string,
  stagedArtifactId: string,
  passed: boolean,
): IntegrityPhoto {
  const image = { width: 1024, height: 682, segments: { window: [] } };
  return {
    materialId,
    operationId: 'furnish_living_room',
    original: image,
    attempts: [
      {
        status: 'checked',
        attempt: 1,
        stagedArtifactId,
        passed,
        edit: image,
        verdict: {
          passed,
          aspectRatioChange: 0,
          failures: [],
          failedClasses: [],
          classes: [],
          thresholds: {
            minIoU: 0.75,
            minContainment: 0.85,
            minAreaRatio: 0.4,
            maxAspectRatioChange: 0.03,
          },
        },
        privacy: { passed: true, phrases: [{ phrase: 'person', count: 0 }] },
      },
    ],
    outcome: passed ? 'passed' : 'fallback_original',
    finalStagedArtifactId: passed ? stagedArtifactId : null,
  };
}

async function seedPack(options: { auditMarketId?: string } = {}): Promise<SeededPack> {
  const db = testDb.db;
  const user = await seedUser(db);
  const project = await seedProject(db, user.id, { outputLanguage: 'nl' });
  const run = await seedRun(db, project.id, { outputLanguage: 'nl' });
  const facts = await insertFacts(db, run.id, recorded.facts);

  const clients = createMetaClients({ apiKey: replay.apiKey, usage, maxRetries: 0 });
  const content = await replayRecordedNlCopy(clients, registry, facts, recorded.inventory);
  const { artifact: draft } = await storeListingCopy(db, {
    runId: run.id,
    stepId: 'verification',
    content,
  });
  const claims = await listClaims(db, draft.id);
  const flagged = claims[1];
  if (flagged === undefined) throw new Error('The recorded copy has at least two segments');

  const flag: ClaimAuditFlag = {
    source: 'verifier',
    category: 'unverifiable_superlative',
    code: null,
    artifactId: draft.id,
    variant: 'portal',
    segment: 1,
    segmentIndex: flagged.segmentIndex,
    claimId: flagged.id,
    problem: 'A superlative no cited fact supports.',
    suggestion: null,
    carried: false,
  };
  const audit: ClaimAuditContent = claimAuditContentSchema.parse({
    schemaVersion: 1,
    promptVersion: 1,
    outputLanguage: 'nl',
    market: { id: options.auditMarketId ?? 'nl', version: 1 },
    rubric: [
      { category: 'claim_support', rule: 'Say only what the cited facts say.' },
      { category: 'unverifiable_superlative', rule: 'No unverifiable superlatives.' },
    ],
    maxRevisionLoops: 0,
    stopReason: 'loop_limit',
    initialDraftArtifactId: draft.id,
    finalDraftArtifactId: draft.id,
    passes: [
      {
        draftArtifactId: draft.id,
        revision: 0,
        segments: claims.length,
        auditedSegments: claims.length,
        carriedSegments: 0,
        modelRun: {
          model: 'muse-wonder-1.0',
          reasoningEffort: 'low',
          maxOutputTokens: 12000,
          fallbackFrom: null,
        },
        flags: [flag],
        dropped: {
          unknownSegment: 0,
          notAudited: 0,
          unknownCategory: 0,
          emptyProblem: 0,
          duplicate: 0,
        },
      },
    ],
    remainingFlags: [flag],
    counts: {
      passes: 1,
      revisions: 0,
      verifierCalls: 1,
      remainingFlags: 1,
      remainingValidatorFlags: 0,
      remainingVerifierFlags: 1,
      flaggedClaims: 1,
      finalClaims: claims.length,
    },
    fallbackUsed: false,
  } satisfies ClaimAuditContent);
  await insertArtifact(db, {
    runId: run.id,
    stepId: 'verification',
    kind: CLAIM_AUDIT_ARTIFACT_KIND,
    content: audit,
  });

  const materials = [randomUUID(), randomUUID(), randomUUID()] as const;
  const staged = async (materialId: string, content: JsonValue) =>
    (
      await insertArtifact(db, {
        runId: run.id,
        stepId: 'staging',
        kind: STAGED_IMAGE_ARTIFACT_KIND,
        content,
      })
    ).id;
  const labeled = await staged(materials[0], stagedContent(materials[0]));
  const { disclosure: _dropped, ...unlabeledContent } = stagedContent(materials[1]);
  const unlabeled = await staged(materials[1], unlabeledContent);
  const failed = await staged(materials[2], stagedContent(materials[2]));
  const photos = [
    integrityPhoto(materials[0], labeled, true),
    integrityPhoto(materials[1], unlabeled, true),
    integrityPhoto(materials[2], failed, false),
  ];
  await insertArtifact(db, {
    runId: run.id,
    stepId: 'integrity',
    kind: INTEGRITY_CHECKS_ARTIFACT_KIND,
    content: integrityChecksContentSchema.parse({
      schemaVersion: 1,
      segmentationModel: 'sam-3.1',
      stagedImagesArtifactId: randomUUID(),
      fixedElements: [{ phrase: 'window', occlusionTolerant: false }],
      thresholds: {
        minIoU: 0.75,
        minContainment: 0.85,
        minAreaRatio: 0.4,
        maxAspectRatioChange: 0.03,
      },
      editPrivacyPhrases: ['person'],
      counts: {
        photos: 3,
        passed: 2,
        passedOnRetry: 0,
        fallbackOriginal: 1,
        retries: 0,
        unchecked: 0,
      },
      photos,
    }),
  });

  return { run, claims, flagged, finals: [labeled, unlabeled], notFinal: failed };
}

const load = (params: PublicationChecklistRunInput) =>
  loadPublicationChecklistInput(testDb.db, registry, params);

beforeAll(async () => {
  testDb = await startTestDatabase();
  registry = await loadDefinitions();
  replay = createMetaReplay(CHECKLIST_REPLAY);
  await replay.start();
  recorded = await replayPostGateFacts(
    createMetaClients({ apiKey: replay.apiKey, usage, maxRetries: 0 }),
    usage,
    registry,
    placeholderArtifactIds(),
  );
});

afterAll(async () => {
  await replay.stop();
  await testDb.stop();
});

describe('loadPublicationChecklistInput', () => {
  it('collects verified facts, the final copy with Gate 2 decisions, the audit, and approved images', async () => {
    const pack = await seedPack();
    const input = await load({
      run: pack.run,
      approvedStagedArtifactIds: [pack.finals[0]],
      claimDecisions: [{ claimId: pack.flagged.id, choice: 'remove' }],
    });
    replay.assertAllMatched();

    expect(input.market).toMatchObject({ id: 'nl', version: 1 });
    expect(input.facts.length).toBe(recorded.facts.filter((f) => f.status === 'verified').length);
    expect(input.facts.every((fact) => fact.status === 'verified')).toBe(true);
    expect(input.copy.segments.map((s) => s.claimId)).toEqual(pack.claims.map((c) => c.id));
    expect(input.copy.segments.filter((s) => s.decision !== null)).toEqual([
      expect.objectContaining({ claimId: pack.flagged.id, decision: 'remove' }),
    ]);
    expect(new Set(input.copy.segments.map((s) => s.variant))).toEqual(
      new Set(['portal', 'social']),
    );
    expect(input.claimAudit).toEqual({
      auditedCategories: ['claim_support', 'unverifiable_superlative'],
      remainingFlags: [expect.objectContaining({ claimId: pack.flagged.id })],
    });
    expect(input.stagedImages).toEqual([
      {
        artifactId: pack.finals[0],
        disclosure: { label: STAGED_IMAGE_LABEL, visibleLabelRequired: true },
      },
    ]);

    const result = evaluatePublicationChecklist(input);
    expect(result.items.map((item) => [item.id, item.status])).toEqual([
      ['energy_label_shown', 'pass'],
      ['staging_disclosed', 'pass'],
    ]);
    expect(result.summary.readyToPublish).toBe(true);
  });

  it('orders approved images by the integrity record and surfaces a missing disclosure', async () => {
    const pack = await seedPack();
    const input = await load({
      run: pack.run,
      approvedStagedArtifactIds: [pack.finals[1], pack.finals[0]],
      claimDecisions: [],
    });
    expect(input.stagedImages).toEqual([
      {
        artifactId: pack.finals[0],
        disclosure: { label: STAGED_IMAGE_LABEL, visibleLabelRequired: true },
      },
      { artifactId: pack.finals[1], disclosure: null },
    ]);
    const result = evaluatePublicationChecklist(input);
    expect(result.items[1]).toMatchObject({
      status: 'fail',
      unlabeledArtifactIds: [pack.finals[1]],
    });
    expect(result.summary.readyToPublish).toBe(false);
  });

  it('refuses Gate 2 inputs that do not fit the stored run', async () => {
    const pack = await seedPack();
    const base = { run: pack.run, approvedStagedArtifactIds: [], claimDecisions: [] };
    await expect(load({ ...base, approvedStagedArtifactIds: [pack.notFinal] })).rejects.toThrow(
      PublicationChecklistInputError,
    );
    await expect(
      load({ ...base, approvedStagedArtifactIds: [pack.finals[0], pack.finals[0]] }),
    ).rejects.toThrow('approved more than once');
    await expect(
      load({ ...base, claimDecisions: [{ claimId: randomUUID(), choice: 'accept' }] }),
    ).rejects.toThrow('is not a segment of the final draft');
    await expect(
      load({
        ...base,
        claimDecisions: [
          { claimId: pack.flagged.id, choice: 'accept' },
          { claimId: pack.flagged.id, choice: 'edit' },
        ],
      }),
    ).rejects.toThrow('more than one decision');
  });

  it('refuses a claim audit made for another market', async () => {
    const pack = await seedPack({ auditMarketId: 'international' });
    await expect(
      load({ run: pack.run, approvedStagedArtifactIds: [], claimDecisions: [] }),
    ).rejects.toThrow('was made for market international v1');
  });

  it('loads a run without a claim audit, so phrasing items fail rather than pass', async () => {
    const user = await seedUser(testDb.db);
    const project = await seedProject(testDb.db, user.id);
    const run = await seedRun(testDb.db, project.id);
    const input = await load({ run, approvedStagedArtifactIds: [], claimDecisions: [] });
    expect(input).toMatchObject({ claimAudit: null, copy: { segments: [] }, stagedImages: [] });
    await expect(
      load({
        run,
        approvedStagedArtifactIds: [],
        claimDecisions: [{ claimId: randomUUID(), choice: 'remove' }],
      }),
    ).rejects.toThrow('without a claim audit');
    await expect(
      load({ run, approvedStagedArtifactIds: [randomUUID()], claimDecisions: [] }),
    ).rejects.toThrow('need exactly one integrity record');
  });
});
