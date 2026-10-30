import type { RunSnapshot, RunStepSnapshot, RunStepViewStatus } from '@evidomo/shared';
import Link from 'next/link';
import { ApiRequestError } from '../lib/api';
import { conflictsPageHref } from '../lib/fact-conflicts';
import { withNext } from '../lib/next-path';
import { costShare, formatDuration, formatUsd, gateLabel } from '../lib/run-monitor';
import type { RunMonitor as RunMonitorState, StreamState } from '../lib/use-run-monitor';

const STEP_BADGES: Record<RunStepViewStatus, { className: string; label: string }> = {
  pending: { className: 'badge-outline', label: 'Pending' },
  queued: { className: 'badge-info badge-outline', label: 'Queued' },
  running: { className: 'badge-info', label: 'Running' },
  completed: { className: 'badge-success', label: 'Completed' },
  failed: { className: 'badge-error', label: 'Failed' },
};

const RUN_BADGES: Record<RunSnapshot['status'], { className: string; label: string }> = {
  queued: STEP_BADGES.queued,
  running: STEP_BADGES.running,
  awaiting_gate: { className: 'badge-secondary', label: 'Awaiting review' },
  completed: STEP_BADGES.completed,
  failed: STEP_BADGES.failed,
};

function StepBadge({ status }: { status: RunStepViewStatus }) {
  const { className, label } = STEP_BADGES[status];
  return (
    <span className={`badge ${className}`}>
      {status === 'running' && <span className="loading loading-spinner loading-xs" aria-hidden />}
      {label}
    </span>
  );
}

