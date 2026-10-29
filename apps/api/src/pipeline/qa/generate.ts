import {
  QA_VARIANT,
  qaCardsContentSchema,
  type ClaimValidationReport,
  type MarketProfile,
  type MetaReasoningEffort,
  type QaCard,
  type QaCardsContent,
  type ReconciliationModelRun,
} from '@evidomo/shared';
import { generateText, NoObjectGeneratedError, Output } from 'ai';
import type { MetaClients } from '../../meta/clients.ts';
import { metaProviderOptions } from '../../meta/options.ts';
import { NonRetryableStepError, type StepConfig } from '../../runs/steps.ts';
import { isClaimLanguage } from '../claims/numbers.ts';
import { validateClaims, type ClaimFact } from '../claims/validator.ts';
import type { CopyFactCatalog } from '../creative/catalog.ts';
import type { CopyCallDeps, CopySources } from '../creative/generate.ts';
import { modelFailureClass } from '../reconciliation/call.ts';
import { checkQaOutput, QaOutputError, type CheckedQa } from './check.ts';
import { buildQaPrompt, buildQaSystemPrompt, QA_OUTPUT_NAME, QA_PROMPT_VERSION } from './prompt.ts';
import {
  qaInputSchema,
  qaOutputSchema,
  type QaDraft,
  type QaInput,
  type QaRevision,
} from './schema.ts';

// Q&A generation as a reusable function (docs/architecture.md §5, "Buyer Q&A cards (P3-03)"):
// the `qa_cards` step calls it once (revision 0); verification (P3-06) calls it again with the
// previous cards and their flags. Model, effort, token cap, and fallback always come from the
// `qa_writer` step of the run's service definition.

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

/**
 * What a Q&A request is built from: the copy's sources (verified facts, catalog, tone, output
 * language; `loadCopySources`) without the photo context, plus the revision to make.
 */
export type QaSources = Omit<CopySources, 'photos' | 'revision'> & {
  /** Null for the first cards; the cards to fix and their flags for a revision. */
  readonly revision: QaRevision | null;
};

export function buildQaInput(sources: QaSources): QaInput {
  const { market, catalog, outputLanguage } = sources;
  if (!market.output_languages.includes(outputLanguage)) {
    throw new NonRetryableStepError(
      `Output language "${outputLanguage}" is not offered by market ${market.id} v${market.version}`,
    );
  }
  // Checked before any call: answers whose numbers cannot be validated are not worth paying for.
  if (!isClaimLanguage(outputLanguage)) {
    throw new NonRetryableStepError(
      `The claim validator has no number rules for output language "${outputLanguage}"`,
    );
  }
  const name = languageNames.of(outputLanguage);
  if (name === undefined) throw new NonRetryableStepError(`Unknown language "${outputLanguage}"`);
  const tone = sources.tone?.trim() ?? '';
  return qaInputSchema.parse({
    language: { code: outputLanguage, name },
    tone: tone === '' ? null : tone,
    market: {
      id: market.id,
      currency: market.currency ?? null,
      units: { area: market.units.area, volume: market.units.volume ?? null },
      areaBases: market.area_bases.map((basis) => ({ id: basis.id, label: basis.label })),
    },
    facts: catalog.facts.map((fact) => ({
      id: fact.id,
      key: fact.key,
      label: fact.label,
      value: fact.value,
      unit: fact.unit,
      basis: fact.basis,
      presence: fact.presence,
      seenIn: [...fact.seenIn],
    })),
    revision: sources.revision,
  } satisfies QaInput);
}

export interface QaRequest {
  readonly modelId: string;
  readonly reasoningEffort: MetaReasoningEffort;
  readonly maxOutputTokens: number;
  readonly system: string;
  readonly prompt: string;
  readonly catalogIds: readonly string[];
}

export interface QaRequests {
  readonly primary: QaRequest;
  readonly fallback: QaRequest | null;
}

/** The primary request, and the fallback request when the step defines one. */
export function buildQaRequests(
  step: StepConfig<'qa_writer'>,
  market: MarketProfile,
  input: QaInput,
): QaRequests {
  const common = {
    maxOutputTokens: step.max_output_tokens,
    system: buildQaSystemPrompt(market),
    prompt: buildQaPrompt(input),
    catalogIds: input.facts.map((fact) => fact.id),
  };
  const fallback =
    step.fallback_model === undefined || step.fallback_reasoning_effort === undefined
      ? null
      : {
          ...common,
          modelId: step.fallback_model,
          reasoningEffort: step.fallback_reasoning_effort,
        };
  return {
    primary: { ...common, modelId: step.model, reasoningEffort: step.reasoning_effort },
    fallback,
  };
}

export interface QaCallResult {
  readonly output: QaDraft;
  readonly finishReason: string;
  /** The raw response body, only with `includeResponseBody` (tests assert what Meta echoes). */
  readonly responseBody: unknown;
}

/** One strict `json_schema` call; usage is recorded by the clients' call hook. */
export async function callQa(
  clients: MetaClients,
  request: QaRequest,
  options: { readonly signal?: AbortSignal; readonly includeResponseBody?: boolean } = {},
): Promise<QaCallResult> {
  const result = await generateText({
    model: clients.languageModel(request.modelId),
    system: request.system,
    prompt: request.prompt,
    output: Output.object({ schema: qaOutputSchema(request.catalogIds), name: QA_OUTPUT_NAME }),
    maxOutputTokens: request.maxOutputTokens,
    providerOptions: metaProviderOptions({ reasoningEffort: request.reasoningEffort }),
    include: { responseBody: options.includeResponseBody ?? false },
    ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    ...clients.aiSdkCallOptions(),
  });
  return {
    output: result.output,
    finishReason: result.finishReason,
    responseBody: result.response.body,
  };
}

