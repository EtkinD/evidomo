import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMetaClients, type MetaClients } from './clients.ts';
import { createMetaReplay } from './replay.ts';
import {
  appendSegmentSummary,
  readSample,
  recordedOutputTexts,
  SAM,
  SAM_EFFORT,
  samCostEstimator,
} from './sam-test-support.ts';
import { segmentImage } from './sam.ts';
import { createInMemoryUsageRecorder } from './usage.ts';

// Record (6 calls, $0.015): RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run
//   --project api sam-privacy   (docs/model-notes.md, P1-05)
//
// Negative cases only: the synthetic interiors contain no people and no vehicles, so both
// phrases must come back empty. Positive privacy-mask behaviour (faces, bodies, plates on real
// photos) is NOT verified by this fixture.

const CASSETTE = 'p1-05/sam-privacy';
const IMAGES = ['living-empty', 'kitchen-cluttered', 'hallway'] as const;
const PHRASES = ['person', 'license plate'] as const;
const CASES = IMAGES.flatMap((image) => PHRASES.map((phrase) => ({ image, phrase })));

const replay = createMetaReplay({ cassette: CASSETTE });
const usage = createInMemoryUsageRecorder();
let clients: MetaClients;
let recordedTexts: string[] | undefined;

beforeAll(async () => {
  await replay.start();
  clients = createMetaClients({ apiKey: replay.apiKey, usage, estimateCost: samCostEstimator });
  if (replay.mode === 'replay') recordedTexts = await recordedOutputTexts(CASSETTE);
});

afterEach(() => {
  usage.clear();
  replay.assertAllMatched();
});

afterAll(async () => {
  await replay.stop();
});

describe(`${SAM} privacy phrases on images without people or plates (${replay.mode})`, () => {
  it.each(CASES)(
    'finds no $phrase in $image',
    async ({ image, phrase }) => {
      const result = await segmentImage(clients, {
        modelId: SAM,
        phrase,
        image: await readSample(image),
        reasoningEffort: SAM_EFFORT,
      });
      await appendSegmentSummary(image, result, replay.mode);

      // Zero matches is a completed response with empty output text, not an error.
      expect(result.segments).toEqual([]);
      expect(result.rawText.trim()).toBe('');
      // An empty result is still a billed image.
      expect(usage.entries).toEqual([result.usage]);
      expect(result.usage).toMatchObject({ modelId: SAM, images: 1 });
      expect(result.usage.estimatedCostUsd).toBeCloseTo(0.0025, 10);
    },
    120_000,
  );

  it.runIf(replay.mode === 'replay')('recorded only empty outputs', () => {
    expect(recordedTexts).toHaveLength(CASES.length);
    for (const text of recordedTexts ?? []) expect(text.trim()).toBe('');
  });
});
