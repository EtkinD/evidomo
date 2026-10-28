import {
  listingCopyContentSchema,
  type ListingCopyContent,
  type MarketProfile,
  type MetaReasoningEffort,
  type ReconciliationModelRun,
} from '@evidomo/shared';
import { generateText, NoObjectGeneratedError, Output } from 'ai';
import type { MetaClients } from '../../meta/clients.ts';
import { metaProviderOptions } from '../../meta/options.ts';
import { NonRetryableStepError, type StepConfig, type StepLedger } from '../../runs/steps.ts';
import { modelFailureClass } from '../reconciliation/call.ts';
import type { CopyFactCatalog, CopyPhotoContext } from './catalog.ts';
import { checkCopyOutput, CopyOutputError, type CheckedCopy } from './check.ts';
import {
  buildCopyPrompt,
  buildCopySystemPrompt,
  COPY_OUTPUT_NAME,
  COPY_PROMPT_VERSION,
} from './prompt.ts';
import {
  copyInputSchema,
  copyOutputSchema,
  type CopyDraft,
  type CopyInput,
  type CopyRevision,
} from './schema.ts';

// Copy generation as a reusable function (docs/architecture.md §5 Creative): the creative step
// calls it once (revision 0); verification (P3-06) calls it again with the previous draft and
// its flags, because the run engine completes a step only once. Model, effort, token cap, and
// fallback always come from the `creative` step of the run's service definition.

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

/** Everything a copy request is built from, independent of the run's storage. */
export interface CopySources {
  readonly market: MarketProfile;
  readonly catalog: CopyFactCatalog;
  readonly photos: CopyPhotoContext | null;
  /** The office profile's tone; null for the default (warm, clear, factual). */
  readonly tone: string | null;
  /** ISO 639-1; must be one of the market's output languages. */
  readonly outputLanguage: string;
  /** Null for a first draft; the draft to fix and its flags for a revision. */
  readonly revision: CopyRevision | null;
}

export function buildCopyInput(sources: CopySources): CopyInput {
  const { market, catalog, photos, outputLanguage } = sources;
  if (!market.output_languages.includes(outputLanguage)) {
    throw new NonRetryableStepError(
      `Output language "${outputLanguage}" is not offered by market ${market.id} v${market.version}`,
    );
  }
  const name = languageNames.of(outputLanguage);
  if (name === undefined) throw new NonRetryableStepError(`Unknown language "${outputLanguage}"`);
  const tone = sources.tone?.trim() ?? '';
  return copyInputSchema.parse({
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
    photos: photos === null ? null : { cover: photos.cover, rooms: [...photos.rooms] },
    revision: sources.revision,
  } satisfies CopyInput);
}

export interface CopyRequest {
  readonly modelId: string;
  readonly reasoningEffort: MetaReasoningEffort;
  readonly maxOutputTokens: number;
  readonly system: string;
  readonly prompt: string;
  /** The catalog IDs the output schema allows. */
  readonly catalogIds: readonly string[];
}

export interface CopyRequests {
  readonly primary: CopyRequest;
  readonly fallback: CopyRequest | null;
}

