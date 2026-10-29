import { ApiRequestError } from './api';

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
export function humanizeWait(seconds: number): string {
  if (seconds < 90) return 'a minute';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return hours === 1 ? 'about an hour' : `about ${hours} hours`;
  const days = Math.ceil(hours / 24);
  return days === 1 ? 'about a day' : `about ${days} days`;
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
