import type { MarketForm, ProjectDetailResponse } from '@evidomo/shared';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useId, useRef, useState, useSyncExternalStore } from 'react';
import {
  describeAccessFailure,
  humanizeWait,
  readStoredAccessCode,
  storeAccessCode,
  type AccessFailure,
} from '../lib/access-code';
import { ApiRequestError } from '../lib/api';
import { readinessMessage } from '../lib/project-view';
import { useStartRun } from '../lib/projects';
import { describeRequestFailure } from '../lib/request-failure';
import { Field } from './FormField';
import { RunStatusBadge } from './RunStatusBadge';

const subscribeNever = (): (() => void) => () => undefined;

type StartFailure =
  | AccessFailure
  | { kind: 'not_ready' }
  | { kind: 'run_active' }
  | { kind: 'budget' }
  | { kind: 'message'; message: string };

function describeStartFailure(error: unknown): StartFailure {
  const access = describeAccessFailure(error);
  if (access !== null) return access;
  if (error instanceof ApiRequestError) {
    if (error.code === 'not_ready') return { kind: 'not_ready' };
    if (error.code === 'run_active') return { kind: 'run_active' };
    if (error.code === 'daily_budget_reached') return { kind: 'budget' };
  }
  return { kind: 'message', message: describeRequestFailure(error) };
}

interface ReadinessPanelProps {
  detail: ProjectDetailResponse;
  market: MarketForm | undefined;
  /** Facts or office profile have edits that are not saved: a run would start on the old values. */
  hasUnsavedChanges: boolean;
}

/** What is still needed before a run, and the one action that starts it. */
export function ReadinessPanel({ detail, market, hasUnsavedChanges }: ReadinessPanelProps) {
  const router = useRouter();
  const { project, readiness, latestRun } = detail;
  const mutation = useStartRun(project.id);
  const [failure, setFailure] = useState<StartFailure | null>(null);
  // A ref: two clicks in the same tick both see the mutation as idle.
  const starting = useRef(false);
  const codeId = useId();
  const [typedCode, setTypedCode] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  // The server snapshot is empty, so hydration matches; the stored code appears right after.
  const storedCode = useSyncExternalStore(subscribeNever, readStoredAccessCode, () => '');
  const accessCode = typedCode ?? storedCode;

  function onStart(): void {
    if (starting.current || mutation.isPending || mutation.isSuccess || hasUnsavedChanges) return;
    starting.current = true;
    setFailure(null);
    const code = accessCode.trim();
    mutation.mutate(code === '' ? {} : { accessCode: code }, {
      // After success the guard stays on: the page is only waiting for the navigation.
      onSuccess: ({ run }) => {
        if (code !== '') storeAccessCode(code);
        void router.push(`/runs/${run.id}`);
      },
      onError: (error) => {
        starting.current = false;
        const next = describeStartFailure(error);
        // A refused code is not worth remembering: the next visit would repeat the refusal.
        if (next.kind === 'code_invalid') storeAccessCode('');
        setFailure(next);
      },
    });
  }

  return (
    <section
      aria-labelledby="readiness-heading"
      className="card border border-base-300 bg-base-100"
    >
      <div className="card-body gap-4">
        <h2 id="readiness-heading" className="card-title text-2xl">
          Ready to run?
        </h2>

        {readiness.activeRunId !== null ? (
          <p>
            A run is in progress for this project.{' '}
            <Link href={`/runs/${readiness.activeRunId}`} className="link font-medium">
              View the active run
            </Link>
          </p>
        ) : readiness.missing.length > 0 ? (
          <div>
            <p className="font-medium">Still needed before a run can start:</p>
            <ul className="mt-2 list-disc space-y-1 pl-6">
              {readiness.missing.map((item) => (
                <li key={item.kind === 'fact' ? `fact:${item.key}` : item.kind}>
                  {readinessMessage(item, market)}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p>All inputs are in place. You can start a run.</p>
        )}

        {failure?.kind === 'not_ready' && !readiness.canStartRun && (
          // The failure is recorded after the readiness refetch landed (the mutation waits for
          // it), so the list above is current. It clears once the inputs are complete again.
          <div role="alert" className="alert alert-warning">
            <span>
              Some inputs changed since this page loaded. The list above shows what is missing now.
            </span>
          </div>
        )}
        {failure?.kind === 'run_active' && (
          <div role="alert" className="alert alert-info">
            <span>
              A run is already in progress for this project.
              {readiness.activeRunId !== null && (
                <>
                  {' '}
                  <Link href={`/runs/${readiness.activeRunId}`} className="link font-medium">
                    View the active run
                  </Link>
                </>
              )}
            </span>
          </div>
        )}
        {failure?.kind === 'budget' && (
          <div role="alert" className="alert alert-info">
            <span>
              Today&apos;s run budget has been used up. Your inputs are saved; start the run again
              tomorrow.
            </span>
          </div>
        )}
        {failure?.kind === 'code_rate_limited' && (
          <div role="alert" className="alert alert-warning">
            <span>Too many wrong codes, try again later.</span>
          </div>
        )}
        {failure?.kind === 'run_limit' && (
          <div role="alert" className="alert alert-info">
            <span>
              You have reached today&apos;s live run limit.
              {failure.retryAfterSeconds !== null &&
                ` You can start another in ${humanizeWait(failure.retryAfterSeconds)}.`}
            </span>
          </div>
        )}
        {failure?.kind === 'message' && (
          <div role="alert" className="alert alert-error">
            <span>{failure.message}</span>
          </div>
        )}

        <Field
          id={codeId}
          label="Access code"
          hint="Live runs use paid model calls. If you were given a code, enter it; otherwise leave this empty."
          error={failure?.kind === 'code_invalid' ? 'This access code is not valid.' : undefined}
        >
          {(control) => (
            <div className="join w-full sm:max-w-sm">
              <input
                {...control}
                type={showCode ? 'text' : 'password'}
                className={`input join-item min-h-11 w-full ${failure?.kind === 'code_invalid' ? 'input-error' : ''}`}
                value={accessCode}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => {
                  setTypedCode(event.target.value);
                  if (failure?.kind === 'code_invalid') setFailure(null);
                }}
              />
              <button
                type="button"
                className="btn join-item min-h-11"
                aria-pressed={showCode}
                onClick={() => setShowCode((value) => !value)}
              >
                {showCode ? 'Hide' : 'Show'}
                <span className="sr-only"> access code</span>
              </button>
            </div>
          )}
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary min-h-11"
            disabled={
              !readiness.canStartRun ||
              mutation.isPending ||
              mutation.isSuccess ||
              hasUnsavedChanges
            }
            onClick={onStart}
          >
            {mutation.isPending && (
              <span className="loading loading-spinner loading-sm" aria-hidden />
            )}
            Start run
          </button>
          {hasUnsavedChanges && readiness.canStartRun && (
            <span className="text-sm text-base-content/70">Save your changes first.</span>
          )}
          {latestRun !== null && readiness.activeRunId === null && (
            <span className="flex items-center gap-2 text-sm">
              <RunStatusBadge status={latestRun.status} />
              <Link
                href={`/runs/${latestRun.id}`}
                className="link inline-flex min-h-11 items-center"
              >
                View latest run
              </Link>
              {/* A completed run has stored its export; the pack page handles the rare gap. */}
              {latestRun.status === 'completed' && (
                <Link
                  href={`/runs/${latestRun.id}/pack`}
                  className="link inline-flex min-h-11 items-center"
                >
                  View pack
                </Link>
              )}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
