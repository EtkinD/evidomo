// The record/replay test body shared by `qa-cards-en.test.ts` and `qa-cards-nl.test.ts` (one
// cassette per output language, so each can be re-recorded alone). Imported only by tests.
import { qaCardsContentSchema, QA_CARD_LIMITS, type QaCardsContent } from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createLogger } from '../../logger.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { readNumbers } from '../claims/numbers.ts';
import {
  COPY_INCLUDED_CASSETTES,
  COPY_MATCH,
  placeholderArtifactIds,
  replayPostGateFacts,
  type RecordedCopyLanguage,
} from '../creative/testing.ts';
import { storedFact } from '../reconciliation/testing.ts';
import { checkQaOutput } from './check.ts';
import {
  buildQaCardsContent,
  buildQaInput,
  buildQaRequests,
  callQa,
  validateQa,
} from './generate.ts';
import { QA_OUTPUT_NAME } from './prompt.ts';
import { QA_CASSETTES, recordedQaSources, recordedQaStep } from './testing.ts';

const responseBodySchema = z.object({
  status: z.literal('completed'),
  reasoning: z.object({ effort: z.string() }),
  store: z.boolean(),
  text: z.object({
    format: z.object({ type: z.literal('json_schema'), name: z.string(), strict: z.boolean() }),
  }),
});

export function describeRecordedQa(language: RecordedCopyLanguage): void {
  const replay = createMetaReplay({
    cassette: QA_CASSETTES[language],
    include: COPY_INCLUDED_CASSETTES,
    match: COPY_MATCH,
  });
  const usage = createInMemoryUsageRecorder();
  const logger = createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' });
  let registry: DefinitionRegistry;

  beforeAll(async () => {
    registry = await loadDefinitions();
    await replay.start();
  });

  afterAll(async () => {
    await replay.stop();
  });

  describe(`buyer Q&A cards in "${language}" on Spark (${replay.mode})`, () => {
    it('writes cards whose answers cite verified facts only and pass the claim validator', async () => {
      const clients = createMetaClients({
        apiKey: replay.apiKey,
        usage,
        estimateCost: createPriceTableCostEstimator(),
        maxRetries: 0,
      });
      const recorded = await replayPostGateFacts(
        clients,
        usage,
        registry,
        placeholderArtifactIds(),
      );
      usage.clear();
      const facts = recorded.facts.map((fact) => storedFact('run', fact));
      const sources = recordedQaSources(registry, facts, recorded.inventory, language);
      const input = buildQaInput(sources);
      const { primary, fallback } = buildQaRequests(
        recordedQaStep(registry),
        sources.market,
        input,
      );
      expect(fallback).toBeNull();

      const startedAt = Date.now();
      const answer = await callQa(clients, primary, { includeResponseBody: true });
      const latencyMs = Date.now() - startedAt;
      replay.assertAllMatched();

      expect(answer.finishReason).toBe('stop');
      expect(responseBodySchema.parse(answer.responseBody)).toMatchObject({
        reasoning: { effort: 'low' },
        store: false,
        text: { format: { type: 'json_schema', name: QA_OUTPUT_NAME, strict: true } },
      });

      // The input: verified facts only (the Gate 1 decision included), opinions never.
      const verified = new Set(facts.filter((f) => f.status === 'verified').map((f) => f.id));
      expect(new Set(sources.catalog.facts.flatMap((fact) => fact.factIds))).toEqual(verified);

      const checked = checkQaOutput(answer.output, sources.catalog, language);
      const content: QaCardsContent = buildQaCardsContent({
        generated: {
          qa: checked,
          modelRun: {
            model: primary.modelId,
            reasoningEffort: primary.reasoningEffort,
            maxOutputTokens: primary.maxOutputTokens,
            fallbackFrom: null,
          },
        },
        catalog: sources.catalog,
        facts: sources.facts,
        input,
        revision: 0,
        previousArtifactId: null,
      });
      expect(qaCardsContentSchema.safeParse(content).success).toBe(true);
      expect(content.languageCheck).toBe('match');
      // The prompt asks for 4 to 8 cards; the recorded walkthrough has facts for that many.
      expect(content.cards.length).toBeGreaterThanOrEqual(4);
      expect(content.cards.length).toBeLessThanOrEqual(QA_CARD_LIMITS.maxCards);
      for (const card of content.cards) {
        expect(card.question.endsWith('?')).toBe(true);
        expect(readNumbers(card.question, language)).toEqual([]);
        for (const segment of card.segments) {
          expect(segment.factIds.length).toBeGreaterThan(0);
          for (const id of segment.factIds) expect(verified.has(id)).toBe(true);
          // No referral filler: every answer segment states a fact.
          expect(segment.text.toLowerCase()).not.toMatch(/contact|makelaar|agent|bezichtiging/);
        }
      }

      // Done when (P3-03): generated from verified facts only and passing the claim validator.
      expect(content.validation).toMatchObject({
        language,
        result: 'pass',
        counts: { failedSegments: 0, findings: 0 },
      });
      // Seeded defect on the recorded text: a changed number fails the same segment.
      const withNumber = content.cards
        .flatMap((card) => card.segments)
        .find((segment) => readNumbers(segment.text, language).length > 0);
      if (withNumber === undefined) throw new Error('The recorded cards state no number');
      const [token] = readNumbers(withNumber.text, language);
      if (token === undefined) throw new Error('unreachable');
      const seededText =
        withNumber.text.slice(0, token.start) + '9999' + withNumber.text.slice(token.end);
      const seeded = validateQa(
        content.cards.map((card) => ({
          ...card,
          segments: card.segments.map((segment) =>
            segment.index === withNumber.index ? { ...segment, text: seededText } : segment,
          ),
        })),
        sources.facts,
        language,
      );
      expect(seeded.findings.map((f) => [f.variant, f.segmentIndex, f.code])).toContainEqual([
        'qa',
        withNumber.index,
        'number_not_in_facts',
      ]);

      expect(usage.entries).toHaveLength(1);
      const [entry] = usage.entries;
      expect(entry).toMatchObject({ sdk: 'ai-sdk', modelId: 'muse-spark-1.3' });
      expect(entry?.estimatedCostUsd).toBeLessThan(0.05);
      if (replay.mode === 'record') {
        // Counts and usage only; the cards themselves are read from the fixture.
        logger.info(
          {
            language,
            inputTokens: entry?.inputTokens,
            cachedInputTokens: entry?.cachedInputTokens,
            outputTokens: entry?.outputTokens,
            reasoningTokens: entry?.reasoningTokens,
            estimatedCostUsd: entry?.estimatedCostUsd,
            latencyMs,
            counts: content.counts,
            repairs: content.repairs,
          },
          'p3-03-measurement',
        );
      }
    }, 240_000);
  });
}
