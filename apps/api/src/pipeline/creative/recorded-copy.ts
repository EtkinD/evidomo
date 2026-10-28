// The record/replay test body shared by `creative-copy-en.test.ts` and `creative-copy-nl.test.ts`
// (one cassette per output language, so each can be re-recorded alone). Imported only by tests.
import { listingCopyContentSchema, type ListingCopyContent } from '@evidomo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadDefinitions, type DefinitionRegistry } from '../../definitions/loader.ts';
import { createLogger } from '../../logger.ts';
import { createMetaClients } from '../../meta/clients.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import { createPriceTableCostEstimator } from '../../usage/ledger.ts';
import { storedFact } from '../reconciliation/testing.ts';
import { checkCopyOutput } from './check.ts';
import {
  buildCopyInput,
  buildCopyRequests,
  buildListingCopyContent,
  callCopy,
  validateCopy,
} from './generate.ts';
import { COPY_OUTPUT_NAME } from './prompt.ts';
import {
  COPY_CASSETTES,
  COPY_INCLUDED_CASSETTES,
  COPY_MATCH,
  placeholderArtifactIds,
  recordedCopySources,
  recordedCopyStep,
  replayPostGateFacts,
  type RecordedCopyLanguage,
} from './testing.ts';

const responseBodySchema = z.object({
  status: z.literal('completed'),
  reasoning: z.object({ effort: z.string() }),
  store: z.boolean(),
  text: z.object({
    format: z.object({ type: z.literal('json_schema'), name: z.string(), strict: z.boolean() }),
  }),
});

/** Segments and number claims the validator reads in each recording (P3-02). */
const RECORDED_NUMBER_COUNTS = {
  en: { segments: 17, numbers: 15 },
  nl: { segments: 22, numbers: 20 },
} as const satisfies Record<RecordedCopyLanguage, { segments: number; numbers: number }>;

