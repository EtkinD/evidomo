import type { NextPage } from 'next';

/**
 * Per-page access mode, read by `_app`:
 * - `required`: signed-in users only; others are sent to the login page.
 * - `guest`: signed-out users only (login, register); signed-in users go to `next`.
 * - absent: public (landing page, and later the public demo replay).
 */
export type PageAuth = 'required' | 'guest';

/**
 * `bare` pages render without the product shell and auth gate. Only the dev-only design
 * showcase uses it.
 */
export type NextPageWithAuth<P = object> = NextPage<P> & { auth?: PageAuth; bare?: boolean };
