import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { photoInventoryContentSchema, type PhotoInventoryContent } from '@evidomo/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createLogger } from '../../logger.ts';
import { createMetaClients, type MetaClients } from '../../meta/clients.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { runVisionInventory, visionSettings, type VisionPhoto } from '../vision/inventory.ts';
import { loadSamplePhotos, SAMPLE_MATERIAL_IDS, sampleVisionStep } from '../vision/testing.ts';
import { STAGED_DIGITAL_SOURCE_TYPE } from './encode.ts';
import { stagingPrompt } from './operations.ts';
import { planStaging, type StagingPlan } from './selection.ts';
import { runStaging, stagingSettings, type StageOutcome } from './stage.ts';
import { sampleStagingStep, STAGING_CASSETTE, STAGING_INCLUDED_CASSETTES } from './testing.ts';

// Staging over the six synthetic interiors: their P2-08 inventory (replayed from its own
// recordings, never re-sent) selects the photos, and each selected photo gets one tools-off
// edit. The cap is raised to 5 so both operation kinds are covered; the integration test runs
// the step with the definition's cap of 3, whose edits are the first three of these. Since
// vision prompt version 2, `dining-chairs` is judged furnished and no longer selected (staging
// furnishes empty rooms only), so its recorded edit is used only by the integrity tests.
// Record (docs/model-notes.md, P3-04; 5 edits, $0.05):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api staging.test
// P3_04_EXPORT_DIR=<dir> writes each stored staged image there (also in replay).
// The image blobs in fixtures/meta/p3-04/staging.files/ were downscaled 2x after recording to
// keep the repository small (model-notes P3-04), so assertions use aspect ratios, not pixels.

const RECORD_CAP = 5;
/** Photos the P2-08 inventory makes eligible: two empty rooms to furnish, two to declutter. */
const EXPECTED_EDITS = 4;
const replay = createMetaReplay({
  cassette: STAGING_CASSETTE,
  include: STAGING_INCLUDED_CASSETTES,
});
const usage = createInMemoryUsageRecorder();
const logger = createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' });
let registry: DefinitionRegistry;
let clients: MetaClients;
let photos: VisionPhoto[];
let inventory: PhotoInventoryContent;
let plan: StagingPlan;
let outcomes: StageOutcome[];
let latencyMs = 0;

const nameOf = (materialId: string): string =>
  Object.entries(SAMPLE_MATERIAL_IDS).find(([, id]) => id === materialId)?.[0] ?? materialId;

beforeAll(async () => {
  registry = await loadDefinitions();
  await replay.start();
  clients = createMetaClients({
    apiKey: replay.apiKey,
    usage,
    estimateCost: createPriceTableCostEstimator(),
    // One attempt: a retried edit would be billed again and recorded as a second measurement.
    maxRetries: 0,
  });
  const meter = async <T>(_modelId: string, call: () => Promise<T>): Promise<T> => call();
  photos = await loadSamplePhotos();
  const vision = await runVisionInventory(
    { clients, meter },
    visionSettings(sampleVisionStep(registry), registry.getMarket('nl', 1)),
    photos,
  );
  inventory = photoInventoryContentSchema.parse(vision.content);
  usage.clear();

  const settings = stagingSettings(sampleStagingStep(registry, RECORD_CAP));
  plan = planStaging(inventory, settings.maxStagedImages, settings.operationKinds);
  const jobs = plan.requests.map((request) => {
    const photo = photos.find((p) => p.materialId === request.materialId);
    if (photo === undefined) throw new Error('selected photo not loaded');
    return { photo, operation: request.operation };
  });
  const startedAt = Date.now();
  outcomes = await runStaging({ clients, meter }, settings, jobs);
  latencyMs = Date.now() - startedAt;
  replay.assertAllMatched();

  const exportDir = process.env['P3_04_EXPORT_DIR'];
  if (exportDir !== undefined && exportDir !== '') {
    await mkdir(exportDir, { recursive: true });
    for (const outcome of outcomes) {
      if (!outcome.ok) continue;
      const name = `${nameOf(outcome.value.materialId)}.${outcome.value.operation.id}.jpg`;
      await writeFile(path.join(exportDir, name), outcome.value.encoded.bytes);
    }
  }
}, 300_000);

