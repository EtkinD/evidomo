import { useRouter } from 'next/router';
import { useEffect, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { useMe } from '../lib/auth';
import { safeNextPath, withNext } from '../lib/next-path';
import type { PageAuth } from '../lib/page-auth';

function SessionCheck() {
  const t = useTranslations('auth');
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div role="status" className="flex items-center gap-3 text-base-content/70">
        <span className="loading loading-spinner" aria-hidden="true" />
        <span>{t('checkingSession')}</span>
      </div>
    </main>
  );
}

/**
 * Renders `children` only for a signed-in user; anyone else is sent to the login page with
 * `next` set to the current path.
 *
 * This is client-side gating for the user experience only. The protected content comes from
 * the API, and the API's `requireUser` middleware is what actually enforces authentication.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const t = useTranslations('auth');
  const tc = useTranslations('common');
  const router = useRouter();
  const me = useMe();
  const signedOut = me.isSuccess && me.data === null;

  useEffect(() => {
    // `asPath` is only reliable once the router is ready (static pages hydrate without it).
    if (signedOut && router.isReady) {
      void router.replace(withNext('/login', router.asPath));
    }
  }, [signedOut, router]);

  if (me.isSuccess && me.data !== null) return children;
  if (me.isError) {
    return (
      <main className="flex flex-1 items-center justify-center p-4">
        <div role="alert" className="alert alert-error max-w-md">
          <span>{t('sessionCheckFailed')}</span>
          <button type="button" className="btn min-h-11" onClick={() => void me.refetch()}>
            {tc('tryAgain')}
          </button>
        </div>
      </main>
    );
  }
  // Loading, or signed out and about to redirect: never the protected content.
  return <SessionCheck />;
}

/**
 * For the login and register pages: a signed-in user goes to the validated `next` path. This
 * also completes a successful login or registration, whose mutation puts the user into the
 * `me` cache.
 */
export function GuestOnly({ children }: { children: ReactNode }) {
  const router = useRouter();
  const me = useMe();
  const signedIn = me.isSuccess && me.data !== null;

  useEffect(() => {
    if (signedIn && router.isReady) {
      void router.replace(safeNextPath(router.query['next']));
    }
  }, [signedIn, router]);

  // A failed session check still shows the form; submitting it reports its own errors.
  if (me.isPending || signedIn) return <SessionCheck />;
  return children;
}

export function AuthGate({ mode, children }: { mode: PageAuth | undefined; children: ReactNode }) {
  switch (mode) {
    case 'required':
      return <RequireAuth>{children}</RequireAuth>;
    case 'guest':
      return <GuestOnly>{children}</GuestOnly>;
    case undefined:
      return children;
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
}
