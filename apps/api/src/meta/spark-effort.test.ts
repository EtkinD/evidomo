import { generateText } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMetaClients, type MetaClients } from './clients.ts';
import { META_REASONING_EFFORTS, metaProviderOptions, metaResponsesParams } from './options.ts';
import { createMetaReplay } from './replay.ts';
import { createInMemoryUsageRecorder, createTokenPriceEstimator } from './usage.ts';

// Record: RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api spark-effort
// (see docs/model-notes.md, P1-02). Default runs replay fixtures/meta/p1-02/spark-effort.json.

const SPARK = 'muse-spark-1.3';
// Same synthetic prompt as P1-01 (default effort `high`), so the matrix is comparable with it.
const PROMPT = 'In one short sentence, explain what a floor plan shows.';
// Bounds the cost of a live recording; high enough that `max` is not cut off.
const MAX_OUTPUT_TOKENS = 4096;

// What Meta echoes back about the request settings; the response body is untrusted input.
const echoSchema = z.object({
  status: z.literal('completed'),
  reasoning: z.object({ effort: z.string() }),
  store: z.boolean(),
});

const replay = createMetaReplay({ cassette: 'p1-02/spark-effort' });
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

// Live `xhigh`/`max` calls can take far longer than Vitest's 5 s default.
describe(`${SPARK} reasoning-effort matrix (${replay.mode})`, { timeout: 180_000 }, () => {
  it.each(META_REASONING_EFFORTS)(
    'passes effort "%s" and store:false through the AI SDK',
    async (effort) => {
      const result = await generateText({
        model: clients.languageModel(SPARK),
        prompt: PROMPT,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // The SDK drops the raw body by default; the tests check what Meta echoes back.
        include: { responseBody: true },
        providerOptions: metaProviderOptions({ reasoningEffort: effort }),
        ...clients.aiSdkCallOptions(),
      });

      expect(result.warnings).toEqual([]);
      expect(result.finishReason).toBe('stop');
      expect(result.text.trim()).not.toBe('');
      expect(echoSchema.parse(result.response.body)).toMatchObject({
        reasoning: { effort },
        store: false,
      });

      // Reasoning tokens are part of output tokens, in the AI SDK's usage as in the raw body.
      expect(result.usage.outputTokenDetails.reasoningTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBe(
        (result.usage.outputTokenDetails.reasoningTokens ?? 0) +
          (result.usage.outputTokenDetails.textTokens ?? 0),
      );

      expect(usage.entries).toHaveLength(1);
      const [entry] = usage.entries;
      expect(entry).toMatchObject({ sdk: 'ai-sdk', modelId: SPARK });
      expect(entry?.reasoningTokens).toBe(result.usage.outputTokenDetails.reasoningTokens);
      expect(entry?.estimatedCostUsd).toBeGreaterThan(0);
      expect(entry?.estimatedCostUsd).toBeLessThan(0.02);
    },
  );

  it('passes effort and store:false through the openai SDK', async () => {
    const response = await clients.captureOpenAIUsage(() =>
      clients.openai.responses.create({
        model: SPARK,
        input: PROMPT,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        ...metaResponsesParams({ reasoningEffort: 'minimal' }),
      }),
    );

    expect(response.status).toBe('completed');
    // `store` is not in the openai SDK's Response type, so read it through the echo schema.
    expect(echoSchema.parse(response)).toMatchObject({
      reasoning: { effort: 'minimal' },
      store: false,
    });
    expect(response.output_text.trim()).not.toBe('');

    expect(usage.entries).toHaveLength(1);
    const [entry] = usage.entries;
    expect(entry).toMatchObject({ sdk: 'openai', modelId: SPARK, responseId: response.id });
    expect(entry?.reasoningTokens).toBeGreaterThan(0);
    expect(entry?.outputTokens).toBe(response.usage?.output_tokens);
  });
});