function StepItem({ step, cap }: { step: RunStepSnapshot; cap: number }) {
  const duration = formatDuration(step.startedAt, step.finishedAt);
  return (
    <li className="flex flex-col gap-1 rounded-box border border-base-300 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{step.stepId}</span>
        <StepBadge status={step.status} />
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-base-content/70">
        <div className="flex gap-1">
          <dt>Attempts</dt>
          <dd>
            {step.attempts}
            {cap > 0 && step.executions > 1 ? ` (execution ${step.executions}/${cap})` : ''}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Cost</dt>
          <dd>{formatUsd(step.costUsd)}</dd>
        </div>
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

function CostCard({ run }: { run: RunSnapshot }) {
  const share = costShare(run);
  const cap = run.costCapUsd;
  const nearCap = share !== null && share >= 0.8;
  return (
    <section aria-labelledby="run-cost-heading" className="flex flex-col gap-2">
      <h2 id="run-cost-heading" className="text-lg font-semibold">
        Cost
      </h2>
      <p className="text-2xl font-bold">
        {formatUsd(run.costUsd)}
        {cap !== null && (
          <span className="text-base font-normal text-base-content/70">
            {' '}
            of {formatUsd(cap)} cap
          </span>
        )}
      </p>
      {share !== null && (
        <progress
          className={`progress w-full ${nearCap ? 'progress-error' : 'progress-primary'}`}
          value={Math.round(share * 100)}
          max={100}
          aria-label="Run cost against the cap"
        />
      )}
      {nearCap && cap !== null && (
        <p className="text-sm text-error">
          {share >= 1 ? 'The run has reached its cost cap.' : 'The run is close to its cost cap.'}
        </p>
      )}
    </section>
  );
}

function GateNotice({ gate, runId }: { gate: NonNullable<RunSnapshot['gate']>; runId: string }) {
  return (
    <div
      role="region"
      aria-label="Review needed"
      className="flex flex-col gap-2 rounded-box border border-secondary p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{gateLabel(gate)}</h2>
        {gate === 'fact_conflicts' ? (
          <Link href={conflictsPageHref(runId)} className="btn btn-primary min-h-11">
            Review conflicts
          </Link>
        ) : (
          // The Gate 2 page arrives with P4-07; plain text avoids a dead link.
          <span className="badge badge-outline">Review screen coming soon</span>
        )}
      </div>
      <p className="text-sm text-base-content/70">
        The run is paused until you finish this review.
      </p>
    </div>
  );
}

function announcement(run: RunSnapshot): string {
  switch (run.status) {
    case 'queued':
      return 'Run queued.';
    case 'running': {
      const step = run.steps.find((s) => s.stepId === run.currentStepId);
      return step ? `Running step ${step.stepId}.` : 'Run in progress.';
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

export function RunMonitorView({ monitor, runId }: { monitor: RunMonitorState; runId: string }) {
  const run = monitor.snapshot.data;
  if (run === undefined) return <RunLoadState monitor={monitor} runId={runId} />;

  const badge = RUN_BADGES[run.status];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="card-title text-2xl">Run</h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge ${badge.className}`}>
            {run.status === 'running' && (
              <span className="loading loading-spinner loading-xs" aria-hidden />
            )}
            {badge.label}
          </span>
          <span className="truncate text-sm text-base-content/70">{runId}</span>
        </div>
        {/* Announces transitions only; cost ticks are deliberately not in here. */}
        <p aria-live="polite" className="sr-only">
          {announcement(run)}
        </p>
      </div>

      <StreamNotice state={monitor.streamState} onRetry={monitor.retryStream} />
      {monitor.sessionExpired ? (
        <SessionExpired runId={runId} />
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

      {run.status === 'failed' && (
        <div role="alert" className="alert alert-error">
          <div>
            <h2 className="font-semibold">The run failed</h2>
            <p className="text-sm">{run.failureReason ?? 'No reason was recorded.'}</p>
          </div>
        </div>
      )}
      {run.status === 'awaiting_gate' && run.gate !== null && (
        <GateNotice gate={run.gate} runId={runId} />
      )}
      {run.export !== null && (
        <div role="status" className="alert alert-success">
          <span>
            Export ready: {run.export.fileCount} files
            {run.export.readyToPublish ? '' : ' (not yet ready to publish)'}.
          </span>
          <Link href={`/runs/${runId}/pack`} className="btn min-h-11">
            View pack
          </Link>
        </div>
      )}

      <CostCard run={run} />

      <section aria-labelledby="run-steps-heading" className="flex flex-col gap-3">
        <h2 id="run-steps-heading" className="text-lg font-semibold">
          Steps
        </h2>
        <ol className="flex flex-col gap-2">
          {run.steps.map((step) => (
            <StepItem key={step.stepId} step={step} cap={run.maxExecutionsPerAttempt} />
          ))}
        </ol>
      </section>
    </div>
  );
}

function SessionExpired({ runId }: { runId: string | null }) {
  return (
    <div role="alert" className="alert alert-warning">
      <span>Your session has expired.</span>
      <Link
        href={withNext('/login', runId === null ? '/projects' : `/runs/${runId}`)}
        className="btn min-h-11"
      >
        Log in again
      </Link>
    </div>
  );
}

function RunLoadState({ monitor, runId }: { monitor: RunMonitorState; runId: string | null }) {
  const { error, isError, refetch } = monitor.snapshot;
  if (!isError) {
    return (
      <div role="status" className="flex items-center gap-3 text-base-content/70">
        <span className="loading loading-spinner" aria-hidden />
        <span>Loading the run…</span>
      </div>
    );
  }
  if (error instanceof ApiRequestError && error.status === 404) {
    return <RunNotFound />;
  }
  if (error instanceof ApiRequestError && error.status === 401) {
    return <SessionExpired runId={runId} />;
  }
  return (
    <div role="alert" className="alert alert-error">
      <span>We could not load this run. Check your connection and try again.</span>
      <button type="button" className="btn min-h-11" onClick={() => void refetch()}>
        Try again
      </button>
    </div>
  );
}

export function RunNotFound() {
  return (
    <div role="alert" className="alert alert-warning">
      <span>This run was not found. It may belong to another account or no longer exist.</span>
    </div>
  );
}
