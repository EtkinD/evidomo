import type {
  Gate,
  RunSnapshot,
  RunStepSnapshot,
  RunStreamEnd,
  RunStreamEvent,
} from '@evidomo/shared';

export const runQueryKey = (runId: string) => ['runs', runId] as const;

function mapStep(
  snapshot: RunSnapshot,
  stepId: string,
  update: (step: RunStepSnapshot) => RunStepSnapshot,
): RunSnapshot {
  if (!snapshot.steps.some((step) => step.stepId === stepId)) return snapshot;
  return {
    ...snapshot,
    steps: snapshot.steps.map((step) => (step.stepId === stepId ? update(step) : step)),
  };
}

/**
 * Events whose effect only a fresh snapshot can describe (the export summary, a gate release).
 * Their payloads carry no more than counts and IDs.
 */
export function eventNeedsSnapshot(event: RunStreamEvent): boolean {
  return event.type === 'pack_exported' || event.type === 'gate_decided';
}

/**
 * Applies one stream event to a snapshot. Pure and idempotent: an event at or below the
 * snapshot's `lastEventSeq` is already reflected in it and is ignored, and cost values are
 * absolute totals, so replaying an event can never double-count.
 *
 * Returns `null` when the snapshot cannot be advanced by this event alone (a gap in the sequence);
 * the caller refetches then.
 */
export function applyRunEvent(snapshot: RunSnapshot, event: RunStreamEvent): RunSnapshot | null {
  if (event.seq <= snapshot.lastEventSeq) return snapshot;
  if (event.seq > snapshot.lastEventSeq + 1) return null;

  const next: RunSnapshot = { ...snapshot, lastEventSeq: event.seq, updatedAt: event.occurredAt };

  switch (event.type) {
    case 'run_status_changed': {
      const { to, gate, reason } = event.payload;
      const terminal = to === 'completed' || to === 'failed';
      return {
        ...next,
        status: to,
        gate: to === 'awaiting_gate' ? (gate ?? null) : null,
        failureReason: to === 'failed' ? (reason ?? 'The run failed.') : null,
        currentStepId: terminal ? null : next.currentStepId,
        startedAt: next.startedAt ?? (to === 'running' ? event.occurredAt : null),
        finishedAt: terminal ? event.occurredAt : null,
      };
    }
    case 'step_started': {
      const { stepId, attempt, execution } = event.payload;
      const started = mapStep(next, stepId, (step) => ({
        ...step,
        status: 'running',
        attempt,
        attempts: Math.max(step.attempts, attempt),
        executions: execution,
        startedAt:
          step.attempt === attempt && step.startedAt !== null ? step.startedAt : event.occurredAt,
        finishedAt: null,
        // The previous execution's failure no longer describes what is running now.
        error: null,
      }));
      return { ...started, currentStepId: stepId };
    }
    case 'step_completed': {
      const { stepId, stepCostUsd, runCostUsd } = event.payload;
      return {
        ...mapStep(next, stepId, (step) => ({
          ...step,
          status: 'completed',
          costUsd: stepCostUsd,
          finishedAt: event.occurredAt,
          error: null,
        })),
        costUsd: runCostUsd,
      };
    }
    case 'step_failed': {
      const { stepId, reason, willRetry, stepCostUsd, runCostUsd } = event.payload;
      return {
        ...mapStep(next, stepId, (step) => ({
          ...step,
          // A retried execution waits in the queue; only the final failure ends the step.
          status: willRetry ? 'queued' : 'failed',
          costUsd: stepCostUsd,
          finishedAt: willRetry ? null : event.occurredAt,
          error: reason,
        })),
        costUsd: runCostUsd,
      };
    }
    case 'usage_recorded': {
      const { stepId, stepCostUsd, runCostUsd } = event.payload;
      return {
        ...mapStep(next, stepId, (step) => ({ ...step, costUsd: stepCostUsd })),
        costUsd: runCostUsd,
      };
    }
    case 'gate_opened':
      return { ...next, gate: event.payload.gate };
    default:
      // Known events with no monitor state (counts for other screens): only the cursor moves.
      return next;
  }
}

/**
 * Applies the stream's `end` message: the run is terminal and every event up to `lastEventSeq`
 * was delivered, so the cache can show the final state before the confirming snapshot lands.
 */
export function applyRunEnd(snapshot: RunSnapshot, end: RunStreamEnd): RunSnapshot {
  return {
    ...snapshot,
    status: end.status,
    gate: null,
    currentStepId: null,
    failureReason: end.status === 'failed' ? (snapshot.failureReason ?? 'The run failed.') : null,
    finishedAt: snapshot.finishedAt ?? snapshot.updatedAt,
    lastEventSeq: Math.max(snapshot.lastEventSeq, end.lastEventSeq),
  };
}

const GATE_LABELS: Record<Gate, string> = {
  fact_conflicts: 'Gate 1: resolve fact conflicts',
  claim_audit: 'Gate 2: review the pack',
};

export function gateLabel(gate: Gate): string {
  return GATE_LABELS[gate];
}

/** Exact decimal string to a display amount. Display only; the strings stay the source of truth. */
export function formatUsd(amount: string): string {
  return `$${Number(amount).toFixed(4)}`;
}

/** Share of the cap spent, 0–1, or null without a cap. */
export function costShare(snapshot: Pick<RunSnapshot, 'costUsd' | 'costCapUsd'>): number | null {
  if (snapshot.costCapUsd === null) return null;
  const cap = Number(snapshot.costCapUsd);
  if (cap <= 0) return null;
  return Math.min(1, Number(snapshot.costUsd) / cap);
}

export function formatDuration(startedAt: string | null, finishedAt: string | null): string | null {
  if (startedAt === null || finishedAt === null) return null;
  const seconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
