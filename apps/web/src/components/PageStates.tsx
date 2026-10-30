import Link from 'next/link';
import { useRouter } from 'next/router';
import { ApiRequestError } from '../lib/api';
import { withNext } from '../lib/next-path';

/**
 * Loading placeholder: a status line with text plus quiet skeleton cards of about the final
 * height, so the page does not jump when the content arrives. The skeletons are hidden from
 * assistive technology; the status line carries the meaning.
 */
export function LoadingBlock({ label, cards = 2 }: { label: string; cards?: number }) {
  return (
    <div role="status" className="flex flex-col gap-4">
      <div className="flex items-center gap-3 text-base-content/70">
        <span className="loading loading-spinner" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div aria-hidden="true" className="flex flex-col gap-4">
        {Array.from({ length: cards }, (_, index) => (
          <div key={index} className="skeleton h-28 w-full rounded-box" />
        ))}
      </div>
    </div>
  );
}

/**
 * A failed load. A 401 means the session ended, which a retry cannot fix: it offers the log-in
 * page and returns here afterwards. Anything else offers a retry (when the caller has one).
 */
export function LoadError({
  error,
  message,
  onRetry,
}: {
  error: unknown;
  message: string;
  onRetry?: () => void;
}) {
  const router = useRouter();
  if (error instanceof ApiRequestError && error.status === 401) {
    return (
      <div role="alert" className="alert alert-warning">
        <span>Your session has ended. Log in again to continue.</span>
        <Link href={withNext('/login', router.asPath)} className="btn min-h-11">
          Log in
        </Link>
      </div>
    );
  }
  return (
    <div role="alert" className="alert alert-error">
      <span>{message}</span>
      {onRetry !== undefined && (
        <button type="button" className="btn min-h-11" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
