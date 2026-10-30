import type { RunSnapshot, RunStepSnapshot, RunStepViewStatus } from '@evidomo/shared';
import Link from 'next/link';
import { ApiRequestError } from '../lib/api';
import { reviewPageHref } from '../lib/claim-audit';
import { conflictsPageHref } from '../lib/fact-conflicts';
import { withNext } from '../lib/next-path';
import { costShare, formatDuration, formatUsd, gateLabel } from '../lib/run-monitor';
import { stepLabel } from '../lib/step-labels';
import type { RunMonitor as RunMonitorState, StreamState } from '../lib/use-run-monitor';

const STEP_BADGES: Record<RunStepViewStatus, { className: string; label: string }> = {
  pending: { className: 'badge-outline', label: 'Waiting' },
  queued: { className: 'badge-info badge-outline', label: 'Queued' },
  running: { className: 'badge-info', label: 'Running' },
  completed: { className: 'badge-success', label: 'Done' },
  failed: { className: 'badge-error', label: 'Failed' },
};

const RUN_BADGES: Record<RunSnapshot['status'], { className: string; label: string }> = {
  queued: STEP_BADGES.queued,
  running: STEP_BADGES.running,
  awaiting_gate: { className: 'badge-secondary', label: 'Awaiting your review' },
  completed: { className: 'badge-success', label: 'Completed' },
  failed: STEP_BADGES.failed,
};

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
  const { status } = step;
  const { className, label } = review
    ? { className: 'badge-secondary', label: 'Needs your review' }
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
      {label}
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
  const cap = run.maxExecutionsPerAttempt;
  const duration = formatDuration(step.startedAt, step.finishedAt);
  const { label, description } = stepLabel(step.stepId);
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
            <dt>Attempts</dt>
            <dd>
              {step.attempts}
              {cap > 0 && step.executions > 1 ? ` (execution ${step.executions}/${cap})` : ''}
            </dd>
          </div>
        )}
        {step.costUsd !== undefined && (
          <div className="flex gap-1">
            <dt>Cost</dt>
            <dd>{formatUsd(step.costUsd)}</dd>
          </div>
        )}
        {duration !== null && (
          <div className="flex gap-1">
            <dt>Duration</dt>
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
          Cost so far
        </h2>
        <span className="badge badge-outline">Visible in development only</span>
      </div>
      <p className="text-3xl font-bold">
        {formatUsd(costUsd)}
        {cap !== null && (
          <span className="text-base font-normal text-base-content/70">
            {' '}
            of {formatUsd(cap)} cap
          </span>
        )}
      </p>
      {share !== null && (
        <>
          <progress
            className={`progress w-full ${nearCap ? 'progress-error' : 'progress-primary'}`}
            value={Math.round(share * 100)}
            max={100}
            aria-label="Run cost against the cap"
          />
          <p className={`text-sm ${nearCap ? 'font-medium text-error' : 'text-base-content/70'}`}>
            {nearCap && <span aria-hidden>! </span>}
            {share >= 1
              ? 'The run has reached its cost cap.'
              : nearCap
                ? 'The run is close to its cost cap.'
                : `${Math.round(share * 100)}% of the cap. The run stops by itself at the cap.`}
          </p>
        </>
      )}
    </section>
  );
}

function GateNotice({ gate, runId }: { gate: NonNullable<RunSnapshot['gate']>; runId: string }) {
  const conflicts = gate === 'fact_conflicts';
  return (
    <section
      aria-label="Review needed"
      className="flex flex-col gap-3 rounded-box border-2 border-secondary bg-base-100 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-secondary gap-1">
          <span aria-hidden>!</span>Paused
        </span>
        <h2 className="text-lg font-semibold">{gateLabel(gate)}</h2>
      </div>
      <p className="text-sm text-base-content/70">
        The run is paused until you finish this review. It stays here for as long as you need; you
        can leave this page, and the run continues after your last decision.
      </p>
      <div>
        <Link
          href={conflicts ? conflictsPageHref(runId) : reviewPageHref(runId)}
          className="btn btn-primary min-h-11"
        >
          {conflicts ? 'Review conflicts' : 'Review the pack'}
        </Link>
      </div>
    </section>
  );
}

function FailureNotice({ reason }: { reason: string | null }) {
  return (
    <div role="alert" className="alert alert-error alert-vertical items-start sm:alert-horizontal">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold">
          <span aria-hidden>× </span>The run failed
        </h2>
        <p className="text-sm">{reason ?? 'No reason was recorded.'}</p>
        <p className="text-sm">
          Your photos, voice memo, and form are untouched; nothing was published.
        </p>
      </div>
    </div>
  );
}

