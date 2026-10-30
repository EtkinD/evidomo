import type { RunSnapshot } from '@evidomo/shared';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { storeAccessCode } from '../lib/access-code';
import { useRunSource } from '../lib/run-source';
import {
  describeResumeFailure,
  failedStepOf,
  resumeAvailability,
  useResumeRun,
  waitPhrase,
  type RunResumability,
  type ResumeFailure,
} from '../lib/run-resume';
import { stepLabel } from '../lib/step-labels';
import { AccessCodeField, useAccessCode } from './AccessCodeField';

/** Failures after which resuming is pointless: the button and the code field go away. */
const isDeadEnd = (failure: ResumeFailure | null): boolean =>
  failure?.kind === 'run_budget_exhausted' ||
  failure?.kind === 'not_found' ||
  failure?.kind === 'not_resumable' ||
  failure?.kind === 'run_active';

/** Why the snapshot says Resume is not available (the server's own `resume` field). */
function BlockedNotice({
  reason,
  projectId,
}: {
  reason: Exclude<RunResumability, 'available'>;
  projectId: string;
}) {
  const t = useTranslations('runFailure');
  const text = {
    not_failed: t('notResumable'),
    budget_exhausted: t('budgetExhausted'),
    inputs_changed: t('inputsChanged'),
    definition_unavailable: t('definitionUnavailable'),
    other_run_active: t('runActive'),
    daily_budget_reached: t('dailyBudget'),
  }[reason];
  const busy = reason === 'other_run_active';
  return (
    <div role="status" className="alert alert-warning alert-vertical items-start">
      <span>{text}</span>
      <Link href={`/projects/${projectId}`} className={`btn min-h-11 ${busy ? '' : 'btn-primary'}`}>
        {busy ? t('openProject') : t('startNewRun')}
      </Link>
    </div>
  );
}

function ResumeFailureNotice({
  failure,
  projectId,
}: {
  failure: ResumeFailure;
  projectId: string;
}) {
  const t = useTranslations('runFailure');
  const tReadiness = useTranslations('readiness');
  const tRun = useTranslations('run');
  switch (failure.kind) {
    case 'code_invalid':
      return null; // Shown on the access-code field.
    case 'run_budget_exhausted':
      return (
        <div role="alert" className="alert alert-warning alert-vertical items-start">
          <span>{t('budgetExhausted')}</span>
          <Link href={`/projects/${projectId}`} className="btn btn-primary min-h-11">
            {t('startNewRun')}
          </Link>
        </div>
      );
    case 'not_found':
      return (
        <div role="alert" className="alert alert-warning alert-vertical items-start">
          <span>{t('gone')}</span>
          <Link href="/projects" className="btn min-h-11">
            {tRun('goToProjects')}
          </Link>
        </div>
      );
    case 'not_resumable':
      return (
        <div role="alert" className="alert alert-info alert-vertical items-start">
          <span>{t('notResumable')}</span>
          <Link href={`/projects/${projectId}`} className="btn btn-primary min-h-11">
            {t('startNewRun')}
          </Link>
        </div>
      );
    case 'run_active':
      return <BlockedNotice reason="other_run_active" projectId={projectId} />;
    case 'daily_budget': {
      const wait = waitPhrase(tReadiness, failure.retryAfterSeconds);
      return (
        <div role="alert" className="alert alert-info">
          <span>{wait === null ? t('dailyBudget') : t('dailyBudgetWait', { wait })}</span>
        </div>
      );
    }
    case 'run_limit': {
      const wait = waitPhrase(tReadiness, failure.retryAfterSeconds);
      return (
        <div role="alert" className="alert alert-info">
          <span>{wait === null ? t('runLimit') : t('runLimitWait', { wait })}</span>
        </div>
      );
    }
    case 'code_rate_limited':
      return (
        <div role="alert" className="alert alert-warning">
          <span>{t('codeRateLimited')}</span>
        </div>
      );
    case 'message':
      return (
        <div role="alert" className="alert alert-error">
          <span>{failure.message}</span>
        </div>
      );
  }
}

/**
 * A failed run, as the margin note of the ledger: which step stopped it and why (the API's own
 * reason), what is kept, and the one next action. A demo shows the same facts without the action.
 */
