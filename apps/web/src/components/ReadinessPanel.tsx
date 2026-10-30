import type { MarketForm, ProjectDetailResponse } from '@evidomo/shared';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  describeAccessFailure,
  humanizeWait,
  storeAccessCode,
  type AccessFailure,
} from '../lib/access-code';
import { ApiRequestError } from '../lib/api';
import type { Translator } from '../lib/i18n';
import { readinessMessage } from '../lib/project-view';
import { useStartRun } from '../lib/projects';
import { describeRequestFailure } from '../lib/request-failure';
import { AccessCodeField, useAccessCode } from './AccessCodeField';
import { RunStatusBadge } from './RunStatusBadge';

type StartFailure =
  | AccessFailure
  | { kind: 'not_ready' }
  | { kind: 'run_active' }
  | { kind: 'budget' }
  | { kind: 'message'; message: string };

function describeStartFailure(tApi: Translator<'apiErrors'>, error: unknown): StartFailure {
  const access = describeAccessFailure(error);
  if (access !== null) return access;
  if (error instanceof ApiRequestError) {
    if (error.code === 'not_ready') return { kind: 'not_ready' };
    if (error.code === 'run_active') return { kind: 'run_active' };
    if (error.code === 'daily_budget_reached') return { kind: 'budget' };
  }
  return { kind: 'message', message: describeRequestFailure(tApi, error) };
}

interface ReadinessPanelProps {
  detail: ProjectDetailResponse;
  market: MarketForm | undefined;
  /** Facts or office profile have edits that are not saved: a run would start on the old values. */
  hasUnsavedChanges: boolean;
}

/** What is still needed before a run, and the one action that starts it. */
export function ReadinessPanel({ detail, market, hasUnsavedChanges }: ReadinessPanelProps) {
  const t = useTranslations('readiness');
  const tApi = useTranslations('apiErrors');
  const router = useRouter();
  const { project, readiness, latestRun } = detail;
  const mutation = useStartRun(project.id);
  const [failure, setFailure] = useState<StartFailure | null>(null);
  // A ref: two clicks in the same tick both see the mutation as idle.
  const starting = useRef(false);
  const { code: accessCode, setCode } = useAccessCode();

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
        const next = describeStartFailure(tApi, error);
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
          {t('title')}
        </h2>

        {readiness.activeRunId !== null ? (
          <p>
            {t('activeRun')}{' '}
            <Link
              href={`/runs/${readiness.activeRunId}`}
              className="link inline-flex min-h-11 items-center font-medium"
            >
              {t('viewActiveRun')}
            </Link>
          </p>
        ) : readiness.missing.length > 0 ? (
          <div>
            <p className="font-medium">{t('stillNeeded')}</p>
            <ul className="mt-2 list-disc space-y-1 pl-6">
              {readiness.missing.map((item) => (
                <li key={item.kind === 'fact' ? `fact:${item.key}` : item.kind}>
                  {readinessMessage(t, item, market)}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p>{t('allReady')}</p>
        )}

        {failure?.kind === 'not_ready' && !readiness.canStartRun && (
          // The failure is recorded after the readiness refetch landed (the mutation waits for
          // it), so the list above is current. It clears once the inputs are complete again.
          <div role="alert" className="alert alert-warning">
            <span>{t('inputsChanged')}</span>
          </div>
        )}
        {failure?.kind === 'run_active' && (
          <div role="alert" className="alert alert-info">
            <span>
              {t('alreadyActive')}
              {readiness.activeRunId !== null && (
                <>
                  {' '}
                  <Link
                    href={`/runs/${readiness.activeRunId}`}
                    className="link inline-flex min-h-11 items-center font-medium"
                  >
                    {t('viewActiveRun')}
                  </Link>
                </>
              )}
            </span>
          </div>
        )}
        {failure?.kind === 'budget' && (
          <div role="alert" className="alert alert-info">
            <span>{t('budgetUsed')}</span>
          </div>
        )}
        {failure?.kind === 'code_rate_limited' && (
          <div role="alert" className="alert alert-warning">
            <span>{t('codeRateLimited')}</span>
          </div>
        )}
        {failure?.kind === 'run_limit' && (
          <div role="alert" className="alert alert-info">
            <span>
              {failure.retryAfterSeconds === null
                ? t('runLimit')
                : t('runLimitWait', { wait: humanizeWait(t, failure.retryAfterSeconds) })}
            </span>
          </div>
        )}
        {failure?.kind === 'message' && (
          <div role="alert" className="alert alert-error">
            <span>{failure.message}</span>
          </div>
        )}

        <AccessCodeField
          code={accessCode}
          error={failure?.kind === 'code_invalid' ? t('accessCodeInvalid') : undefined}
          onChange={(value) => {
            setCode(value);
            if (failure?.kind === 'code_invalid') setFailure(null);
          }}
        />

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
            {t('start')}
          </button>
          {hasUnsavedChanges && readiness.canStartRun && (
            <span className="text-sm text-base-content/70">{t('saveFirst')}</span>
          )}
          {latestRun !== null && readiness.activeRunId === null && (
            <span className="flex items-center gap-2 text-sm">
              <RunStatusBadge status={latestRun.status} />
              <Link
                href={`/runs/${latestRun.id}`}
                className="link inline-flex min-h-11 items-center"
              >
                {t('viewLatest')}
              </Link>
              {/* A completed run has stored its export; the pack page handles the rare gap. */}
              {latestRun.status === 'completed' && (
                <Link
                  href={`/runs/${latestRun.id}/pack`}
                  className="link inline-flex min-h-11 items-center"
                >
                  {t('viewPack')}
                </Link>
              )}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
