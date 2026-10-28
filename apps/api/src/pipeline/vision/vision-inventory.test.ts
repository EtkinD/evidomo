import {
  factSourceSchema,
  photoInventoryContentSchema,
  type PhotoInventoryContent,
} from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createLogger } from '../../logger.ts';
import { createMetaClients, type MetaClients } from '../../meta/clients.ts';
import { decodeSamMask } from '../../meta/sam-mask.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { toPhotoFact } from './handler.ts';
import {
  callPhotoClassification,
  runVisionInventory,
  visionSettings,
  type VisionInventoryResult,
  type VisionPhoto,
} from './inventory.ts';
import { PHOTO_CLASSIFICATION_OUTPUT_NAME } from './schema.ts';
import {
  loadSamplePhotos,
  SAMPLE_MATERIAL_IDS,
  sampleVisionStep,
  VISION_CASSETTE,
  VISION_INCLUDED_CASSETTES,
} from './testing.ts';

// The vision inventory over the six synthetic interiors: one Spark classification per photo,
// `person` and `license plate` on every photo, and the capped evidence requests, through the
// same core the step runs. SAM requests already recorded in P1-05 replay from those cassettes.
// Record (docs/model-notes.md, P2-08; ~$0.05):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api vision-inventory.test
// Privacy assertions are negative only: the samples contain no people and no vehicles.

const replay = createMetaReplay({ cassette: VISION_CASSETTE, include: VISION_INCLUDED_CASSETTES });
const usage = createInMemoryUsageRecorder();
const logger = createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' });
let registry: DefinitionRegistry;
let clients: MetaClients;
let photos: VisionPhoto[];
let result: VisionInventoryResult;
let content: PhotoInventoryContent;
let latencyMs = 0;

const echoSchema = z.object({
  status: z.literal('completed'),
  reasoning: z.object({ effort: z.string() }),
  store: z.boolean(),
  text: z.object({
    format: z.object({ type: z.literal('json_schema'), name: z.string(), strict: z.boolean() }),
  }),
});

function photoOf(name: keyof typeof SAMPLE_MATERIAL_IDS) {
  const photo = content.photos.find((p) => p.materialId === SAMPLE_MATERIAL_IDS[name]);
  if (photo === undefined) throw new Error(`No inventory entry for ${name}`);
  return photo;
}

beforeAll(async () => {
  registry = await loadDefinitions();
  await replay.start();
  clients = createMetaClients({
    apiKey: replay.apiKey,
    usage,
    estimateCost: createPriceTableCostEstimator(),
    maxRetries: 0,
  });
  photos = await loadSamplePhotos();
  const settings = visionSettings(sampleVisionStep(registry), registry.getMarket('nl', 1));
  const startedAt = Date.now();
  result = await runVisionInventory(
    { clients, meter: async (_modelId, call) => call() },
    settings,
    photos,
  );
  latencyMs = Date.now() - startedAt;
  replay.assertAllMatched();
  content = photoInventoryContentSchema.parse(result.content);
}, 300_000);

afterAll(async () => {
  await replay.stop();
});