function CompletedNotice({ run, runId }: { run: RunSnapshot; runId: string }) {
  const { export: manifest } = run;
  const duration = formatDuration(run.startedAt, run.finishedAt);
  return (
    <section
      aria-label="Run finished"
      className="flex flex-col gap-3 rounded-box border-2 border-success bg-base-100 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-success gap-1">
          <CheckIcon />
          Finished
        </span>
        <h2 className="text-lg font-semibold">Your listing pack is ready</h2>
      </div>
      <p role="status" className="text-sm text-base-content/70">
        {manifest !== null
          ? `Export ready: ${manifest.fileCount} files${manifest.readyToPublish ? '' : ' (not yet ready to publish)'}.`
          : 'The run finished without an export.'}
        {duration !== null && ` It took ${duration}.`}
      </p>
      {manifest !== null && (
        <div>
          <Link href={`/runs/${runId}/pack`} className="btn btn-primary min-h-11">
            View pack
          </Link>
        </div>
      )}
    </section>
  );
}

function announcement(run: RunSnapshot): string {
  switch (run.status) {
    case 'queued':
      return 'Run queued.';
    case 'running': {
      const step = run.steps.find((s) => s.stepId === run.currentStepId);
      return step ? `Running step ${stepLabel(step.stepId).label}.` : 'Run in progress.';
    }
    case 'awaiting_gate':
      return run.gate ? `Run paused: ${gateLabel(run.gate)}.` : 'Run paused for review.';
    case 'completed':
      return 'Run completed.';
    case 'failed':
      // The failure alert announces itself; saying it here too would read it out twice.
      return '';
  }
}

function StreamNotice({ state, onRetry }: { state: StreamState; onRetry: () => void }) {
  if (state === 'reconnecting') {
    return (
      <div role="status" className="flex items-center gap-2 text-sm text-base-content/70">
        <span className="loading loading-spinner loading-xs" aria-hidden />
        Live updates interrupted. Reconnecting…
      </div>
    );
  }
  if (state === 'unavailable') {
    return (
      <div role="alert" className="alert alert-warning alert-vertical sm:alert-horizontal">
        <span>
          Live updates are paused. What you see is the last known state. Try resuming; if it keeps
          failing, reload the page.
        </span>
        <button type="button" className="btn min-h-11" onClick={onRetry}>
          Resume live updates
        </button>
      </div>
    );
  }
  return null;
}

/** Progress as a sentence and a bar: completed steps out of all steps. */
function StepProgress({ run }: { run: RunSnapshot }) {
  const total = run.steps.length;
  const done = run.steps.filter((step) => step.status === 'completed').length;
  if (total === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-base-content/70">
        {done} of {total} steps done
      </p>
      <progress
        className="progress progress-primary w-full"
        value={done}
        max={total}
        aria-label="Steps done"
      />
    </div>
  );
}

export function RunMonitorView({ monitor, runId }: { monitor: RunMonitorState; runId: string }) {
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
        <h1 className="card-title text-2xl">Run</h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge ${badge.className} gap-1`}>
            <StatusMark kind={badgeMark} />
            {badge.label}
          </span>
          <span className="min-w-0 truncate font-mono text-sm text-base-content/70">{runId}</span>
        </div>
        {/* Announces transitions only; cost ticks are deliberately not in here. */}
        <p aria-live="polite" className="sr-only">
          {announcement(run)}
        </p>
      </div>

      <StreamNotice state={monitor.streamState} onRetry={monitor.retryStream} />
      {monitor.sessionExpired ? (
        <SessionExpiredState next={`/runs/${runId}`} />
      ) : (
        monitor.refreshFailed && (
          <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-base-content/70">
              Could not refresh the run just now. What you see may be a little behind.
            </span>
            <button type="button" className="btn min-h-11" onClick={monitor.retryStream}>
              Try again
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
            Steps
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
  return (
    <div role="alert" className="alert alert-warning alert-vertical sm:alert-horizontal">
      <span>Your session has expired.</span>
      <Link href={withNext('/login', next)} className="btn min-h-11">
        Log in again
      </Link>
    </div>
  );
}

export function LoadErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="alert alert-error alert-vertical sm:alert-horizontal">
      <span>{message}</span>
      <button type="button" className="btn min-h-11" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function RunLoadState({ monitor, runId }: { monitor: RunMonitorState; runId: string | null }) {
  const { error, isError, refetch } = monitor.snapshot;
  if (!isError) return <LoadingState label="Loading the run…" rows={4} />;
  if (error instanceof ApiRequestError && error.status === 404) {
    return <RunNotFound />;
  }
  if (error instanceof ApiRequestError && error.status === 401) {
    return <SessionExpiredState next={runId === null ? '/projects' : `/runs/${runId}`} />;
  }
  return (
    <LoadErrorState
      message="We could not load this run. Check your connection and try again."
      onRetry={() => void refetch()}
    />
  );
}

export function RunNotFound() {
  return (
    <div role="alert" className="alert alert-warning alert-vertical sm:alert-horizontal">
      <span>This run was not found. It may belong to another account or no longer exist.</span>
      <Link href="/projects" className="btn min-h-11">
        Go to your projects
      </Link>
    </div>
  );
}
