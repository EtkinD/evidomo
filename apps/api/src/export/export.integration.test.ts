import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EXPORT_HTML_ARTIFACT_KIND,
  EXPORT_IMAGE_ARTIFACT_KIND,
  EXPORT_MANIFEST_ARTIFACT_KIND,
  EXPORT_PORTAL_FIELDS_ARTIFACT_KIND,
  UPLOAD_LIMITS,
  exportFileContentSchema,
  exportManifestContentSchema,
  packExportedPayloadSchema,
  portalFieldsSchema,
  type ExportManifestContent,
  type MarketProfile,
  type PortalFields,
  type ServiceDefinition,
} from '@evidomo/shared';
import { PgBoss } from 'pg-boss';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listArtifacts, type Artifact } from '../db/repositories/artifacts.ts';
import { deleteProject } from '../db/repositories/projects.ts';
import { listRunEvents } from '../db/repositories/run-events.ts';
import { getRun, type Run } from '../db/repositories/runs.ts';
import {
  seedProject,
  seedRun,
  seedUser,
  startTestDatabase,
  type TestDatabase,
} from '../db/testing.ts';
import { loadDefinitions, type DefinitionRegistry } from '../definitions/loader.ts';
import { createClaimAuditGate, type ClaimAuditGate } from '../gates/claim-audit.ts';
import { createLogger } from '../logger.ts';
import { createMetaClients } from '../meta/clients.ts';
import { STAGED_DIGITAL_SOURCE_TYPE } from '../pipeline/staging/encode.ts';
import { readAll } from '../pipeline/vision/handler.ts';
import { createRunEngine, type RunEngine } from '../runs/engine.ts';
import type { StepHandler } from '../runs/steps.ts';
import { testRegistry, waitFor } from '../runs/testing.ts';
import { createLocalStorage } from '../storage/local.ts';
import type { Storage } from '../storage/storage.ts';
import { escapeHtml } from './escape.ts';
import { buildRunExport } from './build.ts';
import { createExportHandler } from './handler.ts';
import { serializePortalFields } from './portal-fields.ts';
import {
  EDITED_BALCONY_TEXT,
  EDITED_QA_YEAR_TEXT,
  QA_EXPORT_CARDS,
  SEGMENT_TEXT,
  seedExportScenario,
  sha256Hex,
  type ExportScenario,
} from './testing.ts';

// The export step through the run engine, against PostgreSQL (Testcontainers) and local storage
// in a temp directory. A verification stand-in stores staged images, an integrity record, and a
// claim audit for a seeded synthetic run; the real Gate 2 service decides and approves, which
// resumes the run into the real export handler. No model calls.
//
// Set EXPORT_SAMPLE_DIR=<dir> to also write the exported files of the first run there.

const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: 'test' });
const SAMPLE_DIR = process.env['EXPORT_SAMPLE_DIR'];

let testDb: TestDatabase;
let boss: PgBoss;
let engine: RunEngine;
let definitions: DefinitionRegistry;
let service: ServiceDefinition;
let exportOnly: ServiceDefinition;
let nl: MarketProfile;
let storage: Storage;
let storageDir: string;
let gate: ClaimAuditGate;
const scenarios = new Map<string, ExportScenario>();
const stagedIds = new Map<string, Readonly<Record<'living' | 'dining', string>>>();
const qaClaimIdsOf = new Map<string, readonly string[]>();

const verifierStub: StepHandler<'verifier'> = (context) => {
  const scenario = scenarios.get(context.run.id);
  if (scenario === undefined) throw new Error('no scenario for this run');
  return Promise.resolve({
    async commit(tx) {
      const { staged, qaClaimIds } = await scenario.storeVerification(tx);
      stagedIds.set(context.run.id, staged);
      qaClaimIdsOf.set(context.run.id, qaClaimIds);
      return {};
    },
  });
};

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

async function readStored(artifact: Artifact): Promise<Buffer> {
  if (artifact.storageKey === null) throw new Error(`artifact ${artifact.id} has no file`);
  return Buffer.from(
    await readAll(await storage.get(artifact.storageKey), UPLOAD_LIMITS.photoMaxBytes * 4),
  );
}

/**
 * Seeds a run, takes it to Gate 2, decides every item, approves, and waits for the export. With
 * `withQa`, the three flagged Q&A answers are accepted, edited, and removed (in card order).
 */
