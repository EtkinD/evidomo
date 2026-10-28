import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMetaClients, type MetaClients } from './clients.ts';
import { createMetaReplay } from './replay.ts';
import { renderSamOverlayPng } from './sam-overlay.ts';
import {
  appendSegmentSummary,
  P1_05_OUT_DIR,
  PHRASE_COLORS,
  readSample,
  recordedOutputTexts,
  SAM,
  SAM_EFFORT,
  samCostEstimator,
  SAMPLES_DIR,
} from './sam-test-support.ts';
import { segmentImage, type SamSegmentResult } from './sam.ts';
import { createInMemoryUsageRecorder } from './usage.ts';

// Record (36 calls, ~$0.09): RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run
//   --project api sam-integrity   (docs/model-notes.md, P1-05)
// Default runs replay fixtures/meta/p1-05/sam-integrity.json. Inputs are the committed synthetic
// samples, so the request hashes stay stable. P1_05_OUT_DIR=data/p1-05 writes overlays.

const CASSETTE = 'p1-05/sam-integrity';
const PHRASES = ['window', 'door', 'radiator'] as const;
type Phrase = (typeof PHRASES)[number];

/**
 * The 12 synthetic images (6 originals, 6 edits) and the instance counts SAM returned for each
 * phrase in the recording. These are SAM's answers, not ground truth (see the samples README
 * and the counts table in docs/model-notes.md, P1-05). A re-recording that changes them fails
 * here on purpose, so the change is looked at.
 */
const RECORDED_COUNTS: Readonly<Record<string, Readonly<Record<Phrase, number>>>> = {
  'living-empty': { window: 1, door: 1, radiator: 1 },
  'living-empty.edit-add-sofa': { window: 1, door: 1, radiator: 1 },
  'living-empty.edit-remove-window': { window: 0, door: 1, radiator: 1 },
  'living-dining-cluttered': { window: 2, door: 1, radiator: 2 },
  'living-dining-cluttered.edit-declutter-table': { window: 2, door: 1, radiator: 2 },
  'kitchen-cluttered': { window: 1, door: 9, radiator: 1 },
  'bedroom-empty': { window: 1, door: 4, radiator: 1 },
  'bedroom-empty.edit-add-bed': { window: 1, door: 4, radiator: 1 },
  hallway: { window: 1, door: 3, radiator: 1 },
  'hallway.edit-add-rug-plant': { window: 1, door: 3, radiator: 1 },
  'dining-chairs': { window: 1, door: 1, radiator: 1 },
  'dining-chairs.edit-replace-chairs': { window: 1, door: 1, radiator: 1 },
};

const replay = createMetaReplay({ cassette: CASSETTE });
const usage = createInMemoryUsageRecorder();
let clients: MetaClients;
let recordedTexts: Set<string> | undefined;

beforeAll(async () => {
  await replay.start();
  clients = createMetaClients({ apiKey: replay.apiKey, usage, estimateCost: samCostEstimator });
  if (replay.mode === 'replay') recordedTexts = new Set(await recordedOutputTexts(CASSETTE));
});

afterEach(() => {
  usage.clear();
  replay.assertAllMatched();
});

afterAll(async () => {
  await replay.stop();
});

describe(`${SAM} window/door/radiator segmentation (${replay.mode})`, () => {
  it.each(Object.keys(RECORDED_COUNTS))(
    'segments %s',
    async (name) => {
      const image = await readSample(name);
      const results: SamSegmentResult[] = await Promise.all(
        PHRASES.map((phrase) =>
          segmentImage(clients, { modelId: SAM, phrase, image, reasoningEffort: SAM_EFFORT }),
        ),
      );

      for (const result of results) {
        await appendSegmentSummary(name, result, replay.mode);
        for (const segment of result.segments) {
          expect(segment.label).toBe(result.phrase);
          expect(segment.score).toBeGreaterThan(0);
          expect(segment.score).toBeLessThanOrEqual(1);
          expect(segment.box.x1).toBeLessThanOrEqual(result.image.width);
          expect(segment.box.y1).toBeLessThanOrEqual(result.image.height);
        }
        // The AI SDK hands back the special-token text unchanged.
        if (recordedTexts !== undefined) expect(recordedTexts.has(result.rawText)).toBe(true);
      }

      const counts = Object.fromEntries(results.map((r) => [r.phrase, r.segments.length]));
      expect(counts).toEqual(RECORDED_COUNTS[name]);

      // Billed per image: one image per call, tokens reported as 0 (informational).
      expect(usage.entries).toHaveLength(PHRASES.length);
      for (const entry of usage.entries) {
        expect(entry).toMatchObject({ sdk: 'ai-sdk', modelId: SAM, images: 1, inputTokens: 0 });
        expect(entry.estimatedCostUsd).toBeCloseTo(0.0025, 10);
      }

      if (P1_05_OUT_DIR !== undefined && P1_05_OUT_DIR !== '') {
        const [first] = results;
        if (first === undefined) throw new Error('no results');
        await renderSamOverlayPng({
          imagePath: path.join(SAMPLES_DIR, `${name}.jpg`),
          outputPath: path.join(P1_05_OUT_DIR, 'overlays', `${name}.png`),
          width: first.image.width,
          height: first.image.height,
          layers: results.map((r) => ({
            instances: r.segments,
            color: PHRASE_COLORS[r.phrase] ?? [255, 255, 255],
          })),
        });
      }
    },
    180_000,
  );
});
