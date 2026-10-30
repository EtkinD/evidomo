import Link from 'next/link';
import { useId } from 'react';
import { ChosenLockup } from '../../combo/logos';
import { ComboShell, Sample } from '../../combo/parts';

function LoginCard() {
  const email = useId();
  const password = useId();
  return (
    <main className="flex items-start justify-center bg-base-200 px-4 py-10 sm:items-center sm:py-16">
      <div className="card w-full max-w-sm border border-base-300 bg-base-100 shadow-sm">
        <form className="card-body gap-5" noValidate onSubmit={(event) => event.preventDefault()}>
          <div className="flex flex-col items-center gap-2 text-center">
            <ChosenLockup markClass="size-12" textClass="text-3xl" />
            <h2 className="card-title text-2xl">Log in</h2>
            <p className="text-sm text-base-content/70">Back to your listing packs.</p>
          </div>
          <fieldset className="fieldset">
            <label htmlFor={email} className="fieldset-legend">
              Email
            </label>
            <input
              id={email}
              type="email"
              className="input min-h-11 w-full"
              autoComplete="email"
              defaultValue="agent@example.test"
            />
          </fieldset>
          <fieldset className="fieldset">
            <label htmlFor={password} className="fieldset-legend">
              Password
            </label>
            <input
              id={password}
              type="password"
              className="input min-h-11 w-full"
              autoComplete="current-password"
            />
          </fieldset>
          <button type="submit" className="btn btn-primary min-h-11 w-full">
            Log in
          </button>
          <p className="text-center text-sm">
            New here?{' '}
            <Link href="/showcase/combo/auth" className="link inline-flex min-h-11 items-center">
              Create an account
            </Link>
          </p>
        </form>
      </div>
    </main>
  );
}

export function ComboAuthPage() {
  return (
    <ComboShell title="Combination: log in">
      <Sample id="H-AUTH-1" title="Log in card with the logo">
        <LoginCard />
      </Sample>
    </ComboShell>
  );
}
