import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { buildReconciliationRequests, reconcileWithFallback } from './call.ts';
import { buildCatalog } from './catalog.ts';
import { resolveReconciliation } from './resolve.ts';
import {
  RECONCILIATION_FALLBACK_CASSETTE,
  RECONCILIATION_INCLUDED_CASSETTES,
  RECONCILIATION_MATCH,
  recordedReconciliationStep,
  replayRecordedCandidates,
  storedFact,
} from './testing.ts';

// The Spark fallback on the real catalog: Wonder is stubbed to return a truncated (billed)
// answer, so the step falls back to the definition's Spark `medium`, whose answer is recorded.
// Record (one Spark call, ~$0.05; docs/model-notes.md, P2-09):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api reconciliation-fallback

const replay = createMetaReplay({
  cassette: RECONCILIATION_FALLBACK_CASSETTE,
  include: RECONCILIATION_INCLUDED_CASSETTES,
  match: RECONCILIATION_MATCH,
});
const usage = createInMemoryUsageRecorder();
let registry: DefinitionRegistry;

const WONDER_USAGE = {
  input_tokens: 7066,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 12000,
  output_tokens_details: { reasoning_tokens: 2000 },
  total_tokens: 19066,
};

/** A Wonder answer cut off at `max_output_tokens`: billed in full, unparseable. */
function truncatedWonder(): Response {
  return Response.json({
    id: 'resp_stub_wonder',
    object: 'response',
    created_at: 1_793_154_894,
    model: 'muse-wonder-1.0',
    status: 'incomplete',
    error: null,
    incomplete_details: { reason: 'max_output_tokens' },
    store: false,
    output: [
      {
        type: 'message',
        id: 'msg_stub',
        role: 'assistant',
        status: 'incomplete',
        content: [
          { type: 'output_text', text: '{"verifiedFacts":[{"key":"other:addr', annotations: [] },
        ],
      },
    ],
    usage: WONDER_USAGE,
  });
}

const modelSchema = z.object({ model: z.string() });

beforeAll(async () => {
  registry = await loadDefinitions();
  await replay.start();
  // Wonder never reaches MSW; everything else (the earlier steps' cassettes, Spark) does. In
  // record mode MSW forwards with `fetch(bypass(request))`, which has no init and passes through.
  const mswFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === 'string') {
      const body = modelSchema.safeParse(JSON.parse(init.body));
      if (body.success && body.data.model === 'muse-wonder-1.0') {
        return Promise.resolve(truncatedWonder());
      }
    }
    return mswFetch(input, init);
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await replay.stop();
});

describe(`reconciliation fallback to Spark (${replay.mode})`, () => {
  it('answers with Spark medium when Wonder fails, and both calls reach the usage recorder', async () => {
    const clients = createMetaClients({
      apiKey: replay.apiKey,
      usage,
      estimateCost: createPriceTableCostEstimator(),
      maxRetries: 0,
    });
    const transcriptArtifactId = randomUUID();
    const recorded = await replayRecordedCandidates(clients, usage, registry, {
      transcriptArtifactId,
      inventoryArtifactId: randomUUID(),
    });
    usage.clear();

    const market = registry.getMarket('nl', 1);
    const catalog = buildCatalog({
      market,
      facts: recorded.facts.map((fact) => storedFact('run', fact)),
      transcript: { artifactId: transcriptArtifactId, turns: recorded.turns },
      inventory: recorded.inventory,
    });
    const failures: string[] = [];
    const answer = await reconcileWithFallback(
      {
        clients,
        meter: async (_modelId, call) => call(),
        onFallback: (failure) => failures.push(failure),
      },
      buildReconciliationRequests(recordedReconciliationStep(registry), catalog.input),
    );
    replay.assertAllMatched();

    expect(failures).toEqual(['NoObjectGeneratedError length']);
    expect(answer.modelRun).toEqual({
      model: 'muse-spark-1.3',
      reasoningEffort: 'medium',
      maxOutputTokens: 12000,
      fallbackFrom: {
        model: 'muse-wonder-1.0',
        reasoningEffort: 'low',
        failure: 'NoObjectGeneratedError length',
      },
    });
    expect(usage.entries.map((entry) => [entry.modelId, (entry.outputTokens ?? 0) > 0])).toEqual([
      ['muse-wonder-1.0', true],
      ['muse-spark-1.3', true],
    ]);
    const [, spark] = usage.entries;
    expect(spark?.reasoningTokens).toBeGreaterThan(0);
    expect(spark?.estimatedCostUsd).toBeLessThan(0.1);

    // The deterministic outcomes do not depend on which model answered.
    const result = resolveReconciliation(market, catalog, answer.output);
    expect(result.outcomes).toHaveLength(catalog.items.length);
    const living = result.entries.filter((entry) => entry.key === 'living_area');
    expect(living.map((entry) => [entry.value, entry.basis, entry.evidenceIds.length])).toEqual([
      [92, 'NEN2580', 2],
    ]);
    const approximate = catalog.items.find((i) => i.key === 'living_area' && i.value === 95);
    expect(result.outcomes.find((o) => o.factId === approximate?.fact.id)?.reason).toBe(
      'different_basis',
    );
    expect(result.diagnostics.verifiedAccepted).toBeGreaterThan(20);
    // Measurements for the notes (the shared logger is silent under test).
    if (replay.mode === 'record') {
      process.stdout.write(
        `p2-09-fallback ${JSON.stringify({
          sparkUsage: {
            input: spark?.inputTokens,
            cached: spark?.cachedInputTokens,
            output: spark?.outputTokens,
            reasoning: spark?.reasoningTokens,
            usd: spark?.estimatedCostUsd,
          },
          diagnostics: result.diagnostics,
          conflicts: result.conflicts.map((c) => [
            c.key,
            c.kind,
            c.sides.map((s) => `${s.evidenceIds.join('+')}=${JSON.stringify(s.value)}`),
          ]),
          rejected: result.outcomes
            .filter((o) => o.status === 'rejected')
            .map((o) => `${o.evidenceId}:${o.reason}`),
        })}\n`,
      );
    }
  }, 240_000);
});
