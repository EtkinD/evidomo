import { ApiRequestError } from './api';

export const GENERIC_FAILURE = 'Something went wrong on our side. Try again in a moment.';

/** A message for failures every project request can hit, whatever the endpoint. */
export function describeRequestFailure(error: unknown): string {
  // fetch rejects with a TypeError when the request never got a response.
  if (error instanceof TypeError) {
    return 'Could not reach Evidomo. Check your connection and try again.';
  }
  if (!(error instanceof ApiRequestError)) return GENERIC_FAILURE;
  switch (error.code) {
    case 'unauthenticated':
      return 'Your session has ended. Log in again to continue.';
    case 'not_found':
      return 'This project no longer exists.';
    case 'inputs_locked':
      return 'A run has been started, so these inputs can no longer be changed.';
    case 'forbidden_origin':
      return 'The request was blocked because it did not come from this site. Reload the page and try again.';
    case 'rate_limited':
      return 'Too many requests. Wait a moment and try again.';
    default:
      return GENERIC_FAILURE;
  }
}
