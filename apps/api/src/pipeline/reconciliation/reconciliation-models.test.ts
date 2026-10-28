import { generateText, Output } from 'ai';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMetaClients } from '../../meta/clients.ts';
import { metaProviderOptions, type MetaReasoningEffort } from '../../meta/options.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import {
  createInMemoryUsageRecorder,
  createTokenPriceEstimator,
  type TokenPrice,
} from '../../meta/usage.ts';
import { buildReconciliationPrompt, RECONCILIATION_SYSTEM_PROMPT } from './prompt.ts';
import { reconciliationOutputSchema } from './schema.ts';
import { scoreReconciliation } from './score.ts';
import {
  SYNTHETIC_NL_APARTMENT,
  SYNTHETIC_NL_APARTMENT_EXPECTATIONS,
} from './synthetic-nl-apartment.ts';

// P1-03 model/effort matrix on a reconciliation-sized prompt (docs/model-notes.md, P1-03).
// Default runs replay fixtures/meta/p1-03/*.json. Each call has its own cassette and starts and
// stops its own replay, so one call can be recorded at a time and spend checked in between:
//   RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api \
//     reconciliation-models -t "wonder low"
// Quality is scored in the notes, not asserted here: these assertions hold for any valid answer.

const WONDER = 'muse-wonder-1.0';
const SPARK = 'muse-spark-1.3';

const PRICES: Readonly<Record<string, TokenPrice>> = {
  [WONDER]: { inputUsdPerMillion: 4.0, outputUsdPerMillion: 20.0 },
  [SPARK]: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 4.25 },
};

// Upper bound on input tokens for the worst-case cost check (measured ~5k; see the notes).
const MAX_INPUT_TOKENS = 8_000;

interface MatrixCall {
  readonly label: string;
  readonly cassette: string;
  readonly model: string;
  readonly effort: MetaReasoningEffort;
  /** Caps reasoning + answer, so a runaway call cannot exceed its worst-case cost. */
  readonly maxOutputTokens: number;
}

const CALLS: readonly MatrixCall[] = [
  {
    label: 'wonder low',
    cassette: 'p1-03/wonder-low',
    model: WONDER,
    effort: 'low',
    maxOutputTokens: 16_000,
  },
  {
    label: 'wonder medium',
    cassette: 'p1-03/wonder-medium',
    model: WONDER,
    effort: 'medium',
    maxOutputTokens: 16_000,
  },
  {
    label: 'wonder medium sample 2',
    cassette: 'p1-03/wonder-medium-2',
    model: WONDER,
    effort: 'medium',
    maxOutputTokens: 16_000,
  },
  {
    label: 'wonder high',
    cassette: 'p1-03/wonder-high',
    model: WONDER,
    effort: 'high',
    maxOutputTokens: 24_000,
  },
  {
    label: 'spark medium',
    cassette: 'p1-03/spark-medium',
    model: SPARK,
    effort: 'medium',
    maxOutputTokens: 16_000,
  },
  {
    label: 'spark high',
    cassette: 'p1-03/spark-high',
    model: SPARK,
    effort: 'high',
    maxOutputTokens: 16_000,
  },
];

function worstCaseUsd(call: MatrixCall): number {
  const price = PRICES[call.model];
  if (price === undefined) throw new Error(`No price for ${call.model}`);
  return (
    (MAX_INPUT_TOKENS * price.inputUsdPerMillion +
      call.maxOutputTokens * price.outputUsdPerMillion) /
    1_000_000
  );
}

// What Meta echoes back about the request settings; the response body is untrusted input.
const echoSchema = z.object({
  status: z.literal('completed'),
  model: z.string(),
  reasoning: z.object({ effort: z.string() }),
  store: z.boolean(),
  max_output_tokens: z.number(),
  text: z.object({
    format: z.object({ type: z.literal('json_schema'), name: z.string(), strict: z.boolean() }),
  }),
});

const estimateCost = createTokenPriceEstimator(PRICES);

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the schema parse below reports it.
    return text;
  }
}
// Measurements are only logged while recording (latency is not in the cassette).
const measurementLog = pino({ name: 'p1-03-measurement' });

describe('reconciliation model/effort matrix', () => {
  it.each(CALLS)(
    '$label',
    // Live high-effort calls can take minutes; the client timeout is below this.
    { timeout: 660_000 },
    async (call) => {
      const replay = createMetaReplay({ cassette: call.cassette });
      const usage = createInMemoryUsageRecorder();
      await replay.start();
      try {
        // No retries: one attempt per measurement, and a retried long call would bill twice.
        const clients = createMetaClients({
          apiKey: replay.apiKey,
          usage,
          estimateCost,
          maxRetries: 0,
          timeoutMs: 600_000,
        });
        const result = await generateText({
          model: clients.languageModel(call.model),
          system: RECONCILIATION_SYSTEM_PROMPT,
          prompt: buildReconciliationPrompt(SYNTHETIC_NL_APARTMENT),
          output: Output.object({ schema: reconciliationOutputSchema, name: 'reconciliation' }),
          maxOutputTokens: call.maxOutputTokens,
          include: { responseBody: true },
          providerOptions: metaProviderOptions({ reasoningEffort: call.effort }),
          ...clients.aiSdkCallOptions(),
        });

        if (replay.mode === 'record') {
          const parsed = reconciliationOutputSchema.safeParse(safeJson(result.text));
          measurementLog.info(
            {
              label: call.label,
              finishReason: result.finishReason,
              score: parsed.success
                ? scoreReconciliation(
                    SYNTHETIC_NL_APARTMENT,
                    SYNTHETIC_NL_APARTMENT_EXPECTATIONS,
                    parsed.data,
                  )
                : z.prettifyError(parsed.error),
            },
            'score',
          );
        }

        expect(usage.entries).toHaveLength(1);
        const [entry] = usage.entries;
        expect(result.warnings).toEqual([]);
        expect(result.finishReason).toBe('stop');
        expect(echoSchema.parse(result.response.body)).toMatchObject({
          reasoning: { effort: call.effort },
          store: false,
          max_output_tokens: call.maxOutputTokens,
          text: { format: { type: 'json_schema', name: 'reconciliation', strict: true } },
        });

        // The SDK validated the output already; re-parse the raw text to prove it independently.
        const output = reconciliationOutputSchema.parse(JSON.parse(result.text));
        expect(result.output).toEqual(output);
        expect(output.verifiedFacts.length).toBeGreaterThan(0);

        expect(entry).toMatchObject({ sdk: 'ai-sdk', modelId: call.model });
        expect(entry?.inputTokens).toBeGreaterThan(3_000);
        expect(entry?.inputTokens).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
        expect(entry?.reasoningTokens).toBeGreaterThan(0);
        expect(entry?.outputTokens).toBeGreaterThan(entry?.reasoningTokens ?? 0);
        expect(entry?.outputTokens).toBeLessThanOrEqual(call.maxOutputTokens);
        expect(entry?.estimatedCostUsd).toBeGreaterThan(0);
        expect(entry?.estimatedCostUsd).toBeLessThanOrEqual(worstCaseUsd(call));
      } finally {
        // Logged even when the call or an assertion fails: the spend happened either way.
        if (replay.mode === 'record') {
          measurementLog.info({ label: call.label, entries: usage.entries }, 'usage');
        }
        await replay.stop();
      }
      replay.assertAllMatched();
    },
  );
});
