import { ApiRequestError } from './api';
import type { Translator } from './i18n';

const STORAGE_KEY = 'evidomo.liveRunAccessCode';

/**
 * The code is kept for this browser session only (`sessionStorage`, never `localStorage`): it
 * unlocks metered model calls, so it must not outlive the tab. Storage can be unavailable
 * (privacy modes, quota, blocked cookies); the field then simply starts empty every time.
 */
export function readStoredAccessCode(): string {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function storeAccessCode(code: string): void {
  try {
    if (code === '') window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Remembering the code is a convenience; failing to do so must not block starting a run.
  }
}

/** "5 minutes", "about 3 hours": a wait the user can plan around, rounded up to a unit. */
export function humanizeWait(t: Translator<'readiness'>, seconds: number): string {
  if (seconds < 90) return t('wait.minute');
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return t('wait.minutes', { count: minutes });
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return t('wait.hours', { count: hours });
  const days = Math.ceil(hours / 24);
  return t('wait.days', { count: days });
}

/** The access-code and limit failures of `POST /api/projects/:id/runs` (P4-10). */
export type AccessFailure =
  | { kind: 'code_invalid' }
  | { kind: 'code_rate_limited' }
  | { kind: 'run_limit'; retryAfterSeconds: number | null };

export function describeAccessFailure(error: unknown): AccessFailure | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code === 'access_code_invalid') return { kind: 'code_invalid' };
  if (error.code === 'rate_limited') return { kind: 'code_rate_limited' };
  if (error.code === 'run_limit_reached') {
    return { kind: 'run_limit', retryAfterSeconds: error.retryAfterSeconds };
  }
  return null;
}
