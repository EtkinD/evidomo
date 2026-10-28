import { generateText, Output } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMetaClients, type MetaClients } from './clients.ts';
import { metaProviderOptions } from './options.ts';
import { createMetaReplay } from './replay.ts';
import { createInMemoryUsageRecorder, createTokenPriceEstimator } from './usage.ts';

// Record: RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api spark-structured
// (see docs/model-notes.md, P1-02). Default runs replay fixtures/meta/p1-02/spark-structured.json.

const SPARK = 'muse-spark-1.3';
const MAX_OUTPUT_TOKENS = 4096;

// Synthetic listing notes: no address, names, or other personal data.
const INPUT =
  'Synthetic listing notes: two bedrooms, living area 74 m2, built in 1998, energy label B, ' +
  'south-facing balcony of 6 m2, monthly service charge EUR 180. The seller thinks the attic ' +
  'could become a third bedroom.';
const SYSTEM =
  'Extract property facts from the notes. One fact per item. Copy `source` verbatim from the ' +
  'notes. Use basis "stated" for facts stated as fact and "opinion" for beliefs or possibilities. ' +
  'Use a number for `value` when the fact is numeric, and null for `unit` when there is none.';

// Shaped like the P2-07 fact extraction. Every field is required (nullable instead of optional)
// so the derived JSON schema satisfies strict mode.
// Spelled-out numbers that occur in INPUT, for the number-in-source check below.
const NUMBER_WORDS: Readonly<Record<number, string>> = { 2: 'two', 3: 'three' };

const factSchema = z.object({
  key: z.string().describe('snake_case fact name, e.g. living_area'),
  value: z.union([z.number(), z.string()]),
  unit: z.string().nullable(),
  basis: z.enum(['stated', 'opinion']),
  source: z.string().describe('verbatim quote from the notes'),
});
const factsSchema = z.object({ facts: z.array(factSchema) });

const responseBodySchema = z.object({
  status: z.literal('completed'),
  reasoning: z.object({ effort: z.string() }),
  store: z.boolean(),
  text: z.object({
    format: z.object({ type: z.literal('json_schema'), name: z.string(), strict: z.boolean() }),
  }),
});

const replay = createMetaReplay({ cassette: 'p1-02/spark-structured' });
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

describe(`${SPARK} structured output (${replay.mode})`, { timeout: 120_000 }, () => {
  it('returns facts that validate against a zod schema in strict json_schema mode', async () => {
    const result = await generateText({
      model: clients.languageModel(SPARK),
      system: SYSTEM,
      prompt: INPUT,
      output: Output.object({ schema: factsSchema, name: 'fact_extraction' }),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // The SDK drops the raw body by default; the tests check what Meta echoes back.
      include: { responseBody: true },
      providerOptions: metaProviderOptions({ reasoningEffort: 'low' }),
      ...clients.aiSdkCallOptions(),
    });

    expect(result.warnings).toEqual([]);
    expect(result.finishReason).toBe('stop');
    expect(responseBodySchema.parse(result.response.body)).toMatchObject({
      reasoning: { effort: 'low' },
      store: false,
      text: { format: { type: 'json_schema', name: 'fact_extraction', strict: true } },
    });

    // The SDK validated the output already; re-parse the raw text to prove it independently.
    const facts = factsSchema.parse(JSON.parse(result.text)).facts;
    expect(result.output.facts).toEqual(facts);
    expect(facts.length).toBeGreaterThanOrEqual(5);

    // Provenance-style checks: sources are verbatim, and every numeric value appears in its
    // source. The recording showed Spark normalizes spelled-out numbers ("two bedrooms" -> 2), so
    // a digits-only match is not enough; the P3 claim validator must handle number words too.
    for (const fact of facts) {
      expect(INPUT, `source not verbatim: ${fact.source}`).toContain(fact.source);
      if (typeof fact.value === 'number') {
        const spelled = NUMBER_WORDS[fact.value];
        const pattern = spelled === undefined ? `${fact.value}` : `${fact.value}|${spelled}`;
        expect(fact.source, `${fact.key} number not in source`).toMatch(
          new RegExp(`\\b(${pattern})\\b`, 'i'),
        );
      }
    }
    expect(facts).toContainEqual(expect.objectContaining({ key: 'bedrooms', value: 2 }));
    const numbers = facts.map((fact) => fact.value).filter((value) => typeof value === 'number');
    expect(numbers).toEqual(expect.arrayContaining([74, 1998, 6, 180]));
    expect(facts.some((fact) => fact.basis === 'opinion')).toBe(true);

    expect(usage.entries).toHaveLength(1);
    const [entry] = usage.entries;
    expect(entry).toMatchObject({ sdk: 'ai-sdk', modelId: SPARK });
    expect(entry?.reasoningTokens).toBeGreaterThan(0);
    expect(entry?.outputTokens).toBeGreaterThan(entry?.reasoningTokens ?? 0);
    expect(entry?.estimatedCostUsd).toBeLessThan(0.03);
  });
});
