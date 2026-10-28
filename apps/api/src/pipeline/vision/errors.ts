import type { PhotoFailureReason } from '@evidomo/shared';
import { APICallError, NoObjectGeneratedError } from 'ai';
import { SamMaskError } from '../../meta/sam-mask.ts';
import { SamOutputError } from '../../meta/sam-output.ts';
import { SamResponseError } from '../../meta/sam.ts';
import { ClassificationValueError } from './normalize.ts';

// Which model-call errors belong to one photo rather than to the step. A photo failure is stored
// on the photo (its classification or privacy check is marked failed) and the step goes on: the
// same input would fail the same way on a step retry, which would re-pay every other photo.
// Everything else propagates to the run engine, which retries transient errors (rate limits and
// 5xx after the SDK's own retries, timeouts, network) once and fails the run on budget, pricing,
// and abort errors. There is no retry layer here (SDK retries are the only one).

/** Client errors that describe this request's input (e.g. an image the API refuses). */
const INPUT_REJECTION_STATUSES = new Set([400, 413, 415, 422]);

export function photoFailureReason(error: unknown): PhotoFailureReason | undefined {
  if (NoObjectGeneratedError.isInstance(error)) {
    return error.finishReason === 'length' ? 'output_truncated' : 'invalid_output';
  }
  if (
    error instanceof ClassificationValueError ||
    error instanceof SamOutputError ||
    error instanceof SamMaskError
  ) {
    return 'invalid_output';
  }
  // A response without usage.images_processed also throws this, but its unpriced ledger entry
  // still fails the run with UnpricedUsageError when the call's usage is flushed.
  if (error instanceof SamResponseError) return 'incomplete_response';
  if (
    APICallError.isInstance(error) &&
    !error.isRetryable &&
    error.statusCode !== undefined &&
    INPUT_REJECTION_STATUSES.has(error.statusCode)
  ) {
    return 'rejected_input';
  }
  return undefined;
}

export type PhotoOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: PhotoFailureReason };

/** Runs one photo's call; photo-level failures become an outcome, anything else is rethrown. */
export async function photoOutcome<T>(call: () => Promise<T>): Promise<PhotoOutcome<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    const reason = photoFailureReason(error);
    if (reason === undefined) throw error;
    return { ok: false, reason };
  }
}
