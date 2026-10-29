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
import { storeQaCards } from '../qa/handler.ts';
import { qaCardsFromCopy } from '../qa/testing.ts';
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
  /** With `withQa`: the Q&A answer claims, and the one flagged `exclusionary`. */
  readonly qaClaims: Claim[];
  readonly qaFlagged: Claim | null;
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

async function seedPack(
  options: { auditMarketId?: string; withQa?: boolean } = {},
): Promise<SeededPack> {
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

  // Q&A cards (P3-03) answered with copy segments: card 0 by the energy-label segment, card 1 by
  // segment 0 (flagged) and the energy-label segment again.
  let qaId: string | null = null;
  let qaClaims: Claim[] = [];
  let qaFlag: ClaimAuditFlag | null = null;
  if (options.withQa === true) {
    const labelFactIds = new Set(
      facts.filter((f) => f.key === 'energy_label' && f.status === 'verified').map((f) => f.id),
    );
    const labelSegment = content.variants
      .flatMap((v) => v.segments)
      .find((segment) => segment.factIds.some((id) => labelFactIds.has(id)));
    if (labelSegment === undefined) throw new Error('The recorded copy names no energy label');
    const qa = qaCardsFromCopy(
      content,
      facts.filter((f) => f.status === 'verified'),
      [
        { question: 'Wat is het energielabel?', segments: [labelSegment.index] },
        // Two answers: removing the flagged first one drops the card (the Gate 2 rule).
        { question: 'Hoe groot is de woning?', segments: [0, labelSegment.index] },
      ],
    );
    const stored = await storeQaCards(db, { runId: run.id, stepId: 'qa_cards', content: qa });
    qaId = stored.artifact.id;
    qaClaims = await listClaims(db, qaId);
    const target = qaClaims[1];
    if (target === undefined) throw new Error('two Q&A claims expected');
    qaFlag = {
      source: 'verifier',
      category: 'exclusionary',
      code: null,
      artifactId: qaId,
      variant: 'qa',
      segment: 1,
      segmentIndex: 1,
      claimId: target.id,
      problem: 'The question addresses buyers by family status.',
      suggestion: null,
      carried: false,
    };
  }
  const flags = qaFlag === null ? [flag] : [flag, qaFlag];
  const segmentCount = claims.length + qaClaims.length;
  const audit: ClaimAuditContent = claimAuditContentSchema.parse({
    schemaVersion: 1,
    promptVersion: 1,
    outputLanguage: 'nl',
    market: { id: options.auditMarketId ?? 'nl', version: 1 },
    rubric: [
      { category: 'claim_support', rule: 'Say only what the cited facts say.' },
      { category: 'unverifiable_superlative', rule: 'No unverifiable superlatives.' },
      ...(qaFlag === null
        ? []
        : [{ category: 'exclusionary' as const, rule: 'No exclusionary wording.' }]),
    ],
    maxRevisionLoops: 0,
    stopReason: 'loop_limit',
    initialDraftArtifactId: draft.id,
    finalDraftArtifactId: draft.id,
    initialQaArtifactId: qaId,
    finalQaArtifactId: qaId,
    passes: [
      {
        draftArtifactId: draft.id,
        qaDraftArtifactId: qaId,
        revision: 0,
        segments: segmentCount,
        auditedSegments: segmentCount,
        carriedSegments: 0,
        modelRun: {
          model: 'muse-wonder-1.0',
          reasoningEffort: 'low',
          maxOutputTokens: 12000,
          fallbackFrom: null,
        },
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
      verifierCalls: 1,
      remainingFlags: flags.length,
      remainingValidatorFlags: 0,
      remainingVerifierFlags: flags.length,
      flaggedClaims: flags.length,
      finalClaims: segmentCount,
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

  return {
    run,
    claims,
    flagged,
    qaClaims,
    qaFlagged: qaClaims[1] ?? null,
    finals: [labeled, unlabeled],
    notFinal: failed,
  };
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
    ).rejects.toThrow('is not a segment of the final draft or Q&A cards');
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

  it('adds the final Q&A answers to the segments, so a Q&A flag can be decided (P3-03)', async () => {
    const pack = await seedPack({ withQa: true });
    const qaFlagged = pack.qaFlagged;
    if (qaFlagged === null) throw new Error('no flagged Q&A claim');
    const decided = await load({
      run: pack.run,
      approvedStagedArtifactIds: [],
      claimDecisions: [
        { claimId: pack.flagged.id, choice: 'remove' },
        { claimId: qaFlagged.id, choice: 'remove' },
      ],
    });
    expect(decided.copy.segments.map((s) => s.claimId)).toEqual([
      ...pack.claims.map((c) => c.id),
      ...pack.qaClaims.map((c) => c.id),
    ]);
    // Removing the flagged answer drops its card: the card's unflagged second answer counts as
    // removed too, so the checklist sees what the pack publishes.
    expect(decided.copy.segments.filter((s) => s.variant === 'qa')).toEqual([
      expect.objectContaining({ claimId: pack.qaClaims[0]?.id, decision: null }),
      expect.objectContaining({ claimId: qaFlagged.id, decision: 'remove' }),
      expect.objectContaining({ claimId: pack.qaClaims[2]?.id, decision: 'remove' }),
    ]);
    // The kept Q&A answer cites the energy label, so the fact is cited in Q&A too.
    const nl = evaluatePublicationChecklist(decided);
    expect(nl.items[0]).toMatchObject({ id: 'energy_label_shown' });
    expect(nl.items[0]?.rule === 'fact_present' && nl.items[0].citedIn).toContain('qa');

    // Evaluated against a market with an exclusionary item: the removed Q&A answer resolves it,
    // an undecided one keeps it failed (before P3-03 a Q&A flag always failed closed).
    const international = registry.getMarket('international', 1);
    const exclusionary = (input: typeof decided) =>
      evaluatePublicationChecklist({ ...input, market: international }).items.find(
        (item) => item.id === 'no_exclusionary_language',
      );
    expect(exclusionary(decided)).toMatchObject({
      status: 'pass',
      removedClaimIds: [qaFlagged.id],
    });
    const open = await load({ run: pack.run, approvedStagedArtifactIds: [], claimDecisions: [] });
    expect(exclusionary(open)).toMatchObject({
      status: 'fail',
      unresolvedClaimIds: [qaFlagged.id],
    });
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