export function describeRecordedCopy(language: RecordedCopyLanguage): void {
  const replay = createMetaReplay({
    cassette: COPY_CASSETTES[language],
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

  describe(`creative copy in "${language}" on Spark (${replay.mode})`, () => {
    it('writes portal and social copy whose segments cite verified facts only', async () => {
      const clients = createMetaClients({
        apiKey: replay.apiKey,
        usage,
        estimateCost: createPriceTableCostEstimator(),
        maxRetries: 0,
      });
      const ids = placeholderArtifactIds();
      const recorded = await replayPostGateFacts(clients, usage, registry, ids);
      usage.clear();
      const facts = recorded.facts.map((fact) => storedFact('run', fact));
      const sources = recordedCopySources(registry, facts, recorded.inventory, language);
      const input = buildCopyInput(sources);
      const { primary, fallback } = buildCopyRequests(
        recordedCopyStep(registry),
        sources.market,
        input,
      );
      expect(fallback).toBeNull();

      const startedAt = Date.now();
      const answer = await callCopy(clients, primary, { includeResponseBody: true });
      const latencyMs = Date.now() - startedAt;
      replay.assertAllMatched();

      expect(answer.finishReason).toBe('stop');
      expect(responseBodySchema.parse(answer.responseBody)).toMatchObject({
        reasoning: { effort: 'medium' },
        store: false,
        text: { format: { type: 'json_schema', name: COPY_OUTPUT_NAME, strict: true } },
      });

      // The input: verified facts only, the Gate 1 decision included, opinions never.
      const verified = new Set(facts.filter((f) => f.status === 'verified').map((f) => f.id));
      const catalogFactIds = sources.catalog.facts.flatMap((fact) => fact.factIds);
      expect(new Set(catalogFactIds)).toEqual(verified);
      const gateFact = facts.find((fact) => fact.source.kind === 'gate_decision');
      expect(catalogFactIds).toContain(gateFact?.id);
      expect(input.facts.some((fact) => fact.presence)).toBe(true);
      expect(input.facts.filter((fact) => fact.presence).every((f) => f.value === true)).toBe(true);

      const checked = checkCopyOutput(answer.output, sources.catalog, language);
      const content: ListingCopyContent = buildListingCopyContent({
        generated: {
          copy: checked,
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
      expect(listingCopyContentSchema.safeParse(content).success).toBe(true);
      expect(content.outputLanguage).toBe(language);
      expect(content.variants.map((v) => [v.kind, v.languageCheck])).toEqual([
        ['portal', 'match'],
        ['social', 'match'],
      ]);
      for (const segment of content.variants.flatMap((variant) => variant.segments)) {
        expect(segment.factIds.length).toBeGreaterThan(0);
        for (const id of segment.factIds) expect(verified.has(id)).toBe(true);
      }
      expect(content.counts.citedCatalogFacts).toBeGreaterThan(5);

      // The claim validator (P3-02): every number in the recorded copy is a cited fact's value
      // (hand-checked in P3-01), so both recordings pass with every number read.
      expect(content.validation).toMatchObject({
        language,
        result: 'pass',
        counts: { ...RECORDED_NUMBER_COUNTS[language], failedSegments: 0, findings: 0 },
      });
      // Seeded defects on the recorded text: the same segments fail once a number is changed,
      // softened, or left without its source.
      const segments = content.variants.flatMap((variant) => variant.segments);
      const withArea = segments.find(
        (segment) => segment.text.includes('92 m²') && segment.catalogIds.length > 1,
      );
      if (withArea === undefined) throw new Error('The recorded copy no longer states 92 m²');
      const seeded = (text: string, factIds = withArea.factIds) =>
        validateCopy(
          content.variants.map((variant) => ({
            ...variant,
            segments: variant.segments.map((segment) =>
              segment.index === withArea.index ? { ...segment, text, factIds } : segment,
            ),
          })),
          sources.facts,
          language,
        ).findings.map((finding) => [finding.segmentIndex, finding.code, finding.token]);
      const about = language === 'en' ? 'about' : 'ca.';
      expect(seeded(withArea.text.replace('92 m²', '95 m²'))).toEqual([
        [withArea.index, 'number_not_in_facts', '95 m²'],
      ]);
      expect(seeded(withArea.text.replace('92 m²', `${about} 92 m²`))).toEqual([
        [withArea.index, 'approximate_number', `${about} 92 m²`],
      ]);
      expect(seeded(withArea.text.replace('92 m²', '92 m³'))).toEqual([
        [withArea.index, 'unit_mismatch', '92 m³'],
      ]);
      const living = sources.catalog.facts.find((fact) => fact.key === 'living_area');
      expect(
        seeded(
          withArea.text,
          withArea.factIds.filter((id) => !(living?.factIds ?? []).includes(id)),
        ),
      ).toEqual([[withArea.index, 'number_not_in_facts', '92 m²']]);

      expect(usage.entries).toHaveLength(1);
      const [entry] = usage.entries;
      expect(entry).toMatchObject({ sdk: 'ai-sdk', modelId: 'muse-spark-1.3' });
      expect(entry?.estimatedCostUsd).toBeLessThan(0.1);
      if (replay.mode === 'record') {
        // Counts and usage only; the copy itself is read from the fixture.
        logger.info(
          {
            language,
            inputTokens: entry?.inputTokens,
            cachedInputTokens: entry?.cachedInputTokens,
            outputTokens: entry?.outputTokens,
            reasoningTokens: entry?.reasoningTokens,
            estimatedCostUsd: entry?.estimatedCostUsd,
            latencyMs,
            catalogFacts: content.counts.catalogFacts,
            citedCatalogFacts: content.counts.citedCatalogFacts,
            segments: content.variants.map((v) => [v.kind, v.segments.length]),
            repairs: content.repairs,
          },
          'p3-01-measurement',
        );
      }
    }, 240_000);
  });
}