/**
 * The operator-safe class of a failure the model is responsible for (so the fallback may run),
 * or `undefined` for budget, pricing, ledger, abort, and programming errors.
 */
export function qaFailureClass(error: unknown, signal?: AbortSignal): string | undefined {
  if (signal?.aborted === true) return undefined;
  if (error instanceof QaOutputError) return `QaOutputError ${error.problem}`;
  return modelFailureClass(error, signal);
}

/**
 * A truncated answer (`max_output_tokens` reached) cannot be parsed, and a retry at the same cap
 * would pay for the same truncation, so it fails the run. Other errors pass through unchanged.
 */
export function classifyQaError(error: unknown, maxOutputTokens: number): unknown {
  if (NoObjectGeneratedError.isInstance(error) && error.finishReason === 'length') {
    return new NonRetryableStepError(
      `Q&A generation reached max_output_tokens (${maxOutputTokens}) before the answer was complete; raise it in the service definition`,
      { cause: error },
    );
  }
  return error;
}

export interface GeneratedQa {
  readonly qa: CheckedQa;
  readonly modelRun: ReconciliationModelRun;
}

/**
 * Generates and checks one set of cards: the primary model, and on a model failure (an API
 * error, a timeout, an unparseable or truncated answer, or cards that fail the structural
 * check) the definition's fallback once. Every call goes through `meter`.
 */
export async function generateQaCards(
  deps: CopyCallDeps,
  requests: QaRequests,
  catalog: CopyFactCatalog,
  outputLanguage: string,
): Promise<GeneratedQa> {
  const run = async (request: QaRequest): Promise<CheckedQa> => {
    const answer = await deps.meter(request.modelId, () =>
      callQa(deps.clients, request, deps.signal === undefined ? {} : { signal: deps.signal }),
    );
    return checkQaOutput(answer.output, catalog, outputLanguage);
  };
  const settings = (request: QaRequest) => ({
    model: request.modelId,
    reasoningEffort: request.reasoningEffort,
    maxOutputTokens: request.maxOutputTokens,
  });
  const { primary, fallback } = requests;
  try {
    return { qa: await run(primary), modelRun: { ...settings(primary), fallbackFrom: null } };
  } catch (error) {
    const failure = qaFailureClass(error, deps.signal);
    if (fallback === null || failure === undefined) {
      throw classifyQaError(error, primary.maxOutputTokens);
    }
    deps.onFallback?.(failure);
    let qa: CheckedQa;
    try {
      qa = await run(fallback);
    } catch (fallbackError) {
      throw classifyQaError(fallbackError, fallback.maxOutputTokens);
    }
    return {
      qa,
      modelRun: {
        ...settings(fallback),
        fallbackFrom: { model: primary.modelId, reasoningEffort: primary.reasoningEffort, failure },
      },
    };
  }
}

/** The claim validator over the answer segments: `variant: 'qa'`, `segmentIndex` = `index`. */
export function validateQa(
  cards: readonly QaCard[],
  facts: readonly ClaimFact[],
  outputLanguage: string,
): ClaimValidationReport {
  if (!isClaimLanguage(outputLanguage)) {
    throw new NonRetryableStepError(
      `The claim validator has no number rules for output language "${outputLanguage}"`,
    );
  }
  return validateClaims({
    language: outputLanguage,
    segments: cards.flatMap((card) =>
      card.segments.map((segment) => ({
        variant: QA_VARIANT,
        segmentIndex: segment.index,
        text: segment.text,
        factIds: segment.factIds,
      })),
    ),
    facts,
  });
}

/**
 * The `qa_cards` artifact content for checked cards, with the claim validator's report against
 * the verified facts the catalog was built from. Every Q&A artifact (the first cards and each
 * revision) is validated here.
 */
export function buildQaCardsContent(params: {
  readonly generated: GeneratedQa;
  readonly catalog: CopyFactCatalog;
  readonly facts: readonly ClaimFact[];
  readonly input: QaInput;
  readonly revision: number;
  readonly previousArtifactId: string | null;
}): QaCardsContent {
  const { generated, catalog, input } = params;
  const { qa } = generated;
  return qaCardsContentSchema.parse({
    schemaVersion: 1,
    promptVersion: QA_PROMPT_VERSION,
    modelRun: generated.modelRun,
    outputLanguage: input.language.code,
    tone: input.tone,
    revision: params.revision,
    previousArtifactId: params.previousArtifactId,
    catalog: catalog.facts.map((fact) => ({ id: fact.id, factIds: [...fact.factIds] })),
    languageCheck: qa.languageCheck,
    cards: qa.cards,
    repairs: qa.repairs,
    counts: {
      catalogFacts: catalog.facts.length,
      citedCatalogFacts: qa.citedCatalogIds.length,
      cards: qa.cards.length,
      segments: qa.cards.reduce((sum, card) => sum + card.segments.length, 0),
    },
    validation: validateQa(qa.cards, params.facts, input.language.code),
  } satisfies QaCardsContent);
}

/** Stored cards as a revision draft (catalog IDs, the model's own shape). */
export function toQaDraft(content: QaCardsContent): QaDraft {
  return {
    cards: content.cards.map((card) => ({
      question: card.question,
      answer: card.segments.map((segment) => ({
        text: segment.text,
        factIds: [...segment.catalogIds],
      })),
    })),
  };
}

/** Dropped cards in total (the event's `droppedCardCount`). */
export function droppedCardCount(content: Pick<QaCardsContent, 'repairs'>): number {
  return Object.values(content.repairs.droppedCards).reduce((sum, n) => sum + n, 0);
}
