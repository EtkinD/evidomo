import {
  CLAIM_VALIDATOR_RULES_VERSION,
  QA_CARDS_ARTIFACT_KIND,
  QA_VARIANT,
  claimValidatorDetailsSchema,
  qaCardsGeneratedPayloadSchema,
  type QaCardsContent,
  type QaCardsGeneratedPayload,
  type ValidatorResult,
} from '@evidomo/shared';
import type { Executor } from '../../db/client.ts';
import { insertArtifact, listArtifacts, type Artifact } from '../../db/repositories/artifacts.ts';
import { insertClaims } from '../../db/repositories/claims.ts';
import { appendRunEvent } from '../../db/repositories/run-events.ts';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import type { StepHandler } from '../../runs/steps.ts';
import { findingsForSegment } from '../claims/validator.ts';
import { loadCopySources } from '../creative/handler.ts';
import {
  buildQaCardsContent,
  buildQaInput,
  buildQaRequests,
  droppedCardCount,
  generateQaCards,
} from './generate.ts';

// Step 5b, buyer Q&A cards (docs/architecture.md §5, "Buyer Q&A cards (P3-03)"): the run's
// verified facts after Gate 1 → one Spark call → 1-8 cards whose answers are claim segments
// citing stored facts, checked in code and by the claim validator → a `qa_cards` artifact plus
// one `claims` row per answer segment. Questions and answers are personal data: artifact and
// claims only, never logs or events.

export interface QaHandlerDeps {
  readonly markets: Pick<DefinitionRegistry, 'getMarket'>;
}

/** What a Q&A commit wrote; counts are those of the `qa_cards_generated` event. */
export interface StoredQaCards {
  readonly artifact: Artifact;
  readonly summary: QaCardsGeneratedPayload;
}

/**
 * Stores one set of cards inside the caller's transaction: the `qa_cards` artifact, a `claims`
 * row per answer segment (validator result and findings; verifier columns still empty), and a
 * `qa_cards_generated` event with counts only. Used by the Q&A step and by verification's Q&A
 * revisions (P3-06).
 */
export async function storeQaCards(
  tx: Executor,
  params: { readonly runId: string; readonly stepId: string; readonly content: QaCardsContent },
): Promise<StoredQaCards> {
  const { runId, stepId, content } = params;
  const artifact = await insertArtifact(tx, {
    runId,
    stepId,
    kind: QA_CARDS_ARTIFACT_KIND,
    content,
  });
  const { validation } = content;
  const claims = await insertClaims(
    tx,
    artifact.id,
    content.cards.flatMap((card) =>
      card.segments.map((segment) => {
        const findings = findingsForSegment(validation, QA_VARIANT, segment.index);
        const validatorResult: ValidatorResult = findings.length === 0 ? 'pass' : 'fail';
        return {
          segmentIndex: segment.index,
          text: segment.text,
          factIds: segment.factIds,
          validatorResult,
          validatorDetails: claimValidatorDetailsSchema.parse({
            rulesVersion: CLAIM_VALIDATOR_RULES_VERSION,
            findings,
          }),
        };
      }),
    ),
  );
  const summary = qaCardsGeneratedPayloadSchema.parse({
    stepId,
    artifactId: artifact.id,
    revision: content.revision,
    outputLanguage: content.outputLanguage,
    catalogFactCount: content.counts.catalogFacts,
    citedFactCount: content.counts.citedCatalogFacts,
    cardCount: content.counts.cards,
    segmentCount: content.counts.segments,
    claimCount: claims.length,
    mergedUncitedCount: content.repairs.mergedUncited,
    droppedCardCount: droppedCardCount(content),
    validatorResult: validation.result,
    validatorFailedSegmentCount: validation.counts.failedSegments,
    validatorFindingCount: validation.counts.findings,
    model: content.modelRun.model,
    fallbackUsed: content.modelRun.fallbackFrom !== null,
  } satisfies QaCardsGeneratedPayload);
  await appendRunEvent(tx, runId, { type: 'qa_cards_generated', payload: summary });
  return { artifact, summary };
}

export function createQaHandler(deps: QaHandlerDeps): StepHandler<'qa_writer'> {
  return async (ctx) => {
    const { run, step } = ctx;
    const market = deps.markets.getMarket(run.marketProfileId, run.marketProfileVersion);
    const {
      photos: _photos,
      revision: _revision,
      ...sources
    } = await loadCopySources(ctx.db, run, market);
    const input = buildQaInput({ ...sources, revision: null });
    const generated = await generateQaCards(
      {
        clients: ctx.metaClients(),
        meter: ctx.ledger.meter.bind(ctx.ledger),
        signal: ctx.signal,
        onFallback: (failure) => {
          ctx.logger.warn(
            { primaryModel: step.model, fallbackModel: step.fallback_model, failure },
            'Q&A primary model failed; using the fallback model',
          );
        },
      },
      buildQaRequests(step, market, input),
      sources.catalog,
      sources.outputLanguage,
    );
    const content = buildQaCardsContent({
      generated,
      catalog: sources.catalog,
      facts: sources.facts,
      input,
      revision: 0,
      previousArtifactId: null,
    });
    ctx.logger.info(
      {
        outputLanguage: content.outputLanguage,
        counts: content.counts,
        repairs: content.repairs,
        // Counts only: findings quote answer text and stay in the artifact and the claims.
        validation: { result: content.validation.result, ...content.validation.counts },
        languageCheck: content.languageCheck,
        model: content.modelRun.model,
      },
      'Q&A cards generated',
    );

    return {
      async commit(tx) {
        // Idempotency, as in the creative step: a repeated commit keeps the stored cards.
        const [existing] = await listArtifacts(tx, run.id, {
          kind: QA_CARDS_ARTIFACT_KIND,
          stepId: step.id,
        });
        if (existing !== undefined) {
          ctx.logger.warn(
            { artifactId: existing.id },
            'Q&A cards already stored for this step; keeping the existing cards',
          );
          return { artifactIds: [existing.id] };
        }
        const stored = await storeQaCards(tx, { runId: run.id, stepId: step.id, content });
        return { artifactIds: [stored.artifact.id] };
      },
    };
  };
}