afterAll(async () => {
  await replay.stop();
});

describe(`staging over the synthetic interiors (${replay.mode})`, () => {
  it('selects by cover rank, furnishes empty rooms only, and declares each operation', () => {
    expect(plan.requests.map((r) => [nameOf(r.materialId), r.coverRank, r.operation.id])).toEqual([
      ['living-empty', 1, 'furnish_living_room'],
      ['living-dining-cluttered', 3, 'declutter'],
      ['bedroom-empty', 4, 'furnish_bedroom'],
      ['kitchen-cluttered', 5, 'declutter'],
    ]);
    const diningChairs = plan.photos.find(
      (p) => p.status === 'skipped' && p.materialId === SAMPLE_MATERIAL_IDS['dining-chairs'],
    );
    expect(diningChairs).toMatchObject({ reason: 'room_not_empty', operation: null });
    const hallway = plan.photos.find(
      (p) => p.status === 'skipped' && p.materialId === SAMPLE_MATERIAL_IDS.hallway,
    );
    expect(hallway).toMatchObject({ reason: 'not_stageable', operation: null });
  });

  it('produces one staged image per edit, linked to its original and operation', async () => {
    expect(outcomes).toHaveLength(EXPECTED_EDITS);
    for (const [i, outcome] of outcomes.entries()) {
      const request = plan.requests[i];
      if (!outcome.ok) throw new Error(`edit ${i} failed: ${outcome.reason}`);
      const staged = outcome.value;
      expect(staged.materialId).toBe(request?.materialId);
      expect(staged.operation).toEqual(request?.operation);
      expect(staged.prompt).toBe(request === undefined ? '' : stagingPrompt(request.operation));
      expect(staged.requestedSize).toBe('1024x682');
      expect(staged.modelOutput.format).toBe('jpeg');
      // Sending the original's own WxH keeps the aspect within the integrity check's 3%.
      expect(staged.aspectRatioChange).toBeLessThan(0.03);
      expect(staged.encoded.width / staged.encoded.height).toBeCloseTo(
        staged.modelOutput.width / staged.modelOutput.height,
        2,
      );
      const xmp = (await sharp(staged.encoded.bytes).metadata()).xmp?.toString('utf8') ?? '';
      expect(xmp).toContain(STAGED_DIGITAL_SOURCE_TYPE);
    }
  });

  it('meters one billed image per edit through the openai SDK', () => {
    expect(usage.entries).toHaveLength(EXPECTED_EDITS);
    for (const entry of usage.entries) {
      expect(entry).toMatchObject({ sdk: 'openai', modelId: 'muse-image-1.0', images: 1 });
      expect(entry.estimatedCostUsd).toBeCloseTo(0.01, 10);
    }
    if (replay.mode === 'record') {
      logger.info(
        {
          latencyMs,
          edits: outcomes.map((o, i) => ({
            photo: nameOf(plan.requests[i]?.materialId ?? ''),
            operation: plan.requests[i]?.operation.id,
            ...(o.ok
              ? {
                  output: `${o.value.modelOutput.width}x${o.value.modelOutput.height}`,
                  aspectRatioChange: o.value.aspectRatioChange,
                  storedBytes: o.value.encoded.bytes.byteLength,
                }
              : { failed: o.reason }),
          })),
          usage: usage.entries.map((e) => ({
            in: e.inputTokens,
            out: e.outputTokens,
            ms: Math.round(e.latencyMs),
            usd: e.estimatedCostUsd,
          })),
        },
        'p3-04-measurement',
      );
    }
  });
});
