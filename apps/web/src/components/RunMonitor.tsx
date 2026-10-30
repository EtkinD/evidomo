import type { RunSnapshot, RunStepSnapshot, RunStepViewStatus } from '@evidomo/shared';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { ApiRequestError } from '../lib/api';
import type { Translator } from '../lib/i18n';
import { withNext } from '../lib/next-path';
import { costShare, formatDuration, formatUsd, gateLabel } from '../lib/run-monitor';
import { useRunSource } from '../lib/run-source';
import { stepLabel } from '../lib/step-labels';
import type { RunMonitor as RunMonitorState, StreamState } from '../lib/use-run-monitor';

// Labels are keys of the `run` messages, translated where the badge renders.
const STEP_BADGES = {
  pending: { className: 'badge-outline', label: 'stepStatus.pending' },
  queued: { className: 'badge-info badge-outline', label: 'stepStatus.queued' },
  running: { className: 'badge-info', label: 'stepStatus.running' },
  completed: { className: 'badge-success', label: 'stepStatus.completed' },
  failed: { className: 'badge-error', label: 'stepStatus.failed' },
} as const satisfies Record<RunStepViewStatus, { className: string; label: string }>;

const RUN_BADGES = {
  queued: STEP_BADGES.queued,
  running: STEP_BADGES.running,
  awaiting_gate: { className: 'badge-secondary', label: 'runStatus.awaitingGate' },
  completed: { className: 'badge-success', label: 'runStatus.completed' },
  failed: STEP_BADGES.failed,
} as const satisfies Record<RunSnapshot['status'], { className: string; label: string }>;

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden>
      <path
        d="M3 8.5 6.5 12 13 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Status is always icon plus text, never colour alone. */
function StatusMark({ kind }: { kind: 'done' | 'running' | 'review' | 'failed' | 'idle' }) {
  switch (kind) {
    case 'done':
      return <CheckIcon />;
    case 'running':
      return <span className="loading loading-spinner loading-xs" aria-hidden />;
    case 'review':
      return <span aria-hidden>!</span>;
    case 'failed':
      return <span aria-hidden>×</span>;
    case 'idle':
      return null;
  }
}

/** A finished step the run is paused after, while that review is still open. */
function isReviewStep(step: RunStepSnapshot, run: RunSnapshot): boolean {
  return (
    run.status === 'awaiting_gate' &&
    step.status === 'completed' &&
    step.gateAfter !== null &&
    step.gateAfter === run.gate
  );
}

function StepBadge({ step, review }: { step: RunStepSnapshot; review: boolean }) {
  const t = useTranslations('run');
  const { status } = step;
  const { className, label } = review
    ? { className: 'badge-secondary', label: 'stepStatus.needsReview' as const }
    : STEP_BADGES[status];
  const mark = review
    ? 'review'
    : status === 'completed'
      ? 'done'
      : status === 'running'
        ? 'running'
        : status === 'failed'
          ? 'failed'
          : 'idle';
  return (
    <span className={`badge ${className} gap-1`}>
      <StatusMark kind={mark} />
      {t(label)}
    </span>
  );
}

