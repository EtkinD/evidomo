// Test support for the Q&A step, shared by the record/replay tests, the verification tests that
// audit Q&A cards, and the integration test, so all of them send exactly the request the P3-03
// fixtures were recorded with. Imported only by tests.
import type { Fact } from '../../db/repositories/facts.ts';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import type { StepConfig } from '../../runs/steps.ts';
import {
  qaCardsContentSchema,
  type ListingCopyContent,
  type PhotoInventoryContent,
  type QaCardsContent,
} from '@evidomo/shared';
import type { ClaimFact } from '../claims/validator.ts';
import { recordedCopySources, type RecordedCopyLanguage } from '../creative/testing.ts';
import { validateQa, type QaSources } from './generate.ts';

export const QA_CASSETTES = { en: 'p3-03/qa-en', nl: 'p3-03/qa-nl' } as const;

/**
 * The Q&A step of `listing-launch` v1 with the settings the fixtures were recorded with, so they
 * keep matching if the definition's defaults change later.
 */
export function recordedQaStep(
  registry: Pick<DefinitionRegistry, 'getService'>,
): StepConfig<'qa_writer'> {
  const service = registry.getService('listing-launch', 1);
  const step = service.steps.find((candidate) => candidate.agent === 'qa_writer');
  if (step?.agent !== 'qa_writer') throw new Error('listing-launch v1 has no qa_writer step');
  const { fallback_model: _model, fallback_reasoning_effort: _effort, ...rest } = step;
  return { ...rest, model: 'muse-spark-1.3', reasoning_effort: 'low', max_output_tokens: 8000 };
}

/** The Q&A sources the handler builds for these facts, without a database. */
export function recordedQaSources(
  registry: Pick<DefinitionRegistry, 'getMarket'>,
  facts: readonly Fact[],
  inventory: PhotoInventoryContent,
  outputLanguage: RecordedCopyLanguage,
): QaSources {
  const { photos: _photos, ...sources } = recordedCopySources(
    registry,
    facts,
    inventory,
    outputLanguage,
  );
  return { ...sources, revision: null };
}

/**
 * Q&A cards built from segments of a stored copy draft (same text and citations, so they
 * validate like the copy), for tests that need stored cards without a model call: one card per
 * source, answered by the listed copy segment indexes; answer indexes run 0..n-1.
 */
export function qaCardsFromCopy(
  draft: ListingCopyContent,
  facts: readonly ClaimFact[],
  sources: readonly { readonly question: string; readonly segments: readonly number[] }[],
): QaCardsContent {
  const segments = draft.variants.flatMap((variant) => variant.segments);
  let index = 0;
  const cards = sources.map((source, card) => ({
    card,
    question: source.question,
    segments: source.segments.map((at) => {
      const segment = segments.find((s) => s.index === at);
      if (segment === undefined) throw new Error(`no segment ${at}`);
      const answer = {
        index,
        text: segment.text,
        catalogIds: segment.catalogIds,
        factIds: segment.factIds,
      };
      index += 1;
      return answer;
    }),
  }));
  return qaCardsContentSchema.parse({
    schemaVersion: 1,
    promptVersion: 1,
    modelRun: draft.modelRun,
    outputLanguage: draft.outputLanguage,
    tone: draft.tone,
    revision: 0,
    previousArtifactId: null,
    catalog: draft.catalog,
    languageCheck: 'match',
    cards,
    repairs: {
      mergedUncited: 0,
      droppedEmpty: 0,
      droppedCards: {
        uncited: 0,
        invalidQuestion: 0,
        numberInQuestion: 0,
        duplicateQuestion: 0,
        overLimit: 0,
      },
    },
    counts: {
      catalogFacts: draft.catalog.length,
      citedCatalogFacts: new Set(cards.flatMap((c) => c.segments.flatMap((s) => s.catalogIds)))
        .size,
      cards: cards.length,
      segments: index,
    },
    validation: validateQa(cards, facts, draft.outputLanguage),
  } satisfies QaCardsContent);
}
