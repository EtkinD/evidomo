export const DEFAULT_AFTER_AUTH_PATH = '/';

const MAX_NEXT_LENGTH = 2048;
// Probe origin for resolving a candidate; any result on another origin is rejected.
const PROBE_ORIGIN = 'http://next-path.invalid';
const AUTH_PAGES = new Set(['/login', '/register']);

/**
 * The `next` query value to redirect to after login or registration, or the default.
 *
 * Only a same-origin relative path is accepted, to prevent an open redirect: it must start with
 * a single `/`. Backslashes and control or whitespace characters are refused outright, because
 * browsers rewrite `\` to `/` and strip tabs and newlines, which turns `/\evil.example` or
 * `/<TAB>/evil.example` into the protocol-relative `//evil.example`. The URL parser then
 * confirms the result stays on this origin. The auth pages themselves are refused so a
 * redirect never loops.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_AFTER_AUTH_PATH;
  if (value.length === 0 || value.length > MAX_NEXT_LENGTH) return DEFAULT_AFTER_AUTH_PATH;
  if (!value.startsWith('/') || value.startsWith('//')) return DEFAULT_AFTER_AUTH_PATH;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\\\u0000- \u007f]/.test(value)) return DEFAULT_AFTER_AUTH_PATH;

  const url = URL.parse(value, PROBE_ORIGIN);
  if (url === null || url.origin !== PROBE_ORIGIN) return DEFAULT_AFTER_AUTH_PATH;
  if (AUTH_PAGES.has(url.pathname)) return DEFAULT_AFTER_AUTH_PATH;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** An auth page URL that carries a validated `next` over (omitted when it is the default). */
export function withNext(pathname: string, next: string): string {
  return next === DEFAULT_AFTER_AUTH_PATH
    ? pathname
    : `${pathname}?next=${encodeURIComponent(next)}`;
}
