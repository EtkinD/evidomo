import { ApiRequestError } from './api';
import type { Translator } from './i18n';

/** A message for failures every project request can hit, whatever the endpoint. */
export function describeRequestFailure(t: Translator<'apiErrors'>, error: unknown): string {
  // fetch rejects with a TypeError when the request never got a response.
  if (error instanceof TypeError) return t('unreachable');
  if (!(error instanceof ApiRequestError)) return t('generic');
  switch (error.code) {
    case 'unauthenticated':
      return t('sessionEnded');
    case 'not_found':
      return t('projectGone');
    case 'inputs_locked':
      return t('inputsLocked');
    case 'forbidden_origin':
      return t('forbiddenOrigin');
    case 'rate_limited':
      return t('rateLimited');
    default:
      return t('generic');
  }
}
