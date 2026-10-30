import { APICallError, RetryError } from 'ai';
import { APIError } from 'openai';

// What the run engine and the steps may read from a failed model call, for both SDKs: the HTTP
// status and whether the development replay had no recording for the request. Never an SDK
// message or response body: those can carry request content.

/**
 * Set by the development replay (`replay.ts`) on its 404 for a request the cassette does not
 * hold. Production never sees it: the live API does not send this header.
 */
export const REPLAY_MISS_HEADER = 'x-evidomo-replay';
export const REPLAY_MISS_VALUE = 'no-recording';

/** How deep `cause` / `lastError` chains are followed (wrappers nest one or two levels). */
const MAX_DEPTH = 5;

/** The innermost model-service HTTP error of `error`: itself, a RetryError's last, or a cause. */
function findServiceError(error: unknown, depth = 0): APICallError | APIError | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (APICallError.isInstance(error)) return error;
  if (error instanceof APIError) return error;
  if (RetryError.isInstance(error)) return findServiceError(error.lastError, depth + 1);
  if (error instanceof Error && error.cause !== undefined) {
    return findServiceError(error.cause, depth + 1);
  }
  return undefined;
}

/** The HTTP status of the model-service response behind `error`; undefined for anything else. */
export function modelServiceStatus(error: unknown): number | undefined {
  const found = findServiceError(error);
  if (found === undefined) return undefined;
  if (APICallError.isInstance(found)) return found.statusCode;
  // `instanceof` narrows the generic class to `APIError<any>`; read the status as unknown.
  const status: unknown = found.status;
  return typeof status === 'number' ? status : undefined;
}

/** True when the development replay answered the request with "no recording". */
export function isReplayMiss(error: unknown): boolean {
  const found = findServiceError(error);
  if (found === undefined) return false;
  if (APICallError.isInstance(found)) {
    return found.responseHeaders?.[REPLAY_MISS_HEADER] === REPLAY_MISS_VALUE;
  }
  const headers: unknown = found.headers;
  return headers instanceof Headers && headers.get(REPLAY_MISS_HEADER) === REPLAY_MISS_VALUE;
}

/**
 * Statuses a later attempt can succeed on: timeout, conflict, rate limit, server errors. Any
 * other 4xx (bad request, auth, not found, unprocessable) fails the same way again.
 */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
