import Link from 'next/link';
import type { ReactNode } from 'react';
import { useLogout, useMe } from '../lib/auth';

function AccountControls() {
  const me = useMe();
  const logout = useLogout();

  // Nothing while the session check runs, so the header does not flash the wrong controls.
  if (me.isPending) return null;

  if (me.data) {
    return (
      <div className="flex items-center gap-2">
        <Link href="/projects" className="btn btn-ghost btn-sm">
          Projects
        </Link>
        <span className="hidden max-w-48 truncate text-sm text-base-content/70 sm:inline">
          {me.data.email}
        </span>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          disabled={logout.isPending}
          onClick={() => logout.mutate()}
        >
          {logout.isPending && <span className="loading loading-spinner loading-xs" aria-hidden />}
          Log out
        </button>
        {logout.isError && (
          <span role="alert" className="text-sm text-error">
            Could not log out. Try again.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Link href="/login" className="btn btn-ghost btn-sm">
        Log in
      </Link>
      <Link href="/register" className="btn btn-primary btn-sm">
        Create account
      </Link>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="navbar border-b border-base-300 bg-base-100 px-4">
        <div className="navbar-start">
          <Link href="/" className="text-lg font-bold">
            Evidomo
          </Link>
        </div>
        <nav aria-label="Account" className="navbar-end">
          <AccountControls />
        </nav>
      </header>
      {children}
    </div>
  );
}
