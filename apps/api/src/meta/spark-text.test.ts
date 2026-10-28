import { generateText } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMetaClients, type MetaClients } from './clients.ts';
import { createMetaReplay } from './replay.ts';
import { createInMemoryUsageRecorder, createTokenPriceEstimator } from './usage.ts';

// Record: RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api spark-text
// (see docs/model-notes.md, P1-01). Default runs replay fixtures/meta/p1-01/spark-text.json.

const SPARK = 'muse-spark-1.3';
// Synthetic, generic prompt: no personal data may enter a fixture.
const PROMPT = 'In one short sentence, explain what a floor plan shows.';
// Reasoning tokens count toward this cap; it bounds the cost of a live recording.
const MAX_OUTPUT_TOKENS = 2048;

const replay = createMetaReplay({ cassette: 'p1-01/spark-text' });
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

describe(`${SPARK} text call (${replay.mode})`, () => {
  it('runs through the AI SDK Responses model and captures usage', async () => {
    const result = await generateText({
      model: clients.languageModel(SPARK),
      prompt: PROMPT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...clients.aiSdkCallOptions(),
    });

    expect(result.finishReason).toBe('stop');
    expect(result.text.trim()).not.toBe('');

    expect(usage.entries).toHaveLength(1);
    const [entry] = usage.entries;
    expect(entry).toMatchObject({ sdk: 'ai-sdk', modelId: SPARK });
    expect(entry?.inputTokens).toBeGreaterThan(0);
    expect(entry?.outputTokens).toBeGreaterThan(0);
    expect(entry?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(entry?.estimatedCostUsd).toBeGreaterThan(0);
    expect(entry?.estimatedCostUsd).toBeLessThan(0.02);
  });

  it('runs through the openai SDK Responses API and captures usage', async () => {
    const response = await clients.captureOpenAIUsage(() =>
      clients.openai.responses.create({
        model: SPARK,
        input: PROMPT,
        max_output_tokens: MAX_OUTPUT_TOKENS,
      }),
    );

    expect(response.status).toBe('completed');
    expect(response.output_text.trim()).not.toBe('');

    expect(usage.entries).toHaveLength(1);
    const [entry] = usage.entries;
    expect(entry).toMatchObject({ sdk: 'openai', modelId: SPARK, responseId: response.id });
    expect(entry?.inputTokens).toBeGreaterThan(0);
    expect(entry?.outputTokens).toBeGreaterThan(0);
    expect(entry?.estimatedCostUsd).toBeGreaterThan(0);
    expect(entry?.estimatedCostUsd).toBeLessThan(0.02);
  });
});
