import { randomUUID } from 'node:crypto';
import { verifiedFactSheetContentSchema } from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createLogger } from '../../logger.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { buildReconciliationRequests, callReconciliation } from './call.ts';
import { buildCatalog } from './catalog.ts';
import { buildFactSheet } from './handler.ts';
import { resolveReconciliation } from './resolve.ts';
import { RECONCILIATION_OUTPUT_NAME } from './step-prompt.ts';
import {
  RECONCILIATION_CASSETTE,
  RECONCILIATION_INCLUDED_CASSETTES,
  RECONCILIATION_MATCH,
  recordedReconciliationStep,
  replayRecordedCandidates,
  storedFact,
} from './testing.ts';

// The reconciliation request (Wonder `low`, strict json_schema, settings from the step) over the
// recorded P2-07 candidates and P2-08 photo facts, which replay from their own cassettes in both
// modes. Record (one Wonder call, ~$0.10; docs/model-notes.md, P2-09):
//   RECORD=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project api reconciliation-wonder
// The deterministic outcomes (the basis rule on the planted living area, opinions, provenance)
// are asserted; the model's judgment on `other:` facts is logged in record mode and described in
// the notes, never asserted for one recording.

const replay = createMetaReplay({
  cassette: RECONCILIATION_CASSETTE,
  include: RECONCILIATION_INCLUDED_CASSETTES,
  match: RECONCILIATION_MATCH,
});
const usage = createInMemoryUsageRecorder();
const logger = createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' });
let registry: DefinitionRegistry;

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

describe(`reconciliation on Wonder (${replay.mode})`, () => {
  it('verifies the walkthrough candidates and applies the basis rule to the planted living area', async () => {
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
    const step = recordedReconciliationStep(registry);
    const { primary } = buildReconciliationRequests(step, catalog.input);
    const startedAt = Date.now();
    const answer = await callReconciliation(clients, primary, { includeResponseBody: true });
    const latencyMs = Date.now() - startedAt;
    replay.assertAllMatched();

    expect(answer.finishReason).toBe('stop');
    expect(responseBodySchema.parse(answer.responseBody)).toMatchObject({
      reasoning: { effort: 'low' },
      store: false,
      text: { format: { type: 'json_schema', name: RECONCILIATION_OUTPUT_NAME, strict: true } },
    });

    const result = resolveReconciliation(market, catalog, answer.output);
    const sheet = buildFactSheet(catalog, result, {
      model: primary.modelId,
      reasoningEffort: primary.reasoningEffort,
      maxOutputTokens: primary.maxOutputTokens,
      fallbackFrom: null,
    });
    expect(verifiedFactSheetContentSchema.safeParse(sheet).success).toBe(true);
    expect(sheet.outcomes).toHaveLength(catalog.items.length);

    // The planted living area: form 92 and the NEN 2580 turn agree; "zo'n 95" without a basis is
    // a different measure, so it is set aside with a note and is not a conflict.
    const living = result.entries.filter((entry) => entry.key === 'living_area');
    expect(living).toHaveLength(1);
    expect(living[0]).toMatchObject({
      value: 92,
      unit: 'm2',
      basis: 'NEN2580',
      reason: 'agreement',
    });
    expect(living[0]?.evidenceIds).toHaveLength(2);
    const approximate = catalog.items.find((i) => i.key === 'living_area' && i.value === 95);
    expect(result.outcomes.find((o) => o.factId === approximate?.fact.id)).toMatchObject({
      status: 'rejected',
      reason: 'different_basis',
    });
    expect(result.basisNotes.map((note) => note.factId)).toContain(approximate?.fact.id);
    expect(result.conflicts.flatMap((c) => c.sides.map((s) => s.key))).not.toContain('living_area');

    // Market facts the form and the walkthrough agree on are verified by code.
    for (const key of ['energy_label', 'build_year', 'vve_monthly_contribution']) {
      expect(result.entries.find((e) => e.key === key)).toMatchObject({
        reason: 'agreement',
        decidedBy: 'code',
      });
    }
    // Opinions are rejected; nothing unverifiable reaches the sheet.
    for (const item of catalog.items.filter((i) => i.assertion === 'opinion')) {
      expect(result.outcomes.find((o) => o.factId === item.fact.id)?.reason).toBe('opinion');
    }
    for (const entry of result.entries) {
      const cited = catalog.items.filter((i) => entry.factIds.includes(i.fact.id));
      expect(cited.some((i) => i.key === entry.key && i.value === entry.value)).toBe(true);
    }
    // The model accounted for most `other:` candidates validly.
    expect(result.diagnostics.verifiedAccepted).toBeGreaterThan(20);

    expect(usage.entries).toHaveLength(1);
    const [entry] = usage.entries;
    expect(entry).toMatchObject({ sdk: 'ai-sdk', modelId: 'muse-wonder-1.0' });
    expect(entry?.estimatedCostUsd).toBeLessThan(0.2);
    if (replay.mode === 'record') {
      logger.info(
        {
          inputTokens: entry?.inputTokens,
          cachedInputTokens: entry?.cachedInputTokens,
          outputTokens: entry?.outputTokens,
          reasoningTokens: entry?.reasoningTokens,
          estimatedCostUsd: entry?.estimatedCostUsd,
          latencyMs,
          counts: sheet.counts,
          diagnostics: result.diagnostics,
          conflicts: result.conflicts.map((c) => ({
            key: c.key,
            kind: c.kind,
            by: c.detectedBy,
            sides: c.sides.map((s) => `${s.evidenceIds.join('+')}=${JSON.stringify(s.value)}`),
            why: c.explanation,
          })),
          rejected: result.outcomes
            .filter((o) => o.status === 'rejected')
            .map((o) => `${o.evidenceId}:${o.reason}`),
        },
        'p2-09-measurement',
      );
    }
  }, 240_000);
});