describe(`vision inventory over the synthetic interiors (${replay.mode})`, () => {
  it('classifies every photo with a subject, quality, and a unique cover rank', () => {
    expect(content.counts).toMatchObject({ photos: 6, classified: 6, classificationFailed: 0 });
    const ranks: number[] = [];
    for (const photo of content.photos) {
      expect(photo.classification.status).toBe('ok');
      if (photo.classification.status !== 'ok') continue;
      ranks.push(photo.classification.coverRank);
      expect(photo.classification.summary.length).toBeGreaterThan(10);
    }
    expect(ranks.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    // Unambiguous rooms; the two dining scenes may be classified as living or dining room.
    const subject = (name: keyof typeof SAMPLE_MATERIAL_IDS): string => {
      const c = photoOf(name).classification;
      return c.status === 'ok' ? c.subject : 'failed';
    };
    expect(subject('living-empty')).toBe('living_room');
    expect(subject('kitchen-cluttered')).toBe('kitchen');
    expect(subject('bedroom-empty')).toBe('bedroom');
    expect(subject('hallway')).toBe('hallway');
    expect(['living_room', 'dining_room']).toContain(subject('dining-chairs'));
    expect(['living_room', 'dining_room']).toContain(subject('living-dining-cluttered'));
  });

  it('checks both privacy phrases on every photo and finds nothing (negative cases only)', () => {
    expect(content.privacyPhrases).toEqual(['person', 'license plate']);
    expect(content.counts.privacy).toEqual({ clear: 6, masked: 0, review: 0, failed: 0 });
    for (const photo of content.photos) {
      expect(photo.privacy.phrases.map((p) => [p.phrase, p.status, p.modelSaw])).toEqual([
        ['person', 'checked', false],
        ['license plate', 'checked', false],
      ]);
    }
  });

  it('segments evidence within the cap and stores regions that fit the photo', () => {
    expect(content.evidence.cap).toBe(12);
    expect(content.evidence.requestCount).toBeGreaterThan(0);
    expect(content.evidence.requestCount).toBeLessThanOrEqual(content.evidence.cap);
    expect(content.evidence.maskCount).toBeLessThanOrEqual(content.evidence.cap);

    const segmented = content.photos.flatMap((p) =>
      p.observations.filter((o) => o.evidence.status === 'segmented'),
    );
    expect(segmented.length).toBeGreaterThan(0);
    for (const observation of segmented) {
      expect(observation.evidence.instanceCount).toBe(observation.evidence.regions.length);
      for (const region of observation.evidence.regions) {
        expect(region.box.x1).toBeLessThanOrEqual(1024);
        expect(region.box.y1).toBeLessThanOrEqual(682);
        if (region.mask !== null) {
          // Masks decode to box-sized rasters (the overlay and the blur rely on it).
          expect(decodeSamMask(region.mask)).toHaveLength(
            (region.box.x1 - region.box.x0) * (region.box.y1 - region.box.y0),
          );
        }
      }
    }
    // Windows and radiators: SAM matched ground truth on these images in P1-05.
    const windows = photoOf('living-dining-cluttered').observations.find(
      (o) => o.key === 'other:window',
    );
    if (windows?.evidence.status === 'segmented') expect(windows.evidence.instanceCount).toBe(2);
  });

  it('stores one photo_region fact per observation that SAM did not contradict', () => {
    const stored = content.photos.flatMap((p) => p.observations.filter((o) => o.factStored));
    expect(result.facts).toHaveLength(stored.length);
    expect(content.counts.facts).toBe(stored.length);
    const artifactId = '5d1c0c55-9a8e-4f57-8f0e-5d0d7b2c4a10';
    for (const draft of result.facts) {
      const fact = toPhotoFact('vision_inventory', artifactId, draft);
      expect(factSourceSchema.safeParse(fact.source).success).toBe(true);
      expect(fact.key).toMatch(/^other:[a-z][a-z0-9_]*$/);
      expect(Number.isInteger(fact.value) && Number(fact.value) >= 1).toBe(true);
    }
  });

  it('meters one Spark call per photo and one SAM call per privacy phrase and evidence request', () => {
    const spark = usage.entries.filter((e) => e.modelId === 'muse-spark-1.3');
    const sam = usage.entries.filter((e) => e.modelId === 'sam-3.1');
    expect(spark).toHaveLength(6);
    expect(sam).toHaveLength(6 * 2 + content.evidence.requestCount);
    expect(sam.every((e) => e.images === 1)).toBe(true);
    const total = usage.entries.reduce((sum, e) => sum + (e.estimatedCostUsd ?? 0), 0);
    expect(total).toBeLessThan(0.1);
    if (replay.mode === 'record') {
      logger.info(
        {
          latencyMs,
          spark: spark.map((e) => ({
            in: e.inputTokens,
            cached: e.cachedInputTokens,
            out: e.outputTokens,
            reasoning: e.reasoningTokens,
            usd: e.estimatedCostUsd,
          })),
          samCalls: sam.length,
          totalUsd: total,
          evidence: content.evidence,
          observations: content.photos.map((p) => ({
            subject: p.classification.status === 'ok' ? p.classification.subject : null,
            cover: p.classification.status === 'ok' ? p.classification.coverScore : null,
            objects: p.observations.map((o) => `${o.key}:${o.modelCount}:${o.evidence.status}`),
          })),
        },
        'p2-08-measurement',
      );
    }
  });

  // Replay only: in record mode the repeated request would be re-sent and overwrite the
  // recording the other assertions saw.
  it.runIf(replay.mode === 'replay')(
    'echoes the step settings and strict json_schema (one replayed call)',
    async () => {
      const [photo] = photos;
      if (photo === undefined) throw new Error('no photo');
      const settings = visionSettings(sampleVisionStep(registry), registry.getMarket('nl', 1));
      const call = await callPhotoClassification(clients, settings, photo, {
        includeResponseBody: true,
      });
      expect(call.finishReason).toBe('stop');
      expect(echoSchema.parse(call.responseBody)).toMatchObject({
        reasoning: { effort: 'low' },
        store: false,
        text: {
          format: { type: 'json_schema', name: PHOTO_CLASSIFICATION_OUTPUT_NAME, strict: true },
        },
      });
    },
  );
});
