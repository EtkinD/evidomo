import type { PgBoss } from 'pg-boss';
import { z } from 'zod';

// pg-boss queues of the run engine (docs/architecture.md §9).
//
// `run-step` uses the `exclusive` policy: at most one created, retry, or active job per
// singletonKey, and the key is the idempotency key `run_id:step_id:attempt`, so a duplicate
// enqueue of the same attempt is rejected by pg-boss (send resolves null). The run_steps row is
// the authority, though: only the job recorded there may execute the attempt.
//
// Jobs that exhaust their pg-boss retries without the engine settling the run (repeated
// crashes, a database outage during failure handling) land in `run-step-dead`, whose handler
// fails the run so it never stays `running` without a job.

export const RUN_STEP_QUEUE = 'run-step';
export const RUN_STEP_DEAD_LETTER_QUEUE = 'run-step-dead';

/**
 * Handler executions per attempt: the first plus one retry for a transient failure. A crash or
 * an interruption counts as an execution, because the step may already have spent money.
 */
export const MAX_STEP_EXECUTIONS = 2;

export const stepJobDataSchema = z.strictObject({
  runId: z.uuid(),
  stepId: z.string().min(1),
  attempt: z.int().positive(),
});
export type StepJobData = z.infer<typeof stepJobDataSchema>;

export function stepIdempotencyKey(data: StepJobData): string {
  return `${data.runId}:${data.stepId}:${data.attempt}`;
}

export interface StepJobTiming {
  /** The engine's own timeout for one handler execution. */
  readonly timeoutMs: number;
  /** pg-boss hard limit beyond the step timeout, so the engine always times out first. */
  readonly expiryGraceSeconds: number;
  /** Heartbeat interval (≥ 10 s): a crashed worker's job is retried after this, not at expiry. */
  readonly heartbeatSeconds: number;
  readonly retryDelaySeconds: number;
}

/** Per-job pg-boss options for one step attempt. */
export function stepJobOptions(timing: StepJobTiming): {
  retryLimit: number;
  retryDelay: number;
  expireInSeconds: number;
  heartbeatSeconds: number;
} {
  return {
    // One delivery per allowed execution, plus one so that a delivery after a crash of the last
    // execution can still record the failure instead of leaving it to the dead letter queue.
    retryLimit: MAX_STEP_EXECUTIONS,
    retryDelay: timing.retryDelaySeconds,
    expireInSeconds: Math.ceil(timing.timeoutMs / 1000) + timing.expiryGraceSeconds,
    heartbeatSeconds: timing.heartbeatSeconds,
  };
}

/**
 * Creates both queues if missing (idempotent). Must run before the first send, in every process
 * that enqueues steps. `createQueue` leaves an existing queue's settings untouched; the timing
 * options that matter are set per job.
 */
export async function ensureRunQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(RUN_STEP_DEAD_LETTER_QUEUE, { policy: 'standard' });
  await boss.createQueue(RUN_STEP_QUEUE, {
    policy: 'exclusive',
    deadLetter: RUN_STEP_DEAD_LETTER_QUEUE,
    // Wakes workers through LISTEN/NOTIFY when the boss enables it; polling stays the floor.
    notify: true,
  });
}
