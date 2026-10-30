import type { MetaReasoningEffort, ReconciliationModelRun } from '@evidomo/shared';
import { APICallError, generateText, NoObjectGeneratedError, Output, RetryError } from 'ai';
import type { MetaClients } from '../../meta/clients.ts';
import { metaProviderOptions } from '../../meta/options.ts';
import { isReplayMiss } from '../../meta/service-errors.ts';
import { NonRetryableStepError, type StepConfig, type StepLedger } from '../../runs/steps.ts';
import type { ReconciliationInput } from './schema.ts';
import { reconciliationStepOutputSchema, type ReconciliationStepOutput } from './schema.ts';
import {
  buildReconciliationStepPrompt,
  RECONCILIATION_OUTPUT_NAME,
  RECONCILIATION_STEP_SYSTEM_PROMPT,
} from './step-prompt.ts';

// The reconciliation model call with the definition's fallback (docs/architecture.md §5 step 4,
// §9). Model, effort, token cap, and fallback all come from the step configuration. The fallback
// runs once, when the primary call fails in a way the primary model is responsible for: an API
// error (non-retryable, or retryable after the SDK's own retries), a timeout, or an answer that
// does not parse. Budget, pricing, ledger, and abort errors never trigger it: the fallback would
// fail the same way, or the step is being stopped.

export interface ReconciliationRequest {
  readonly modelId: string;
  readonly reasoningEffort: MetaReasoningEffort;
  readonly maxOutputTokens: number;
  readonly system: string;
  readonly prompt: string;
}

/** The primary request, and the fallback request when the step defines one. */
export function buildReconciliationRequests(
  step: StepConfig<'reconciler'>,
  input: ReconciliationInput,
): { primary: ReconciliationRequest; fallback: ReconciliationRequest | null } {
  const common = {
    maxOutputTokens: step.max_output_tokens,
    system: RECONCILIATION_STEP_SYSTEM_PROMPT,
    prompt: buildReconciliationStepPrompt(input),
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

export interface ReconciliationCallResult {
  readonly output: ReconciliationStepOutput;
  readonly finishReason: string;
  /** The raw response body, only with `includeResponseBody` (tests assert what Meta echoes). */
  readonly responseBody: unknown;
}

/** One strict `json_schema` call; usage is recorded by the clients' call hook. */
export async function callReconciliation(
  clients: MetaClients,
  request: ReconciliationRequest,
  options: { readonly signal?: AbortSignal; readonly includeResponseBody?: boolean } = {},
): Promise<ReconciliationCallResult> {
  const result = await generateText({
    model: clients.languageModel(request.modelId),
    system: request.system,
    prompt: request.prompt,
    output: Output.object({
      schema: reconciliationStepOutputSchema,
      name: RECONCILIATION_OUTPUT_NAME,
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
 * The operator-safe class of a model failure, or `undefined` when the failure is not the
 * model's (budget, pricing, ledger, abort, programming errors), so no fallback may run. Never
 * an SDK message: those can carry request bodies.
 */
export function modelFailureClass(error: unknown, signal?: AbortSignal): string | undefined {
  if (signal?.aborted === true) return undefined;
  // The development replay has no recording: the fallback (or a revision loop that would end
  // as `revision_failed`) has none either, and the step must fail with that reason.
  if (isReplayMiss(error)) return undefined;
  if (RetryError.isInstance(error)) {
    // `abort` means the caller's signal, which is never the model's fault.
    if (error.reason === 'abort') return undefined;
    const last = modelFailureClass(error.lastError, signal);
    return last === undefined ? undefined : `RetryError ${error.reason}: ${last}`;
  }
  if (APICallError.isInstance(error)) {
    return `APICallError ${error.statusCode ?? 'network'}`;
  }
  if (NoObjectGeneratedError.isInstance(error)) {
    return `NoObjectGeneratedError ${error.finishReason ?? 'unknown'}`;
  }
  // The AI SDK's own `timeout` aborts the call with a TimeoutError (the step signal is not set).
  if (error instanceof Error && error.name === 'TimeoutError') return 'TimeoutError';
  return undefined;
}

/**
 * A truncated answer (`max_output_tokens` reached) cannot be parsed, and the engine's retry at
 * the same cap would pay for the same truncation, so it fails the run. Other errors pass through
 * unchanged (the engine retries transient ones once).
 */
export function classifyReconciliationError(error: unknown, maxOutputTokens: number): unknown {
  if (NoObjectGeneratedError.isInstance(error) && error.finishReason === 'length') {
    return new NonRetryableStepError(
      `Reconciliation reached max_output_tokens (${maxOutputTokens}) before the answer was complete; raise it in the service definition`,
      { cause: error },
    );
  }
  return error;
}

export interface ReconciliationAnswer {
  readonly output: ReconciliationStepOutput;
  readonly modelRun: ReconciliationModelRun;
}

export interface ReconciliationCallDeps {
  readonly clients: MetaClients;
  readonly meter: StepLedger['meter'];
  readonly signal?: AbortSignal;
  /** Told about a fallback (class name only), for the step log. */
  readonly onFallback?: (failure: string) => void;
}

/**
 * Runs the primary model and, if it fails with a model failure, the fallback once. Each call
 * goes through `meter`, so the ledger records both when the primary call was billed (an
 * unparseable or truncated answer is billed; an HTTP error without usage is not).
 */
export async function reconcileWithFallback(
  deps: ReconciliationCallDeps,
  requests: { primary: ReconciliationRequest; fallback: ReconciliationRequest | null },
): Promise<ReconciliationAnswer> {
  const run = async (request: ReconciliationRequest) =>
    deps.meter(request.modelId, () =>
      callReconciliation(deps.clients, request, {
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      }),
    );
  const { primary, fallback } = requests;
  try {
    const answer = await run(primary);
    return {
      output: answer.output,
      modelRun: {
        model: primary.modelId,
        reasoningEffort: primary.reasoningEffort,
        maxOutputTokens: primary.maxOutputTokens,
        fallbackFrom: null,
      },
    };
  } catch (error) {
    const failure = modelFailureClass(error, deps.signal);
    if (fallback === null || failure === undefined) {
      throw classifyReconciliationError(error, primary.maxOutputTokens);
    }
    deps.onFallback?.(failure);
    let answer: ReconciliationCallResult;
    try {
      answer = await run(fallback);
    } catch (fallbackError) {
      throw classifyReconciliationError(fallbackError, fallback.maxOutputTokens);
    }
    return {
      output: answer.output,
      modelRun: {
        model: fallback.modelId,
        reasoningEffort: fallback.reasoningEffort,
        maxOutputTokens: fallback.maxOutputTokens,
        fallbackFrom: {
          model: primary.modelId,
          reasoningEffort: primary.reasoningEffort,
          failure,
        },
      },
    };
  }
}