async function exportedRun(energyLabel: boolean, withQa = false): Promise<ExportScenario> {
  const scenario = await seedExportScenario(testDb.db, storage, nl, {
    energyLabel,
    withQa,
    serviceId: service.id,
    serviceVersion: service.version,
  });
  const { run, user, claims } = scenario;
  scenarios.set(run.id, scenario);
  await engine.startRun(run.id);
  expect((await waitForStatus(run.id, 'awaiting_gate')).gate).toBe('claim_audit');
  const staged = stagedIds.get(run.id);
  if (
    staged === undefined ||
    claims.balcony === undefined ||
    claims.injection === undefined ||
    claims.unmissable === undefined
  ) {
    throw new Error('scenario incomplete');
  }
  await gate.decideClaim(user.id, run.id, claims.balcony.id, {
    choice: 'edit',
    text: EDITED_BALCONY_TEXT,
  });
  await gate.decideClaim(user.id, run.id, claims.injection.id, { choice: 'accept' });
  await gate.decideClaim(user.id, run.id, claims.unmissable.id, { choice: 'remove' });
  await gate.decideImage(user.id, run.id, staged.living, { choice: 'accept' });
  await gate.decideImage(user.id, run.id, staged.dining, { choice: 'reject' });
  if (withQa) {
    const [accepted, edited, removed] = qaClaimIdsOf.get(run.id) ?? [];
    if (accepted === undefined || edited === undefined || removed === undefined) {
      throw new Error('no Q&A claims');
    }
    await gate.decideClaim(user.id, run.id, accepted, { choice: 'accept' });
    await gate.decideClaim(user.id, run.id, edited, { choice: 'edit', text: EDITED_QA_YEAR_TEXT });
    await gate.decideClaim(user.id, run.id, removed, { choice: 'remove' });
  }
  await gate.approve(user.id, run.id);
  await waitForStatus(run.id, 'completed');
  return scenario;
}

interface StoredExport {
  readonly manifestArtifact: Artifact;
  readonly manifest: ExportManifestContent;
  readonly html: string;
  readonly json: string;
  readonly fields: PortalFields;
  readonly files: ReadonlyMap<string, { artifact: Artifact; bytes: Buffer }>;
}

async function storedExport(runId: string): Promise<StoredExport> {
  const [manifestArtifact, ...more] = await listArtifacts(testDb.db, runId, {
    kind: EXPORT_MANIFEST_ARTIFACT_KIND,
  });
  expect(more).toHaveLength(0);
  if (manifestArtifact === undefined) throw new Error('no manifest');
  const manifest = exportManifestContentSchema.parse(manifestArtifact.content);
  const artifacts = [
    ...(await listArtifacts(testDb.db, runId, { kind: EXPORT_HTML_ARTIFACT_KIND })),
    ...(await listArtifacts(testDb.db, runId, { kind: EXPORT_PORTAL_FIELDS_ARTIFACT_KIND })),
    ...(await listArtifacts(testDb.db, runId, { kind: EXPORT_IMAGE_ARTIFACT_KIND })),
  ];
  const files = new Map<string, { artifact: Artifact; bytes: Buffer }>();
  for (const artifact of artifacts) {
    const content = exportFileContentSchema.parse(artifact.content);
    files.set(content.fileName, { artifact, bytes: await readStored(artifact) });
  }
  const html = files.get('listing-pack.html')?.bytes.toString('utf8') ?? '';
  const json = files.get('portal-fields.json')?.bytes.toString('utf8') ?? '';
  return {
    manifestArtifact,
    manifest,
    html,
    json,
    fields: portalFieldsSchema.parse(JSON.parse(json)),
    files,
  };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  definitions = await loadDefinitions();
  nl = definitions.getMarket('nl', 1);
  const listing = definitions.getService('listing-launch', 1);
  service = {
    ...listing,
    id: 'export-test',
    steps: listing.steps.filter((step) => step.id === 'verification' || step.id === 'export'),
  };
  exportOnly = {
    ...listing,
    id: 'export-only',
    steps: listing.steps.filter((step) => step.id === 'export'),
  };
  storageDir = await mkdtemp(path.join(os.tmpdir(), 'evidomo-export-'));
  storage = createLocalStorage({ rootDir: storageDir });

  boss = new PgBoss({
    connectionString: testDb.container.getConnectionUri(),
    superviseIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
  });
  boss.on('error', (error) => {
    logger.error({ err: error }, 'pg-boss error in test');
  });
  await boss.start();
  engine = createRunEngine({
    db: testDb.db,
    boss,
    registry: testRegistry(service, exportOnly),
    logger,
    dailyCapUsd: '5.00',
    handlers: {
      verifier: verifierStub,
      exporter: createExportHandler({ storage, markets: definitions }),
    },
    createMetaClients: (usage) =>
      createMetaClients({ apiKey: 'test-placeholder-key', usage, maxRetries: 0 }),
    heartbeatSeconds: 10,
    expiryGraceSeconds: 5,
    retryDelaySeconds: 0,
  });
  await engine.startWorkers({ pollingIntervalSeconds: 0.5 });
  gate = createClaimAuditGate({ db: testDb.db, engine, markets: definitions });
}, 180_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await testDb?.stop();
  if (storageDir !== undefined) await rm(storageDir, { recursive: true, force: true });
});

