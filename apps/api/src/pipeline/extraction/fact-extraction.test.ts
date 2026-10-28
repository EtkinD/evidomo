import { factSourceSchema, type StoredTranscriptTurn } from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createLogger } from '../../logger.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { WALKTHROUGH_FACT_FORM, walkthroughMarket } from '../intake/testing.ts';
import { reconciliationInputSchema, type ReconciliationInput } from '../reconciliation/schema.ts';
import { factFormToCandidates } from './form.ts';
import {
  buildFactExtractionRequest,
  callFactExtraction,
  FACT_EXTRACTION_OUTPUT_NAME,
  toTranscriptFact,
} from './handler.ts';
import { normalizeExtractedFacts } from './normalize.ts';
import { OTHER_KEY_PREFIX, OTHER_SLUG_PATTERN, UNSPECIFIED_BASIS } from './schema.ts';
import {
  EXTRACTION_CASSETTE,
  EXTRACTION_INCLUDED_CASSETTES,
  EXTRACTION_MATCH,
  replayWalkthroughTurns,
  walkthroughExtractionStep,
} from './testing.ts';

// The fact extraction request (Spark, strict json_schema, effort and token cap from the step)
// over the P2-06 walkthrough transcript, which replays from its own cassette in both modes.
// Record (spends one Spark call, ~$0.01-0.02; docs/model-notes.md, P2-07):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api fact-extraction
// Assertions are structural; the extraction quality on the planted items is in the notes.

const replay = createMetaReplay({
  cassette: EXTRACTION_CASSETTE,
  include: EXTRACTION_INCLUDED_CASSETTES,
  match: EXTRACTION_MATCH,
});
const usage = createInMemoryUsageRecorder();
const logger = createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' });
let registry: DefinitionRegistry;
let turns: StoredTranscriptTurn[];

const responseBodySchema = z.object({
  status: z.literal('completed'),
  reasoning: z.object({ effort: z.string() }),
  store: z.boolean(),
  text: z.object({
    format: z.object({ type: z.literal('json_schema'), name: z.string(), strict: z.boolean() }),
  }),
});

beforeAll(async () => {
  registry = await loadDefinitions();
  await replay.start();
});

afterAll(async () => {
  await replay.stop();
});

describe(`fact extraction request (${replay.mode})`, () => {
  it('returns candidate facts that survive validation with verbatim quotes', async () => {
    const clients = createMetaClients({
      apiKey: replay.apiKey,
      usage,
      estimateCost: createPriceTableCostEstimator(),
      maxRetries: 0,
    });
    turns = await replayWalkthroughTurns(clients, usage, registry);
    expect(turns).toHaveLength(15);
    usage.clear();

    const market = walkthroughMarket(registry);
    const step = walkthroughExtractionStep(registry);
    const request = buildFactExtractionRequest({ step, market, turns });
    const startedAt = Date.now();
    const answer = await callFactExtraction(clients, request, { includeResponseBody: true });
    const latencyMs = Date.now() - startedAt;
    replay.assertAllMatched();

    expect(answer.finishReason).toBe('stop');
    expect(answer.warningCount).toBe(0);
    expect(responseBodySchema.parse(answer.responseBody)).toMatchObject({
      reasoning: { effort: 'low' },
      store: false,
      text: { format: { type: 'json_schema', name: FACT_EXTRACTION_OUTPUT_NAME, strict: true } },
    });

    const normalized = normalizeExtractedFacts(market, turns, answer.facts);
    const { accepted, rejected } = normalized;
    // A walkthrough of 15 turns states dozens of facts; nearly all must survive validation.
    expect(answer.facts.length).toBeGreaterThanOrEqual(15);
    expect(accepted.length).toBeGreaterThanOrEqual(answer.facts.length * 0.9);

    const marketKeys = new Set(market.facts.map((fact) => fact.key));
    const bases = new Set([...market.area_bases.map((basis) => basis.id), UNSPECIFIED_BASIS]);
    for (const fact of accepted) {
      const turn = turns[fact.turnIndex];
      expect(turn?.text, `quote of ${fact.key}`).toContain(fact.quote);
      expect([turn?.startMs, turn?.endMs]).toEqual([fact.startMs, fact.endMs]);
      expect(
        marketKeys.has(fact.key) ||
          (fact.key.startsWith(OTHER_KEY_PREFIX) &&
            OTHER_SLUG_PATTERN.test(fact.key.slice(OTHER_KEY_PREFIX.length))),
        fact.key,
      ).toBe(true);
      if (fact.unit === market.units.area) expect(bases.has(fact.basis ?? '')).toBe(true);
      else expect(fact.basis).toBeNull();
      // The stored provenance is valid (no source, no claim).
      const stored = toTranscriptFact(
        'fact_extraction',
        '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf',
        fact,
      );
      expect(factSourceSchema.safeParse(stored.source).success).toBe(true);
    }
    // Every turn that mentions an area in square metres yields at least one area fact.
    for (const turn of turns.filter((t) => /vierkante meter/.test(t.text))) {
      expect(
        accepted.some((fact) => fact.turnIndex === turn.index && fact.unit === 'm2'),
        `turn ${turn.index}`,
      ).toBe(true);
    }
    expect(accepted.some((fact) => fact.key === 'living_area')).toBe(true);
    expect(accepted.some((fact) => fact.assertion === 'opinion')).toBe(true);

    // P2-09 consumes the candidates as they are: only catalog IDs are assigned.
    const form = factFormToCandidates(WALKTHROUGH_FACT_FORM, market).candidates;
    const turnId = (index: number): string => `T${String(index).padStart(2, '0')}`;
    const catalog: ReconciliationInput = {
      property: {
        label: 'Synthetic walkthrough (fictional)',
        market: market.id,
        propertyType: 'apartment',
        sourceLanguage: 'nl',
        outputLanguage: 'en',
      },
      form: form.map((fact) => ({
        id: `F.${fact.field}`,
        field: fact.field,
        value: fact.value,
        unit: fact.unit,
        basis: fact.basis,
      })),
      transcript: turns.map((turn) => ({
        turnId: turnId(turn.index),
        speaker: turn.speaker,
        startMs: turn.startMs,
        endMs: turn.endMs,
        text: turn.text,
      })),
      candidates: accepted.map((fact, i) => ({
        id: `C${String(i + 1).padStart(2, '0')}`,
        key: fact.key,
        value: fact.value,
        unit: fact.unit,
        basis: fact.basis,
        assertion: fact.assertion,
        quote: fact.quote,
        turnId: turnId(fact.turnIndex),
        startMs: fact.startMs,
        endMs: fact.endMs,
      })),
      photos: [],
      inventory: [],
    };
    expect(reconciliationInputSchema.safeParse(catalog).error).toBeUndefined();

    expect(usage.entries).toHaveLength(1);
    const [entry] = usage.entries;
    expect(entry).toMatchObject({ sdk: 'ai-sdk', modelId: step.model });
    expect(entry?.reasoningTokens).toBeGreaterThan(0);
    expect(entry?.estimatedCostUsd).toBeLessThan(0.05);
    if (replay.mode === 'record') {
      logger.info(
        {
          inputTokens: entry?.inputTokens,
          cachedInputTokens: entry?.cachedInputTokens,
          outputTokens: entry?.outputTokens,
          reasoningTokens: entry?.reasoningTokens,
          estimatedCostUsd: entry?.estimatedCostUsd,
          latencyMs,
          modelFacts: answer.facts.length,
          accepted: accepted.length,
          rejected: rejected.map((item) => item.reason),
        },
        'p2-07-measurement',
      );
    }
  }, 180_000);
});
