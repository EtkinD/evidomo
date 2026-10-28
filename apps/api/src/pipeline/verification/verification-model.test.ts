import { generateText, Output } from 'ai';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMetaClients } from '../../meta/clients.ts';
import { metaProviderOptions } from '../../meta/options.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import { createInMemoryUsageRecorder, createTokenPriceEstimator } from '../../meta/usage.ts';
import { buildVerificationPrompt, VERIFICATION_SYSTEM_PROMPT } from './prompt.ts';
import { verificationInputSchema, verificationOutputSchema } from './schema.ts';
import {
  SYNTHETIC_NL_APARTMENT_COPY,
  SYNTHETIC_NL_APARTMENT_COPY_DEFECTS,
} from './synthetic-nl-apartment-copy.ts';

// P1-03: one verification-sized Wonder call to size the verification step (docs/model-notes.md).
// Default runs replay fixtures/meta/p1-03/wonder-verification-low.json. Record:
//   RECORD=1 node --env-file=.env node_modules/vitest/vitest.mjs run --project api verification-model
// Quality (planted defects caught) is reported in the notes, not asserted here.

const WONDER = 'muse-wonder-1.0';
const EFFORT = 'low';
// Bounds a live recording to 8k input x $4 + 16k output x $20 per 1M = $0.352.
const MAX_OUTPUT_TOKENS = 16_000;
const WORST_CASE_USD = 0.352;

const echoSchema = z.object({
  status: z.literal('completed'),
  reasoning: z.object({ effort: z.string() }),
  store: z.boolean(),
  text: z.object({
    format: z.object({ type: z.literal('json_schema'), name: z.string(), strict: z.boolean() }),
  }),
});

const estimateCost = createTokenPriceEstimator({
  [WONDER]: { inputUsdPerMillion: 4.0, outputUsdPerMillion: 20.0 },
});
const measurementLog = pino({ name: 'p1-03-measurement' });

describe('verification sizing', () => {
  it('validates its synthetic input', () => {
    const input = verificationInputSchema.parse(SYNTHETIC_NL_APARTMENT_COPY);
    const factIds = new Set(input.facts.map((fact) => fact.id));
    const segmentIds = new Set(input.segments.map((segment) => segment.id));
    expect(input.segments.flatMap((s) => s.factIds).filter((id) => !factIds.has(id))).toEqual([]);
    expect(
      Object.keys(SYNTHETIC_NL_APARTMENT_COPY_DEFECTS).filter((id) => !segmentIds.has(id)),
    ).toEqual([]);
  });

  it(`audits copy with ${WONDER} at effort ${EFFORT}`, { timeout: 660_000 }, async () => {
    const replay = createMetaReplay({ cassette: 'p1-03/wonder-verification-low' });
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
        model: clients.languageModel(WONDER),
        system: VERIFICATION_SYSTEM_PROMPT,
        prompt: buildVerificationPrompt(SYNTHETIC_NL_APARTMENT_COPY),
        output: Output.object({ schema: verificationOutputSchema, name: 'claim_audit' }),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        include: { responseBody: true },
        providerOptions: metaProviderOptions({ reasoningEffort: EFFORT }),
        ...clients.aiSdkCallOptions(),
      });

      expect(result.warnings).toEqual([]);
      expect(result.finishReason).toBe('stop');
      expect(echoSchema.parse(result.response.body)).toMatchObject({
        reasoning: { effort: EFFORT },
        store: false,
        text: { format: { type: 'json_schema', name: 'claim_audit', strict: true } },
      });

      const output = verificationOutputSchema.parse(JSON.parse(result.text));
      expect(result.output).toEqual(output);
      expect(output.audits.length).toBeGreaterThan(0);

      expect(usage.entries).toHaveLength(1);
      const [entry] = usage.entries;
      expect(entry).toMatchObject({ sdk: 'ai-sdk', modelId: WONDER });
      expect(entry?.reasoningTokens).toBeGreaterThan(0);
      expect(entry?.outputTokens).toBeGreaterThan(entry?.reasoningTokens ?? 0);
      expect(entry?.estimatedCostUsd).toBeGreaterThan(0);
      expect(entry?.estimatedCostUsd).toBeLessThanOrEqual(WORST_CASE_USD);
    } finally {
      // Logged even when the call or an assertion fails: the spend happened either way.
      if (replay.mode === 'record') {
        measurementLog.info({ entries: usage.entries }, 'usage');
      }
      await replay.stop();
    }
    replay.assertAllMatched();
  });
});
