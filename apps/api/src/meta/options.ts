import type { OpenAILanguageModelResponsesOptions } from '@ai-sdk/openai';
import { z } from 'zod';

/**
 * Reasoning efforts Meta accepts, as listed by the API's own 400 message for `muse-spark-1.3`
 * (`none` is rejected; see docs/model-notes.md, P1-02). Wonder is checked in P1-03.
 */
export const META_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type MetaReasoningEffort = (typeof META_REASONING_EFFORTS)[number];

/** For the definition loader: effort values in service definitions are validated against this. */
export const metaReasoningEffortSchema = z.enum(META_REASONING_EFFORTS);

/** Per-call model settings; the effort comes from the service definition, never a literal. */
export interface MetaCallSettings {
  readonly reasoningEffort: MetaReasoningEffort;
  /**
   * Whether Meta keeps the response server-side. Defaults to `false`: pipeline calls carry
   * customer content and nothing reads stored responses back (no `previous_response_id`).
   */
  readonly store?: boolean;
}

/**
 * AI SDK options for the Responses model. A type alias (not an interface) so it stays assignable
 * to the SDK's JSON-object `providerOptions` record.
 */
export type MetaAiSdkResponsesOptions = {
  readonly forceReasoning: true;
  readonly reasoningEffort: MetaReasoningEffort;
  readonly reasoningSummary: null;
  readonly store: boolean;
};

/**
 * `providerOptions` for an AI SDK call to a Meta Responses model.
 *
 * - The key must be `openai`: `@ai-sdk/openai`'s Responses model reads only `openai` (or `azure`),
 *   whatever the provider `name`. Options under `meta` are dropped silently.
 * - `forceReasoning: true` is required: the SDK only treats `o*`/`gpt-5+` IDs as reasoning
 *   models and otherwise drops `reasoningEffort` with a warning.
 * - `reasoningSummary: null` stops the SDK from adding `summary: "detailed"` whenever an effort is
 *   set; Meta echoes it but returns an empty summary.
 */
export function metaProviderOptions(settings: MetaCallSettings): {
  readonly openai: MetaAiSdkResponsesOptions;
} {
  const openai = {
    forceReasoning: true,
    reasoningEffort: settings.reasoningEffort,
    reasoningSummary: null,
    store: settings.store ?? false,
  } as const satisfies OpenAILanguageModelResponsesOptions;
  return { openai };
}

/** The same settings for an `openai` SDK `responses.create` call (no client-side filtering). */
export function metaResponsesParams(settings: MetaCallSettings): {
  readonly reasoning: { readonly effort: MetaReasoningEffort };
  readonly store: boolean;
} {
  return { reasoning: { effort: settings.reasoningEffort }, store: settings.store ?? false };
}
