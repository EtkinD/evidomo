import type { ClaimAuditCategory, MetaReasoningEffort } from '@evidomo/shared';
import { generateText, NoObjectGeneratedError, Output } from 'ai';
import type { MetaClients } from '../../meta/clients.ts';
import { metaProviderOptions } from '../../meta/options.ts';
import { NonRetryableStepError, type StepConfig, type StepLedger } from '../../runs/steps.ts';
import { modelFailureClass } from '../reconciliation/call.ts';
import type { VerificationRequestInput, VerifierAnswer } from './audit.ts';
import { claimAuditOutputSchema, type ModelAuditOutput } from './step-schema.ts';
import {
  buildVerificationStepPrompt,
  VERIFICATION_OUTPUT_NAME,
  VERIFICATION_STEP_SYSTEM_PROMPT,
} from './step-prompt.ts';

// The verifier call with the definition's fallback (docs/architecture.md §5 step 8, §9), the
// same policy as reconciliation: the fallback runs once when the primary call fails in a way the
// primary model is responsible for (an API error after the SDK's retries, a timeout, an answer
// that does not parse); budget, pricing, ledger, and abort errors never trigger it. Model,
// effort, token cap, and fallback come from the `verifier` step of the service definition.

export interface VerificationRequest {
  readonly modelId: string;
  readonly reasoningEffort: MetaReasoningEffort;
  readonly maxOutputTokens: number;
  readonly system: string;
  readonly prompt: string;
  readonly segmentIds: readonly string[];
  readonly categories: readonly ClaimAuditCategory[];
}

export interface VerificationRequests {
  readonly primary: VerificationRequest;
  readonly fallback: VerificationRequest | null;
}

export function buildVerificationRequests(
  step: StepConfig<'verifier'>,
  request: Pick<VerificationRequestInput, 'input' | 'auditIds' | 'categories'>,
): VerificationRequests {
  const common = {
    maxOutputTokens: step.max_output_tokens,
    system: VERIFICATION_STEP_SYSTEM_PROMPT,
    prompt: buildVerificationStepPrompt(request.input),
    segmentIds: request.auditIds,
    categories: request.categories,
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

export interface VerificationCallResult {
  readonly output: ModelAuditOutput;
  readonly finishReason: string;
  /** The raw response body, only with `includeResponseBody` (tests assert what Meta echoes). */
  readonly responseBody: unknown;
}

/** One strict `json_schema` call; usage is recorded by the clients' call hook. */
export async function callVerification(
  clients: MetaClients,
  request: VerificationRequest,
  options: { readonly signal?: AbortSignal; readonly includeResponseBody?: boolean } = {},
): Promise<VerificationCallResult> {
  const result = await generateText({
    model: clients.languageModel(request.modelId),
    system: request.system,
    prompt: request.prompt,
    output: Output.object({
      schema: claimAuditOutputSchema(request.segmentIds, request.categories),
      name: VERIFICATION_OUTPUT_NAME,
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
 * A truncated answer cannot be parsed and a retry at the same cap would pay for the same
 * truncation, so it fails the run. Other errors pass through (the engine retries once).
 */
export function classifyVerificationError(error: unknown, maxOutputTokens: number): unknown {
  if (NoObjectGeneratedError.isInstance(error) && error.finishReason === 'length') {
    return new NonRetryableStepError(
      `Verification reached max_output_tokens (${maxOutputTokens}) before the answer was complete; raise it in the service definition`,
      { cause: error },
    );
  }
  return error;
}

export interface VerificationCallDeps {
  readonly clients: MetaClients;
  readonly meter: StepLedger['meter'];
  readonly signal?: AbortSignal;
  /** Told about a fallback (class name only), for the step log. */
  readonly onFallback?: (failure: string) => void;
}

/** The primary model, and on a model failure the fallback once; every call is metered. */
export async function verifyWithFallback(
  deps: VerificationCallDeps,
  requests: VerificationRequests,
): Promise<VerifierAnswer> {
  const run = (request: VerificationRequest) =>
    deps.meter(request.modelId, () =>
      callVerification(
        deps.clients,
        request,
        deps.signal === undefined ? {} : { signal: deps.signal },
      ),
    );
  const settings = (request: VerificationRequest) => ({
    model: request.modelId,
    reasoningEffort: request.reasoningEffort,
    maxOutputTokens: request.maxOutputTokens,
  });
  const { primary, fallback } = requests;
  try {
    const answer = await run(primary);
    return { output: answer.output, modelRun: { ...settings(primary), fallbackFrom: null } };
  } catch (error) {
    const failure = modelFailureClass(error, deps.signal);
    if (fallback === null || failure === undefined) {
      throw classifyVerificationError(error, primary.maxOutputTokens);
    }
    deps.onFallback?.(failure);
    let answer: VerificationCallResult;
    try {
      answer = await run(fallback);
    } catch (fallbackError) {
      throw classifyVerificationError(fallbackError, fallback.maxOutputTokens);
    }
    return {
      output: answer.output,
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