/** The primary request, and the fallback request when the step defines one. */
export function buildCopyRequests(
  step: StepConfig<'creative'>,
  market: MarketProfile,
  input: CopyInput,
): CopyRequests {
  const common = {
    maxOutputTokens: step.max_output_tokens,
    system: buildCopySystemPrompt(market),
    prompt: buildCopyPrompt(input),
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

export interface CopyCallResult {
  readonly output: CopyDraft;
  readonly finishReason: string;
  /** The raw response body, only with `includeResponseBody` (tests assert what Meta echoes). */
  readonly responseBody: unknown;
}

/** One strict `json_schema` call; usage is recorded by the clients' call hook. */
export async function callCopy(
  clients: MetaClients,
  request: CopyRequest,
  options: { readonly signal?: AbortSignal; readonly includeResponseBody?: boolean } = {},
): Promise<CopyCallResult> {
  const result = await generateText({
    model: clients.languageModel(request.modelId),
    system: request.system,
    prompt: request.prompt,
    output: Output.object({
      schema: copyOutputSchema(request.catalogIds),
      name: COPY_OUTPUT_NAME,
    }),
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
export function copyFailureClass(error: unknown, signal?: AbortSignal): string | undefined {
  if (signal?.aborted === true) return undefined;
  if (error instanceof CopyOutputError) return `CopyOutputError ${error.problem}`;
  return modelFailureClass(error, signal);
}

/**
 * A truncated answer (`max_output_tokens` reached) cannot be parsed, and a retry at the same cap
 * would pay for the same truncation, so it fails the run. Other errors pass through unchanged
 * (the engine retries transient ones, including `CopyOutputError`, once).
 */
export function classifyCopyError(error: unknown, maxOutputTokens: number): unknown {
  if (NoObjectGeneratedError.isInstance(error) && error.finishReason === 'length') {
    return new NonRetryableStepError(
      `Copy generation reached max_output_tokens (${maxOutputTokens}) before the answer was complete; raise it in the service definition`,
      { cause: error },
    );
  }
  return error;
}

export interface GeneratedCopy {
  readonly copy: CheckedCopy;
  readonly modelRun: ReconciliationModelRun;
}

export interface CopyCallDeps {
  readonly clients: MetaClients;
  readonly meter: StepLedger['meter'];
  readonly signal?: AbortSignal;
  /** Told about a fallback (class name only), for the step log. */
  readonly onFallback?: (failure: string) => void;
}

/**
 * Generates and checks one draft: the primary model, and on a model failure (an API error, a
 * timeout, an unparseable or truncated answer, or copy that fails the structural check) the
 * definition's fallback once. Every call goes through `meter`, so the ledger records each
 * billed call. Returns copy whose segments cite stored fact IDs.
 */
export async function generateListingCopy(
  deps: CopyCallDeps,
  requests: CopyRequests,
  catalog: CopyFactCatalog,
  outputLanguage: string,
): Promise<GeneratedCopy> {
  const run = async (request: CopyRequest): Promise<CheckedCopy> => {
    const answer = await deps.meter(request.modelId, () =>
      callCopy(deps.clients, request, deps.signal === undefined ? {} : { signal: deps.signal }),
    );
    return checkCopyOutput(answer.output, catalog, outputLanguage);
  };
  const settings = (request: CopyRequest) => ({
    model: request.modelId,
    reasoningEffort: request.reasoningEffort,
    maxOutputTokens: request.maxOutputTokens,
  });
  const { primary, fallback } = requests;
  try {
    return { copy: await run(primary), modelRun: { ...settings(primary), fallbackFrom: null } };
  } catch (error) {
    const failure = copyFailureClass(error, deps.signal);
    if (fallback === null || failure === undefined) {
      throw classifyCopyError(error, primary.maxOutputTokens);
    }
    deps.onFallback?.(failure);
    let copy: CheckedCopy;
    try {
      copy = await run(fallback);
    } catch (fallbackError) {
      throw classifyCopyError(fallbackError, fallback.maxOutputTokens);
    }
    return {
      copy,
      modelRun: {
        ...settings(fallback),
        fallbackFrom: {
          model: primary.modelId,
          reasoningEffort: primary.reasoningEffort,
          failure,
        },
      },
    };
  }
}

/** The `listing_copy` artifact content for a checked draft. */
export function buildListingCopyContent(params: {
  readonly generated: GeneratedCopy;
  readonly catalog: CopyFactCatalog;
  readonly input: CopyInput;
  readonly revision: number;
  readonly previousArtifactId: string | null;
}): ListingCopyContent {
  const { generated, catalog, input } = params;
  const { copy } = generated;
  return listingCopyContentSchema.parse({
    schemaVersion: 1,
    promptVersion: COPY_PROMPT_VERSION,
    modelRun: generated.modelRun,
    outputLanguage: input.language.code,
    tone: input.tone,
    revision: params.revision,
    previousArtifactId: params.previousArtifactId,
    catalog: catalog.facts.map((fact) => ({ id: fact.id, factIds: [...fact.factIds] })),
    variants: copy.variants,
    repairs: copy.repairs,
    counts: {
      catalogFacts: catalog.facts.length,
      citedCatalogFacts: copy.citedCatalogIds.length,
      segments: copy.variants.reduce((sum, variant) => sum + variant.segments.length, 0),
    },
  } satisfies ListingCopyContent);
}

/**
 * A stored copy artifact as a revision draft (catalog IDs, the model's own shape), for the
 * revision loop. Catalog IDs are content-derived, so they stay valid while the verified facts
 * are unchanged; the caller rebuilds the catalog and must use the same one.
 */
export function toCopyDraft(content: ListingCopyContent): CopyDraft {
  const segmentsOf = (kind: 'portal' | 'social') =>
    content.variants.find((variant) => variant.kind === kind)?.segments ?? [];
  const model = (segment: { text: string; catalogIds: string[] }) => ({
    text: segment.text,
    factIds: [...segment.catalogIds],
  });
  const paragraphs: CopyDraft['portal']['paragraphs'] = [];
  for (const segment of segmentsOf('portal')) {
    const paragraph = (paragraphs[segment.paragraph] ??= { segments: [] });
    paragraph.segments.push(model(segment));
  }
  return { portal: { paragraphs }, social: { segments: segmentsOf('social').map(model) } };
}