describe('export step', () => {
  let scenario: ExportScenario;
  let stored: StoredExport;

  it('exports the approved pack as HTML, portal-fields JSON, and images, with a manifest', async () => {
    scenario = await exportedRun(false);
    stored = await storedExport(scenario.run.id);
    const { manifest, files } = stored;

    expect(manifest.files.map((f) => [f.role, f.fileName])).toEqual([
      ['html', 'listing-pack.html'],
      ['portal_fields', 'portal-fields.json'],
      ['image', 'photo-01.jpg'],
      ['image', 'photo-02-staged.jpg'],
      ['image', 'photo-02.jpg'],
      ['image', 'photo-03.jpg'],
    ]);
    expect(manifest.counts).toEqual({
      images: 4,
      originals: 3,
      staged: 1,
      blurredImages: 1,
      blurredRegions: 2,
      withheld: 2,
    });
    expect(manifest.readyToPublish).toBe(false);
    // Every manifest entry is a stored artifact whose bytes hash to the recorded SHA-256.
    expect(files.size).toBe(manifest.files.length);
    for (const entry of manifest.files) {
      const file = files.get(entry.fileName);
      expect(file?.artifact.id).toBe(entry.artifactId);
      expect(file?.artifact.mimeType).toBe(entry.mimeType);
      expect(file?.bytes.byteLength).toBe(entry.sizeBytes);
      expect(sha256Hex(file?.bytes ?? new Uint8Array())).toBe(entry.sha256);
    }

    const step = await listRunEvents(testDb.db, scenario.run.id);
    const exportedEvents = step.filter((e) => e.type === 'pack_exported');
    expect(exportedEvents).toHaveLength(1);
    expect(packExportedPayloadSchema.parse(exportedEvents[0]?.payload)).toEqual({
      stepId: 'export',
      artifactId: stored.manifestArtifact.id,
      imageCount: 4,
      originalCount: 3,
      stagedCount: 1,
      blurredImageCount: 1,
      blurredRegionCount: 2,
      withheldCount: 2,
      checklistFailCount: 1,
      readyToPublish: false,
    });

    if (SAMPLE_DIR !== undefined && SAMPLE_DIR !== '') {
      await mkdir(SAMPLE_DIR, { recursive: true });
      for (const [name, file] of files) await writeFile(path.join(SAMPLE_DIR, name), file.bytes);
    }
  });

  it('writes schema-valid, stably serialized portal fields with the published copy', () => {
    const { fields, json } = stored;
    expect(serializePortalFields(fields)).toBe(json);
    expect(fields).toMatchObject({
      runId: scenario.run.id,
      market: { id: 'nl', version: 1 },
      outputLanguage: 'en',
    });
    expect(fields.copy.portal.text).toContain(EDITED_BALCONY_TEXT);
    expect(fields.copy.portal.text).toContain(SEGMENT_TEXT.injection);
    expect(fields.copy.portal.text).not.toContain(SEGMENT_TEXT.balcony);
    expect(fields.copy.social.text).toBe(SEGMENT_TEXT.social);
    expect(fields.copy.portal.segments.map((s) => s.origin)).toEqual([
      'unflagged',
      'unflagged',
      'unflagged',
      'edited',
      'accepted',
    ]);

    const energy = fields.facts.profile.find((f) => f.key === 'energy_label');
    expect(energy).toMatchObject({ status: 'missing', value: null });
    expect(fields.facts.profile.find((f) => f.key === 'living_area')).toMatchObject({
      status: 'verified',
      value: 92,
    });
    expect(fields.facts.presences.map((p) => p.key)).toEqual(['other:balcony']);
    expect(fields.publicationChecklist.summary).toMatchObject({ readyToPublish: false });

    expect(fields.images.map((image) => [image.kind, image.fileName, image.materialId])).toEqual([
      ['original', 'photo-01.jpg', scenario.photos.bedroom.materialId],
      ['staged', 'photo-02-staged.jpg', scenario.photos.living.materialId],
      ['original', 'photo-02.jpg', scenario.photos.living.materialId],
      ['original', 'photo-03.jpg', scenario.photos.dining.materialId],
    ]);
    expect(fields.withheld).toEqual([
      expect.objectContaining({
        materialId: scenario.photos.kitchen.materialId,
        uploadPosition: 3,
        reason: 'privacy_review',
      }),
      expect.objectContaining({
        materialId: scenario.photos.hallway.materialId,
        uploadPosition: 4,
        reason: 'privacy_failed',
      }),
    ]);
    for (const image of fields.images) {
      expect(stored.manifest.files.find((f) => f.fileName === image.fileName)?.artifactId).toBe(
        image.fileArtifactId,
      );
    }
  });

  it('renders the HTML with the published text, the notice, and no withheld photo', () => {
    const { html, files } = stored;
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(EDITED_BALCONY_TEXT);
    expect(html).not.toContain(SEGMENT_TEXT.balcony);
    expect(html).not.toContain(SEGMENT_TEXT.unmissable);
    expect(html).not.toContain('<script');
    expect(html).toContain(escapeHtml(SEGMENT_TEXT.injection));
    expect(html).toContain(escapeHtml('Synthetic apartment <Canal> & "Co"'));
    expect(html).toContain('id="not-ready"');
    expect(html).toContain('Upload 3: withheld: privacy check incomplete');
    expect(html).toContain('Upload 4: withheld: privacy check incomplete');
    // Embedded images are exactly the exported files; the withheld originals are nowhere.
    const embedded = [...html.matchAll(/src="data:image\/jpeg;base64,([^"]+)"/g)].map(
      (m) => m[1] ?? '',
    );
    expect(embedded.map((b64) => sha256Hex(Buffer.from(b64, 'base64')))).toEqual(
      stored.fields.images.map((image) => image.sha256),
    );
    // Every embedded image is an exported file (by hash, above), and none of those is a withheld
    // original. (A base64 substring check is meaningless here: the flat synthetic photos share
    // long runs of identical JPEG blocks.)
    const allExported = [...files.values()].map((f) => f.bytes);
    for (const withheld of [scenario.photos.kitchen, scenario.photos.hallway]) {
      expect(allExported.some((bytes) => sha256Hex(bytes) === withheld.sha256)).toBe(false);
    }
  });

  it('blurs the masked photo, labels the staged one, and copies clear originals unchanged', async () => {
    const { files } = stored;
    const blurred = files.get('photo-01.jpg')?.bytes;
    const clear = files.get('photo-03.jpg')?.bytes;
    const staged = files.get('photo-02-staged.jpg')?.bytes;
    if (blurred === undefined || clear === undefined || staged === undefined)
      throw new Error('missing file');
    expect(sha256Hex(blurred)).not.toBe(scenario.photos.bedroom.sha256);
    expect(sha256Hex(clear)).toBe(scenario.photos.dining.sha256);
    expect(sha256Hex(files.get('photo-02.jpg')?.bytes ?? new Uint8Array())).toBe(
      scenario.photos.living.sha256,
    );
    const stagedMetadata = await sharp(staged).metadata();
    expect(stagedMetadata.xmp?.toString('utf8')).toContain(STAGED_DIGITAL_SOURCE_TYPE);
    const blurredMetadata = await sharp(blurred).metadata();
    expect([blurredMetadata.exif, blurredMetadata.xmp]).toEqual([undefined, undefined]);
  });

  it('rebuilds byte-identical files from the same stored artifacts', async () => {
    const rebuilt = await buildRunExport(
      { storage, markets: definitions },
      testDb.db,
      scenario.run,
    );
    expect(rebuilt.manifest).toEqual(stored.manifest);
    expect(rebuilt.manifestArtifactId).toBe(stored.manifestArtifact.id);
    for (const file of rebuilt.files) {
      const original = stored.files.get(file.fileName);
      expect(original?.artifact.id).toBe(file.artifactId);
      expect(Buffer.from(file.bytes).equals(original?.bytes ?? Buffer.alloc(0))).toBe(true);
    }
  });

  it('hands every exported file to project deletion', async () => {
    const keys = [...stored.files.values()].map((f) => f.artifact.storageKey);
    const { storageKeys } = await deleteProject(testDb.db, scenario.project.id);
    for (const key of keys) expect(storageKeys).toContain(key);
  });

  it('is ready to publish, without a notice, when every checklist item passes', async () => {
    const ready = await exportedRun(true);
    const result = await storedExport(ready.run.id);
    expect(result.manifest.readyToPublish).toBe(true);
    expect(result.fields.facts.profile.find((f) => f.key === 'energy_label')).toMatchObject({
      value: 'B',
    });
    expect(result.html).not.toContain('id="not-ready"');
    expect(result.html).toContain(SEGMENT_TEXT.label);
  });

  it('agrees with the pack on Q&A answers accepted, edited, and removed at Gate 2 (P3-03)', async () => {
    const run = (await exportedRun(true, true)).run;
    const [accepted, edited, removed] = qaClaimIdsOf.get(run.id) ?? [];
    const result = await storedExport(run.id);
    // The pack: the removed answer's card is gone, the other two are published as decided.
    expect(result.fields.qaCards.map((card) => [card.question, card.answer])).toEqual([
      [QA_EXPORT_CARDS[0]?.question, SEGMENT_TEXT.area],
      [QA_EXPORT_CARDS[1]?.question, EDITED_QA_YEAR_TEXT],
    ]);
    expect(result.fields.qaCards.flatMap((card) => card.segments.map((s) => s.origin))).toEqual([
      'accepted',
      'edited',
    ]);
    expect(result.html).toContain(`<dt>${escapeHtml(QA_EXPORT_CARDS[0]?.question ?? '')}</dt>`);
    expect(result.html).not.toContain(escapeHtml(QA_EXPORT_CARDS[2]?.question ?? ''));
    // The approved answer is named as an operator override in the pack.
    expect(result.html).toContain(`buyer Q&amp;A:</span> ${escapeHtml(SEGMENT_TEXT.area)}`);

    // The checklist sees the same decisions. Evaluated against the nl profile plus a
    // no_flagged_phrasing item for the flags' category: it passes, listing each Q&A decision
    // (before the fix the accepted and edited answers were "unresolved").
    const withPhrasingItem = {
      getMarket: (id: string, version: number) => {
        const market = definitions.getMarket(id, version);
        return {
          ...market,
          publication_checklist: [
            ...market.publication_checklist,
            {
              id: 'no_investment_promises',
              label: 'No investment promises remain',
              rule: 'no_flagged_phrasing' as const,
              category: 'investment_promise' as const,
            },
          ],
        };
      },
    };
    const rebuilt = await buildRunExport({ storage, markets: withPhrasingItem }, testDb.db, run);
    const item = rebuilt.checklist.items.find((i) => i.id === 'no_investment_promises');
    expect(item).toMatchObject({
      status: 'pass',
      acceptedClaimIds: [accepted],
      editedClaimIds: [edited],
      removedClaimIds: [removed],
      unresolvedClaimIds: [],
    });
  });

  it('fails the run without retrying when the approved pack is missing', async () => {
    const user = await seedUser(testDb.db);
    const project = await seedProject(testDb.db, user.id);
    const run = await seedRun(testDb.db, project.id, {
      serviceId: exportOnly.id,
      serviceVersion: exportOnly.version,
    });
    await engine.startRun(run.id);
    const failed = await waitForStatus(run.id, 'failed');
    expect(failed.failureReason).toContain(
      'The export needs the approved pack, and the run has none',
    );
    expect(await listArtifacts(testDb.db, run.id, { kind: EXPORT_MANIFEST_ARTIFACT_KIND })).toEqual(
      [],
    );
  });
});