function StepItem({
  step,
  index,
  run,
}: {
  step: RunStepSnapshot;
  index: number;
  run: RunSnapshot;
}) {
  const t = useTranslations('run');
  const tSteps = useTranslations('steps');
  const format = useFormatter();
  const cap = run.maxExecutionsPerAttempt;
  const duration = formatDuration(t, step.startedAt, step.finishedAt);
  const { label, description } = stepLabel(tSteps, step.stepId);
  const review = isReviewStep(step, run);
  const current = review || step.status === 'running';
  const showAttempts = step.attempts > 1 || step.executions > 1;
  return (
    <li
      aria-current={current ? 'step' : undefined}
      className={`flex flex-col gap-1 rounded-box border bg-base-100 p-3 ${
        review ? 'border-secondary' : step.status === 'failed' ? 'border-error' : 'border-base-300'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-semibold">
          <span className="badge badge-ghost font-mono" aria-hidden>
            {index + 1}
          </span>
          {label}
        </span>
        <StepBadge step={step} review={review} />
      </div>
      {description !== '' && <p className="text-sm text-base-content/70">{description}</p>}
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-base-content/70">
        {showAttempts && (
          <div className="flex gap-1">
            <dt>{t('attempts')}</dt>
            <dd>
              {step.attempts}
              {cap > 0 && step.executions > 1
                ? ` (${t('execution', { current: step.executions, max: cap })})`
                : ''}
            </dd>
          </div>
        )}
        {step.costUsd !== undefined && (
          <div className="flex gap-1">
            <dt>{t('cost')}</dt>
            <dd>{formatUsd(format, step.costUsd)}</dd>
          </div>
        )}
        {duration !== null && (
          <div className="flex gap-1">
            <dt>{t('duration.label')}</dt>
            <dd>{duration}</dd>
          </div>
        )}
      </dl>
      {step.error !== null && step.status !== 'completed' && (
        <p className="text-sm text-error">{step.error}</p>
      )}
    </li>
  );
}

/** Only when the server discloses costs (development); production snapshots carry none. */
function CostCard({ run, costUsd }: { run: RunSnapshot; costUsd: string }) {
  const t = useTranslations('run');
  const format = useFormatter();
  const share = costShare(run);
  const cap = run.costCapUsd ?? null;
  const nearCap = share !== null && share >= 0.8;
  return (
    <section
      aria-labelledby="run-cost-heading"
      className="flex flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="run-cost-heading" className="text-lg font-semibold">
          {t('costSoFar')}
        </h2>
        <span className="badge badge-outline">{t('devOnly')}</span>
      </div>
      <p className="text-3xl font-bold">
        {formatUsd(format, costUsd)}
        {cap !== null && (
          <span className="text-base font-normal text-base-content/70">
            {' '}
            {t('ofCap', { cap: formatUsd(format, cap) })}
          </span>
        )}
      </p>
      {share !== null && (
        <>
          <progress
            className={`progress w-full ${nearCap ? 'progress-error' : 'progress-primary'}`}
            value={Math.round(share * 100)}
            max={100}
            aria-label={t('costAgainstCap')}
          />
          <p className={`text-sm ${nearCap ? 'font-medium text-error' : 'text-base-content/70'}`}>
            {nearCap && <span aria-hidden>! </span>}
            {share >= 1
              ? t('capReached')
              : nearCap
                ? t('capClose')
                : t('capShare', { share: Math.round(share * 100) / 100 })}
          </p>
        </>
      )}
    </section>
  );
}

function GateNotice({ gate, runId }: { gate: NonNullable<RunSnapshot['gate']>; runId: string }) {
  const t = useTranslations('run');
  const source = useRunSource();
  const demo = source.kind === 'demo';
  const conflicts = gate === 'fact_conflicts';
  return (
    <section
      aria-label={t('reviewNeeded')}
      className="flex flex-col gap-3 rounded-box border-2 border-secondary bg-base-100 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-secondary gap-1">
          <span aria-hidden>!</span>
          {t('paused')}
        </span>
        <h2 className="text-lg font-semibold">{gateLabel(t, gate)}</h2>
      </div>
      <p className="text-sm text-base-content/70">{demo ? t('gateTextDemo') : t('gateText')}</p>
      <div>
        <Link
          href={conflicts ? source.hrefs.conflicts(runId) : source.hrefs.review(runId)}
          className="btn btn-primary min-h-11"
        >
          {demo
            ? conflicts
              ? t('seeConflicts')
              : t('seeReview')
            : conflicts
              ? t('reviewConflicts')
              : t('reviewPack')}
        </Link>
      </div>
    </section>
  );
}

function FailureNotice({ reason }: { reason: string | null }) {
  const t = useTranslations('run');
  return (
    <div role="alert" className="alert alert-error alert-vertical items-start sm:alert-horizontal">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold">
          <span aria-hidden>× </span>
          {t('failed')}
        </h2>
        <p className="text-sm">{reason ?? t('noReason')}</p>
        <p className="text-sm">{t('untouched')}</p>
      </div>
    </div>
  );
}

function CompletedNotice({ run, runId }: { run: RunSnapshot; runId: string }) {
  const t = useTranslations('run');
  const source = useRunSource();
  const { export: manifest } = run;
  const duration = formatDuration(t, run.startedAt, run.finishedAt);
  return (
    <section
      aria-label={t('finishedLabel')}
      className="flex flex-col gap-3 rounded-box border-2 border-success bg-base-100 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-success gap-1">
          <CheckIcon />
          {t('finished')}
        </span>
        <h2 className="text-lg font-semibold">
          {source.kind === 'demo' ? t('packReadyDemo') : t('packReady')}
        </h2>
      </div>
      <p role="status" className="text-sm text-base-content/70">
        {manifest !== null
          ? manifest.readyToPublish
            ? t('exportReady', { count: manifest.fileCount })
            : t('exportReadyNotPublishable', { count: manifest.fileCount })
          : t('noExport')}
        {duration !== null && ` ${t('tookTime', { duration })}`}
      </p>
      {manifest !== null && (
        <div>
          <Link href={source.hrefs.pack(runId)} className="btn btn-primary min-h-11">
            {t('viewPack')}
          </Link>
        </div>
      )}
    </section>
  );
}

function announcement(t: Translator<'run'>, tSteps: Translator<'steps'>, run: RunSnapshot): string {
  switch (run.status) {
    case 'queued':
      return t('announce.queued');
    case 'running': {
      const step = run.steps.find((s) => s.stepId === run.currentStepId);
      return step
        ? t('announce.runningStep', { step: stepLabel(tSteps, step.stepId).label })
        : t('announce.inProgress');
    }
    case 'awaiting_gate':
      return run.gate
        ? t('announce.pausedAt', { gate: gateLabel(t, run.gate) })
        : t('announce.paused');
    case 'completed':
      return t('announce.completed');
    case 'failed':
      // The failure alert announces itself; saying it here too would read it out twice.
      return '';
  }
}

function StreamNotice({
  state,
  onRetry,
  demo,
}: {
  state: StreamState;
  onRetry: () => void;
  demo: boolean;
}) {
  const t = useTranslations('run');
  if (state === 'unavailable' && demo) {
    return (
      <div role="alert" className="alert alert-warning alert-vertical sm:alert-horizontal">
        <span>{t('replayStopped')}</span>
        <button type="button" className="btn min-h-11" onClick={onRetry}>
          {t('tryAgain')}
        </button>
      </div>
    );
  }
  if (state === 'reconnecting') {
    return (
      <div role="status" className="flex items-center gap-2 text-sm text-base-content/70">
        <span className="loading loading-spinner loading-xs" aria-hidden />
        {demo ? t('replayReconnecting') : t('liveReconnecting')}
      </div>
    );
  }
  if (state === 'unavailable') {
    return (
      <div role="alert" className="alert alert-warning alert-vertical sm:alert-horizontal">
        <span>{t('liveUnavailable')}</span>
        <button type="button" className="btn min-h-11" onClick={onRetry}>
          {t('resumeLive')}
        </button>
      </div>
    );
  }
  return null;
}

/** Progress as a sentence and a bar: completed steps out of all steps. */
function StepProgress({ run }: { run: RunSnapshot }) {
  const t = useTranslations('run');
  const total = run.steps.length;
  const done = run.steps.filter((step) => step.status === 'completed').length;
  if (total === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-base-content/70">{t('stepsDone', { done, total })}</p>
      <progress
        className="progress progress-primary w-full"
        value={done}
        max={total}
        aria-label={t('stepsDoneLabel')}
      />
    </div>
  );
}

/** `controls` (the demo's replay controls) render under the header once the run is loaded. */
export function RunMonitorView({
  monitor,
  runId,
  controls,
}: {
  monitor: RunMonitorState;
  runId: string;
  controls?: ReactNode;
}) {
  const t = useTranslations('run');
  const tSteps = useTranslations('steps');
  const demo = useRunSource().kind === 'demo';
  const run = monitor.snapshot.data;
  if (run === undefined) return <RunLoadState monitor={monitor} runId={runId} />;

  const badge = RUN_BADGES[run.status];
  const badgeMark =
    run.status === 'completed'
      ? 'done'
      : run.status === 'running'
        ? 'running'
        : run.status === 'awaiting_gate'
          ? 'review'
          : run.status === 'failed'
            ? 'failed'
            : 'idle';
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="card-title text-2xl">{demo ? t('titleDemo') : t('title')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge ${badge.className} gap-1`}>
            <StatusMark kind={badgeMark} />
            {t(badge.label)}
          </span>
          <span className="min-w-0 truncate font-mono text-sm text-base-content/70">{runId}</span>
        </div>
        {/* Announces transitions only; cost ticks are deliberately not in here. */}
        <p aria-live="polite" className="sr-only">
          {announcement(t, tSteps, run)}
        </p>
      </div>

      {controls}
      <StreamNotice state={monitor.streamState} onRetry={monitor.retryStream} demo={demo} />
      {monitor.sessionExpired ? (
        <SessionExpiredState next={`/runs/${runId}`} />
      ) : (
        monitor.refreshFailed && (
          <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-base-content/70">{t('refreshFailed')}</span>
            <button type="button" className="btn min-h-11" onClick={monitor.retryStream}>
              {t('tryAgain')}
            </button>
          </div>
        )
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-4 lg:order-last">
          {run.status === 'failed' && <FailureNotice reason={run.failureReason} />}
          {run.status === 'awaiting_gate' && run.gate !== null && (
            <GateNotice gate={run.gate} runId={runId} />
          )}
          {(run.status === 'completed' || run.export !== null) && (
            <CompletedNotice run={run} runId={runId} />
          )}
          {run.costUsd !== undefined && <CostCard run={run} costUsd={run.costUsd} />}
        </div>

        <section aria-labelledby="run-steps-heading" className="flex flex-col gap-3">
          <h2 id="run-steps-heading" className="text-xl font-semibold">
            {t('steps')}
          </h2>
          <StepProgress run={run} />
          <ol className="flex flex-col gap-2">
            {run.steps.map((step, index) => (
              <StepItem key={step.stepId} step={step} index={index} run={run} />
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

// --- Shared screen states (also used by the gate and pack screens) ------------------------------

/** A calm placeholder with a fixed height, so the page does not jump when the data arrives. */
export function LoadingState({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="sr-only">{label}</span>
      <div className="skeleton h-8 w-2/3" aria-hidden />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton h-20 w-full" aria-hidden />
      ))}
    </div>
  );
}

export function SessionExpiredState({ next }: { next: string }) {
  const t = useTranslations('run');
  return (
    <div role="alert" className="alert alert-warning alert-vertical sm:alert-horizontal">
      <span>{t('sessionExpired')}</span>
      <Link href={withNext('/login', next)} className="btn min-h-11">
        {t('logInAgain')}
      </Link>
    </div>
  );
}

/**
 * `error` lets the demo say "wait a moment" for a 429; the owner's screens keep their own
 * message for every failure.
 */
export function LoadErrorState({
  message,
  onRetry,
  error,
}: {
  message: string;
  onRetry: () => void;
  error?: unknown;
}) {
  const t = useTranslations('run');
  const demo = useRunSource().kind === 'demo';
  const limited = demo && error instanceof ApiRequestError && error.status === 429;
  const wait = error instanceof ApiRequestError ? error.retryAfterSeconds : null;
  return (
    <div role="alert" className="alert alert-error alert-vertical sm:alert-horizontal">
      <span>
        {limited
          ? wait !== null && wait > 0 && wait <= 120
            ? t('tooManyRequestsWait', { seconds: wait })
            : t('tooManyRequests')
          : message}
      </span>
      <button type="button" className="btn min-h-11" onClick={onRetry}>
        {t('tryAgain')}
      </button>
    </div>
  );
}

function RunLoadState({ monitor, runId }: { monitor: RunMonitorState; runId: string | null }) {
  const t = useTranslations('run');
  const { error, isError, refetch } = monitor.snapshot;
  if (!isError) return <LoadingState label={t('loading')} rows={4} />;
  if (error instanceof ApiRequestError && error.status === 404) {
    return <RunNotFound />;
  }
  if (error instanceof ApiRequestError && error.status === 401) {
    return <SessionExpiredState next={runId === null ? '/projects' : `/runs/${runId}`} />;
  }
  return <LoadErrorState message={t('loadError')} error={error} onRetry={() => void refetch()} />;
}

export function RunNotFound() {
  const t = useTranslations('run');
  if (useRunSource().kind === 'demo') {
    return (
      <div role="alert" className="alert alert-warning alert-vertical sm:alert-horizontal">
        <span>{t('demoNotFound')}</span>
        <Link href="/demo" className="btn min-h-11">
          {t('seeDemoRuns')}
        </Link>
      </div>
    );
  }
  return (
    <div role="alert" className="alert alert-warning alert-vertical sm:alert-horizontal">
      <span>{t('notFound')}</span>
      <Link href="/projects" className="btn min-h-11">
        {t('goToProjects')}
      </Link>
    </div>
  );
}
