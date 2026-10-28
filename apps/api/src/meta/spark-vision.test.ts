import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { generateText } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMetaClients, type MetaClients } from './clients.ts';
import { META_FIXTURES_DIR } from './fixtures.ts';
import { metaProviderOptions } from './options.ts';
import { createMetaReplay } from './replay.ts';
import { createInMemoryUsageRecorder, createTokenPriceEstimator } from './usage.ts';

// Record: RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api spark-vision
// (see docs/model-notes.md, P1-02). Default runs replay fixtures/meta/p1-02/spark-vision.json.

const SPARK = 'muse-spark-1.3';
const MAX_OUTPUT_TOKENS = 2048;
// Synthetic drawing made with ffmpeg (no people, text, or third-party content): two rooms joined by
// a door gap, three blue window markers on the outer walls, one red rectangle (docs/model-notes.md).
const IMAGE_PATH = path.join(META_FIXTURES_DIR, 'p1-02', 'synthetic-floor-plan.png');
const PROMPT =
  'This is a simple synthetic floor plan drawing. Count the rooms, the blue window markers on ' +
  'the walls, and the red rectangles. Answer with exactly one line in the form ' +
  '"rooms=<n>; windows=<n>; red=<n>" and nothing else.';
const ANSWER = /rooms=(\d+);\s*windows=(\d+);\s*red=(\d+)/;

const echoSchema = z.object({
  status: z.literal('completed'),
  reasoning: z.object({ effort: z.string() }),
  store: z.boolean(),
});

const replay = createMetaReplay({ cassette: 'p1-02/spark-vision' });
const usage = createInMemoryUsageRecorder();
const estimateCost = createTokenPriceEstimator({
  [SPARK]: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 4.25 },
});
let clients: MetaClients;

beforeAll(async () => {
  await replay.start();
  clients = createMetaClients({ apiKey: replay.apiKey, usage, estimateCost });
});

afterEach(() => {
  usage.clear();
  replay.assertAllMatched();
});

afterAll(async () => {
  await replay.stop();
});

describe(`${SPARK} single-image vision call (${replay.mode})`, { timeout: 120_000 }, () => {
  it('reads a synthetic floor plan sent as an image file part', async () => {
    const image = new Uint8Array(await readFile(IMAGE_PATH));

    const result = await generateText({
      model: clients.languageModel(SPARK),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: image } },
          ],
        },
      ],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // The SDK drops the raw body by default; the tests check what Meta echoes back.
      include: { responseBody: true },
      providerOptions: metaProviderOptions({ reasoningEffort: 'low' }),
      ...clients.aiSdkCallOptions(),
    });

    expect(result.warnings).toEqual([]);
    expect(result.finishReason).toBe('stop');
    expect(echoSchema.parse(result.response.body)).toMatchObject({
      reasoning: { effort: 'low' },
      store: false,
    });

    const match = ANSWER.exec(result.text);
    expect(match, `unexpected answer format: ${result.text}`).not.toBeNull();
    // The recorded answer is correct; a re-recording that miscounts should fail loudly.
    expect(match?.slice(1).map(Number)).toEqual([2, 3, 1]);

    // The image is billed as input tokens; reasoning still sits inside output tokens.
    expect(usage.entries).toHaveLength(1);
    const [entry] = usage.entries;
    expect(entry).toMatchObject({ sdk: 'ai-sdk', modelId: SPARK });
    expect(entry?.inputTokens).toBeGreaterThan(PROMPT.length / 8);
    expect(entry?.reasoningTokens).toBeGreaterThan(0);
    expect(entry?.outputTokens).toBeGreaterThan(entry?.reasoningTokens ?? 0);
    expect(entry?.estimatedCostUsd).toBeLessThan(0.02);
  });
});