export function FailureNotice({
  run,
  runId,
  onResumed,
}: {
  run: RunSnapshot;
  runId: string;
  /** Called with the step's name once the server accepted the resume. */
  onResumed: (stepName: string | null) => void;
}) {
  const t = useTranslations('run');
  const tF = useTranslations('runFailure');
  const tR = useTranslations('readiness');
  const tSteps = useTranslations('steps');
  const tApi = useTranslations('apiErrors');
  const demo = useRunSource().kind === 'demo';
  const mutation = useResumeRun(runId);
  const { code, setCode } = useAccessCode();
  const [failure, setFailure] = useState<ResumeFailure | null>(null);
  // A ref: two clicks in one tick both see the mutation as idle.
  const sending = useRef(false);

  const availability = resumeAvailability(run);
  const blocked = availability === undefined || availability === 'available' ? null : availability;
  const step = failedStepOf(run);
  const stepName = step === undefined ? null : stepLabel(tSteps, step.stepId).label;
  const reason = run.failureReason ?? step?.error ?? null;
  const done = run.steps.filter((s) => s.status === 'completed').length;
  const total = run.steps.length;

  function onResume(): void {
    if (sending.current || mutation.isPending) return;
    sending.current = true;
    setFailure(null);
    const trimmed = code.trim();
    mutation.mutate(trimmed === '' ? {} : { accessCode: trimmed }, {
      onSuccess: () => {
        sending.current = false;
        if (trimmed !== '') storeAccessCode(trimmed);
        onResumed(stepName);
      },
      onError: (error) => {
        sending.current = false;
        const next = describeResumeFailure(tApi, error);
        // A refused code is not worth remembering: the next visit would repeat the refusal.
        if (next.kind === 'code_invalid') storeAccessCode('');
        setFailure(next);
      },
    });
  }

  return (
    <section
      aria-labelledby="run-failed-heading"
      className="flex flex-col gap-4 border-l-4 border-error bg-base-100 p-4 shadow-sheet"
    >
      <div role="alert" className="flex flex-col gap-3">
        <h2 id="run-failed-heading" className="text-2xl leading-tight font-medium">
          <span aria-hidden>× </span>
          {t('failed')}
        </h2>
        <p className="font-medium">
          {stepName === null ? tF('failedBetween') : tF('failedAt', { step: stepName })}
        </p>
        <div className="flex flex-col gap-1">
          <p className="text-sm text-base-content/70">{tF('reasonLabel')}</p>
          <blockquote className="border-l-2 border-base-content/30 pl-3 text-sm break-words">
            {reason ?? t('noReason')}
          </blockquote>
        </div>
        {total > 0 && <p className="text-sm">{tF('kept', { done, total })}</p>}
        <p className="text-sm text-base-content/70">{t('untouched')}</p>
      </div>

      {demo ? (
        <p className="border-t border-base-content/20 pt-3 text-sm text-base-content/70">
          {tF('demoFailed')}
        </p>
      ) : (
        <div className="flex flex-col gap-3 border-t border-base-content/20 pt-4">
          <h3 className="text-lg font-medium">{tF('nextTitle')}</h3>
          {blocked !== null && <BlockedNotice reason={blocked} projectId={run.projectId} />}
          {blocked === null && !isDeadEnd(failure) && (
            <>
              <p className="text-sm">
                {stepName === null ? tF('resumeTextGeneric') : tF('resumeText', { step: stepName })}
              </p>
              <p className="text-sm text-base-content/70">{tF('allowance')}</p>
              <AccessCodeField
                code={code}
                error={failure?.kind === 'code_invalid' ? tR('accessCodeInvalid') : undefined}
                onChange={(value) => {
                  setCode(value);
                  if (failure?.kind === 'code_invalid') setFailure(null);
                }}
              />
              <div>
                <button
                  type="button"
                  className="btn btn-primary min-h-11"
                  disabled={mutation.isPending}
                  onClick={onResume}
                >
                  {mutation.isPending && (
                    <span className="loading loading-spinner loading-sm" aria-hidden />
                  )}
                  {tF('resume')}
                </button>
              </div>
            </>
          )}
          {mutation.isPending && (
            <p role="status" className="text-sm text-base-content/70">
              {tF('resuming')}
            </p>
          )}
          {failure !== null && <ResumeFailureNotice failure={failure} projectId={run.projectId} />}
        </div>
      )}
    </section>
  );
}
