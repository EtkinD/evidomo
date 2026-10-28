import { randomUUID } from 'node:crypto';
import {
  gateOpenedPayloadSchema,
  stepCompletedPayloadSchema,
  stepFailedPayloadSchema,
  stepStartedPayloadSchema,
  usageRecordedPayloadSchema,
  type Gate,
  type PriceTable,
  type ServiceDefinition,
  type ServiceStep,
  type StepAgent,
  type StepFailedPayload,
} from '@evidomo/shared';
import { sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import type { Executor } from '../db/client.ts';
import { GateNotOpenError, InvalidRunTransitionError, NotFoundError } from '../db/errors.ts';
import { appendRunEvent } from '../db/repositories/run-events.ts';
import {
  claimRunStep,
  completeRunStep,
  createRunStep,
  failOpenRunSteps,
  getRunStepForUpdate,
  listCompletedRunSteps,
  nextRunStepAttempt,
  releaseRunStepGate,
  requeueRunStep,
  type RunStep,
  type RunStepKey,
} from '../db/repositories/run-steps.ts';
import {
  getRun,
  lockRun,
  setRunCurrentStep,
  transitionRun,
  type Run,
} from '../db/repositories/runs.ts';
import { getRunCostUsd, getRunStepCostUsd } from '../db/repositories/usage.ts';
import { DefinitionNotFoundError, type DefinitionRegistry } from '../definitions/loader.ts';
import type { Logger } from '../logger.ts';
import type { MetaClients } from '../meta/clients.ts';
import type { UsageRecorder } from '../meta/usage.ts';
import { createUsageLedger, UnpricedUsageError, type UsageLedger } from '../usage/ledger.ts';
import {
  ensureRunQueues,
  MAX_STEP_EXECUTIONS,
  RUN_STEP_DEAD_LETTER_QUEUE,
  RUN_STEP_QUEUE,
  stepIdempotencyKey,
  stepJobDataSchema,
  stepJobOptions,
  type StepJobData,
} from './queue.ts';
import {
  describeStepError,
  isRetryableStepError,
  MissingStepHandlerError,
  NonRetryableStepError,
  StepInterruptedError,
  StepRetryError,
  StepTimeoutError,
  type StepContext,
  type StepHandler,
  type StepHandlers,
  type StepLedger,
  type StepResult,
} from './steps.ts';

// The run state machine on pg-boss (docs/architecture.md §9).
//
// - Every state change and every enqueue happens in one transaction: jobs are sent through the
//   caller's Drizzle transaction (`fromDrizzle`), so a rollback also removes the job.
// - `run_steps` is the idempotency record. A job executes an attempt only if the row names that
//   job, the attempt is still open, and the delivery is newer than the one holding the claim.
// - A step's result commits together with its completion and with whatever comes next (next
//   step enqueued, gate opened, or run completed), fenced by the claim: a superseded execution
//   can neither complete nor fail the attempt.

export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_EXPIRY_GRACE_SECONDS = 60;
export const DEFAULT_HEARTBEAT_SECONDS = 30;
export const DEFAULT_RETRY_DELAY_SECONDS = 5;
export const DEFAULT_POLLING_INTERVAL_SECONDS = 2;

export interface RunEngineOptions {
  /** The pool-backed database; every engine operation opens its own transaction on it. */
  readonly db: Executor;
  readonly boss: PgBoss;
  readonly registry: Pick<DefinitionRegistry, 'getService' | 'services'>;
  readonly logger: Logger;
  /** `DAILY_BUDGET_USD`. The run cap comes from the service definition. */
  readonly dailyCapUsd: string;
  readonly handlers?: StepHandlers;
  /** Builds Meta clients bound to one execution's ledger. Without it, `metaClients()` fails. */
  readonly createMetaClients?: (usage: UsageRecorder) => MetaClients;
  /** Defaults to the shared price table; tests pass fake prices. */
  readonly prices?: PriceTable;
  readonly stepTimeoutMs?: number | ((step: ServiceStep) => number);
  readonly expiryGraceSeconds?: number;
  readonly heartbeatSeconds?: number;
  readonly retryDelaySeconds?: number;
}

/** The parts of a pg-boss job the engine reads. */
export interface StepJob {
  readonly id: string;
  readonly retryCount: number;
  readonly data: unknown;
  readonly signal: AbortSignal;
}

export type StepSkipReason =
  | 'invalid_payload'
  | 'run_missing'
  | 'step_missing'
  | 'duplicate_job'
  | 'already_completed'
  | 'attempt_closed'
  | 'claimed_elsewhere'
  | 'run_not_running';

export type StepJobOutcome =
  | { readonly outcome: 'completed' }
  | { readonly outcome: 'run_failed' }
  | { readonly outcome: 'superseded' }
  | { readonly outcome: 'skipped'; readonly reason: StepSkipReason };

export interface TxOption {
  /** Join the caller's transaction (e.g. P2-10 records the last decision and resumes at once). */
  readonly tx?: Executor;
}

export interface StartWorkersOptions {
  readonly localConcurrency?: number;
  readonly pollingIntervalSeconds?: number;
}

export interface RunEngine {
  /** Creates the queues; required once per process before any enqueue. */
  ensureQueues(): Promise<void>;
  /** Registers the pg-boss workers for step jobs and dead-lettered step jobs. */
  startWorkers(options?: StartWorkersOptions): Promise<void>;
  /** `queued → running` and enqueues the first step that has not completed. */
  startRun(runId: string, options?: TxOption): Promise<Run>;
  /** `failed → queued → running`; completed steps are skipped, the failed one gets a new attempt. */
  resumeRun(runId: string, options?: TxOption): Promise<Run>;
  /** `awaiting_gate → running` and enqueues the next step (or completes the run). */
  resumeAfterGate(runId: string, options?: TxOption & { readonly gate?: Gate }): Promise<Run>;
  /** The step-job handler; exposed so tests can drive deliveries directly. */
  processStepJob(job: StepJob): Promise<StepJobOutcome>;
  /** The dead-letter handler: fails a run whose step job ran out of pg-boss retries. */
  processDeadStepJob(job: Pick<StepJob, 'id' | 'data'>): Promise<'run_failed' | 'skipped'>;
}

type Claim =
  | { readonly kind: 'skip'; readonly reason: StepSkipReason }
  | { readonly kind: 'run_failed' }
  | {
      readonly kind: 'claimed';
      readonly run: Run;
      readonly service: ServiceDefinition;
      readonly step: ServiceStep;
      readonly execution: number;
    };

type Execution =
  | { readonly ok: true; readonly result: StepResult | undefined }
  | { readonly ok: false; readonly error: unknown };

function isCurrentClaim(
  run: Run | undefined,
  row: RunStep | undefined,
  job: Pick<StepJob, 'id' | 'retryCount'>,
): row is RunStep {
  return (
    run?.status === 'running' &&
    row?.status === 'running' &&
    row.jobId === job.id &&
    row.jobRetryCount === job.retryCount
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Calls the agent's handler with a context typed for that agent's step configuration. */
function invokeHandler(
  handlers: StepHandlers,
  step: ServiceStep,
  base: Omit<StepContext, 'step'>,
): Promise<StepResult | undefined> {
  function call<A extends StepAgent>(
    handler: StepHandler<A> | undefined,
    context: StepContext<A>,
  ): Promise<StepResult | undefined> {
    if (handler === undefined) throw new MissingStepHandlerError(step.agent);
    return handler(context);
  }
  switch (step.agent) {
    case 'intake':
      return call<'intake'>(handlers.intake, { ...base, step });
    case 'extractor':
      return call<'extractor'>(handlers.extractor, { ...base, step });
    case 'vision':
      return call<'vision'>(handlers.vision, { ...base, step });
    case 'reconciler':
      return call<'reconciler'>(handlers.reconciler, { ...base, step });
    case 'creative':
      return call<'creative'>(handlers.creative, { ...base, step });
    case 'qa_writer':
      return call<'qa_writer'>(handlers.qa_writer, { ...base, step });
    case 'integrity_checker':
      return call<'integrity_checker'>(handlers.integrity_checker, {
        ...base,
        step,
      });
    case 'verifier':
      return call<'verifier'>(handlers.verifier, { ...base, step });
    case 'exporter':
      return call<'exporter'>(handlers.exporter, { ...base, step });
    default: {
      const unreachable: never = step;
      throw new Error(`Unhandled step agent ${JSON.stringify(unreachable)}`);
    }
  }
}

export function createRunEngine(options: RunEngineOptions): RunEngine {
  const { db, boss, registry, logger } = options;
  const handlers: StepHandlers = options.handlers ?? {};
  const expiryGraceSeconds = options.expiryGraceSeconds ?? DEFAULT_EXPIRY_GRACE_SECONDS;
  const heartbeatSeconds = options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
  const retryDelaySeconds = options.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS;

  function timeoutFor(step: ServiceStep): number {
    const configured = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    return typeof configured === 'number' ? configured : configured(step);
  }

  function inTransaction<T>(
    outer: Executor | undefined,
    work: (tx: Executor) => Promise<T>,
  ): Promise<T> {
    return (outer ?? db).transaction(work);
  }

  async function costs(
    tx: Executor,
    runId: string,
    stepId: string,
  ): Promise<{ stepCostUsd: string; runCostUsd: string }> {
    return {
      stepCostUsd: await getRunStepCostUsd(tx, runId, stepId),
      runCostUsd: await getRunCostUsd(tx, runId),
    };
  }

  /** Schedules a new attempt of `step`: run_steps row, pg-boss job, and current step, in `tx`. */
  async function enqueueStep(tx: Executor, runId: string, step: ServiceStep): Promise<void> {
    const attempt = await nextRunStepAttempt(tx, runId, step.id);
    const data: StepJobData = { runId, stepId: step.id, attempt };
    const jobId = randomUUID();
    await createRunStep(tx, { ...data, jobId });
    const sent = await boss.send(RUN_STEP_QUEUE, data, {
      id: jobId,
      singletonKey: stepIdempotencyKey(data),
      ...stepJobOptions({
        timeoutMs: timeoutFor(step),
        expiryGraceSeconds,
        heartbeatSeconds,
        retryDelaySeconds,
      }),
      db: fromDrizzle(tx, sql),
    });
    if (sent === null) {
      // The attempt row was just created in this transaction, so no job can legitimately hold
      // its key yet; rolling back keeps row and job consistent.
      throw new Error(`pg-boss refused step job ${stepIdempotencyKey(data)} as a duplicate`);
    }
    await setRunCurrentStep(tx, runId, step.id);
  }

  /**
   * Decides what follows from the completed steps alone (never from memory): open the gate of
   * the first completed step whose gate has not been released, else enqueue the first step
   * without a completed attempt, else complete the run. The run must be `running`.
   */
  async function advance(tx: Executor, runId: string, service: ServiceDefinition): Promise<void> {
    const completed = new Map(
      (await listCompletedRunSteps(tx, runId)).map((row) => [row.stepId, row]),
    );
    for (const step of service.steps) {
      const done = completed.get(step.id);
      if (done === undefined) {
        await enqueueStep(tx, runId, step);
        return;
      }
      if (step.gate_after !== undefined && done.gateReleasedAt === null) {
        await transitionRun(tx, runId, { to: 'awaiting_gate', gate: step.gate_after });
        await appendRunEvent(tx, runId, {
          type: 'gate_opened',
          payload: gateOpenedPayloadSchema.parse({ gate: step.gate_after, stepId: step.id }),
        });
        return;
      }
    }
    await transitionRun(tx, runId, { to: 'completed' });
  }

  /** Fails the run and closes its open attempts; `stepFailed` adds the step's own event. */
  async function failRun(
    tx: Executor,
    runId: string,
    reason: string,
    stepFailed?: Omit<StepFailedPayload, 'willRetry' | 'reason' | 'stepCostUsd' | 'runCostUsd'>,
  ): Promise<void> {
    await failOpenRunSteps(tx, runId, reason);
    if (stepFailed !== undefined) {
      await appendRunEvent(tx, runId, {
        type: 'step_failed',
        payload: stepFailedPayloadSchema.parse({
          ...stepFailed,
          reason,
          willRetry: false,
          ...(await costs(tx, runId, stepFailed.stepId)),
        }),
      });
    }
    await transitionRun(tx, runId, { to: 'failed', reason });
  }

  async function startLocked(tx: Executor, run: Run): Promise<Run> {
    const service = registry.getService(run.serviceId, run.serviceVersion);
    await transitionRun(tx, run.id, { to: 'running' });
    await advance(tx, run.id, service);
    const current = await getRun(tx, run.id);
    if (current === undefined) throw new NotFoundError('run', run.id);
    return current;
  }

  async function claim(job: StepJob, data: StepJobData): Promise<Claim> {
    const key: RunStepKey = data;
    return db.transaction(async (tx): Promise<Claim> => {
      const run = await lockRun(tx, data.runId);
      if (run === undefined) return { kind: 'skip', reason: 'run_missing' };
      const row = await getRunStepForUpdate(tx, key);
      if (row === undefined) return { kind: 'skip', reason: 'step_missing' };
      if (row.jobId !== job.id) return { kind: 'skip', reason: 'duplicate_job' };
      if (row.status === 'completed') return { kind: 'skip', reason: 'already_completed' };
      if (row.status === 'failed') return { kind: 'skip', reason: 'attempt_closed' };
      // Same job, not a newer delivery: pg-boss still considers the earlier claim alive.
      if (
        row.status === 'running' &&
        row.jobRetryCount !== null &&
        job.retryCount <= row.jobRetryCount
      ) {
        return { kind: 'skip', reason: 'claimed_elsewhere' };
      }
      if (run.status !== 'running') return { kind: 'skip', reason: 'run_not_running' };

      let service: ServiceDefinition;
      try {
        service = registry.getService(run.serviceId, run.serviceVersion);
      } catch (error) {
        if (!(error instanceof DefinitionNotFoundError)) throw error;
        await failRun(tx, run.id, error.message);
        return { kind: 'run_failed' };
      }
      const step = service.steps.find((candidate) => candidate.id === data.stepId);
      if (step === undefined) {
        await failRun(
          tx,
          run.id,
          `Step "${data.stepId}" is not part of ${service.id} v${service.version}`,
        );
        return { kind: 'run_failed' };
      }
      if (row.executions >= MAX_STEP_EXECUTIONS) {
        // Every allowed execution started and none settled: the worker died each time.
        await failRun(
          tx,
          run.id,
          `Step "${step.id}" was interrupted ${row.executions} times and was not retried again`,
          { stepId: step.id, attempt: data.attempt, execution: row.executions },
        );
        return { kind: 'run_failed' };
      }

      const claimed = await claimRunStep(tx, key, { jobId: job.id, retryCount: job.retryCount });
      await appendRunEvent(tx, run.id, {
        type: 'step_started',
        payload: stepStartedPayloadSchema.parse({
          stepId: step.id,
          attempt: data.attempt,
          execution: claimed.executions,
        }),
      });
      return { kind: 'claimed', run, service, step, execution: claimed.executions };
    });
  }

  async function execute(
    job: StepJob,
    claimed: Extract<Claim, { kind: 'claimed' }>,
    data: StepJobData,
    log: Logger,
  ): Promise<Execution> {
    const { run, service, step, execution } = claimed;
    const timeoutMs = timeoutFor(step);
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new StepTimeoutError(step.id, timeoutMs));
    }, timeoutMs);
    const signal = AbortSignal.any([job.signal, timeout.signal]);
    // Why the step stopped when the signal fired: our timeout, or pg-boss (shutdown, lost claim).
    const abortError = (): Error =>
      timeout.signal.aborted
        ? new StepTimeoutError(step.id, timeoutMs)
        : new StepInterruptedError(step.id);

    const ledger: UsageLedger = createUsageLedger({
      db,
      runId: run.id,
      stepId: step.id,
      dailyCapUsd: options.dailyCapUsd,
      runCapUsd: service.budget.max_cost_usd_per_run,
      ...(options.prices === undefined ? {} : { prices: options.prices }),
    });

    async function reportUsage(): Promise<void> {
      try {
        await appendRunEvent(db, run.id, {
          type: 'usage_recorded',
          payload: usageRecordedPayloadSchema.parse({
            stepId: step.id,
            ...(await costs(db, run.id, step.id)),
          }),
        });
      } catch (error) {
        // The call is paid and in the ledger; a missing progress event must not fail the step.
        log.warn({ errName: errorName(error) }, 'could not append usage_recorded event');
      }
    }

    const stepLedger: StepLedger = {
      async meter(modelId, call) {
        if (signal.aborted) throw abortError();
        let invoked = false;
        try {
          return await ledger.meter(modelId, () => {
            invoked = true;
            return call();
          });
        } finally {
          if (invoked) await reportUsage();
        }
      },
      checkBudget: () => ledger.checkBudget(),
    };

    let clients: MetaClients | undefined;
    const context: Omit<StepContext, 'step'> = {
      run,
      service,
      attempt: data.attempt,
      execution,
      db,
      ledger: stepLedger,
      metaClients() {
        if (options.createMetaClients === undefined) {
          throw new NonRetryableStepError('Meta clients are not configured for this worker');
        }
        clients ??= options.createMetaClients(ledger);
        return clients;
      },
      logger: log,
      signal,
    };

    let outcome: Execution;
    try {
      const pending = invokeHandler(handlers, step, context);
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(abortError());
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
      try {
        outcome = { ok: true, result: await Promise.race([pending, aborted]) };
      } finally {
        // A handler that ignores the signal keeps running detached; its result is discarded
        // and its writes cannot land (no commit, and the ledger refuses new calls).
        pending.catch((error: unknown) => {
          if (signal.aborted) log.debug({ errName: errorName(error) }, 'aborted handler settled');
        });
        aborted.catch(() => undefined);
      }
    } catch (error) {
      outcome = { ok: false, error: signal.aborted ? abortError() : error };
    } finally {
      clearTimeout(timer);
    }

    // Safety net for calls made outside `meter` (the clients still record into the ledger).
    try {
      await ledger.flush();
    } catch (flushError) {
      if (outcome.ok || flushError instanceof UnpricedUsageError) {
        outcome = { ok: false, error: flushError };
      } else {
        log.error(
          { errName: errorName(flushError), pending: ledger.pendingCount },
          'usage of a failed step execution could not be recorded',
        );
      }
    }
    return outcome;
  }

  async function settleSuccess(
    job: StepJob,
    claimed: Extract<Claim, { kind: 'claimed' }>,
    data: StepJobData,
    result: StepResult | undefined,
  ): Promise<'completed' | 'superseded'> {
    return db.transaction(async (tx) => {
      const run = await lockRun(tx, data.runId);
      const row = await getRunStepForUpdate(tx, data);
      if (!isCurrentClaim(run, row, job)) return 'superseded';
      const committed = result?.commit === undefined ? undefined : await result.commit(tx);
      const artifactIds = committed?.artifactIds ?? [];
      await completeRunStep(tx, data, artifactIds);
      await appendRunEvent(tx, data.runId, {
        type: 'step_completed',
        payload: stepCompletedPayloadSchema.parse({
          stepId: data.stepId,
          attempt: data.attempt,
          execution: row.executions,
          artifactIds: [...artifactIds],
          ...(await costs(tx, data.runId, data.stepId)),
        }),
      });
      await advance(tx, data.runId, claimed.service);
      return 'completed';
    });
  }

  async function settleFailure(
    job: StepJob,
    data: StepJobData,
    error: unknown,
  ): Promise<{ decision: 'retry' | 'run_failed' | 'superseded'; reason: string }> {
    const reason = describeStepError(error);
    const decision = await db.transaction(async (tx) => {
      const run = await lockRun(tx, data.runId);
      const row = await getRunStepForUpdate(tx, data);
      if (!isCurrentClaim(run, row, job)) return 'superseded';
      const ref = { stepId: data.stepId, attempt: data.attempt, execution: row.executions };
      if (isRetryableStepError(error) && row.executions < MAX_STEP_EXECUTIONS) {
        await requeueRunStep(tx, data, reason);
        await appendRunEvent(tx, data.runId, {
          type: 'step_failed',
          payload: stepFailedPayloadSchema.parse({
            ...ref,
            reason,
            willRetry: true,
            ...(await costs(tx, data.runId, data.stepId)),
          }),
        });
        return 'retry';
      }
      const attempts = row.executions === 1 ? '1 execution' : `${row.executions} executions`;
      await failRun(
        tx,
        data.runId,
        `Step "${data.stepId}" failed after ${attempts}: ${reason}`,
        ref,
      );
      return 'run_failed';
    });
    return { decision, reason };
  }

  async function processStepJob(job: StepJob): Promise<StepJobOutcome> {
    const parsed = stepJobDataSchema.safeParse(job.data);
    if (!parsed.success) {
      logger.error({ jobId: job.id }, 'step job with an invalid payload ignored');
      return { outcome: 'skipped', reason: 'invalid_payload' };
    }
    const data = parsed.data;
    const log = logger.child({
      runId: data.runId,
      stepId: data.stepId,
      attempt: data.attempt,
      jobId: job.id,
      delivery: job.retryCount,
    });

    const claimed = await claim(job, data);
    if (claimed.kind === 'skip') {
      log.info({ reason: claimed.reason }, 'step job skipped');
      return { outcome: 'skipped', reason: claimed.reason };
    }
    if (claimed.kind === 'run_failed') {
      log.warn('run failed before the step could execute');
      return { outcome: 'run_failed' };
    }

    const stepLog = log.child({ execution: claimed.execution });
    stepLog.info('step started');
    const executed = await execute(job, claimed, data, stepLog);

    let failure: unknown;
    if (executed.ok) {
      try {
        const settled = await settleSuccess(job, claimed, data, executed.result);
        if (settled === 'superseded') {
          stepLog.warn('step result discarded: a newer delivery holds the claim');
          return { outcome: 'superseded' };
        }
        stepLog.info('step completed');
        return { outcome: 'completed' };
      } catch (error) {
        failure = error;
      }
    } else {
      failure = executed.error;
    }

    const { decision, reason } = await settleFailure(job, data, failure);
    stepLog.warn({ errName: errorName(failure), reason, decision }, 'step failed');
    switch (decision) {
      case 'retry':
        throw new StepRetryError(reason);
      case 'run_failed':
        return { outcome: 'run_failed' };
      case 'superseded':
        return { outcome: 'superseded' };
      default: {
        const unreachable: never = decision;
        throw new Error(`Unhandled failure decision ${String(unreachable)}`);
      }
    }
  }

  async function processDeadStepJob(
    job: Pick<StepJob, 'id' | 'data'>,
  ): Promise<'run_failed' | 'skipped'> {
    const parsed = stepJobDataSchema.safeParse(job.data);
    if (!parsed.success) {
      logger.error({ jobId: job.id }, 'dead-lettered step job with an invalid payload ignored');
      return 'skipped';
    }
    const data = parsed.data;
    const result = await db.transaction(async (tx) => {
      const run = await lockRun(tx, data.runId);
      const row = await getRunStepForUpdate(tx, data);
      if (run === undefined || row === undefined) return 'skipped';
      if (row.status !== 'queued' && row.status !== 'running') return 'skipped';
      const reason = `Step "${data.stepId}" could not be recovered after repeated failures`;
      if (run.status !== 'running') {
        await failOpenRunSteps(tx, data.runId, reason);
        return 'skipped';
      }
      await failRun(
        tx,
        data.runId,
        reason,
        row.executions > 0
          ? { stepId: data.stepId, attempt: data.attempt, execution: row.executions }
          : undefined,
      );
      return 'run_failed';
    });
    logger.warn(
      { runId: data.runId, stepId: data.stepId, attempt: data.attempt, result },
      'dead-lettered step job handled',
    );
    return result;
  }

  return {
    ensureQueues: () => ensureRunQueues(boss),

    async startWorkers(workOptions = {}) {
      await ensureRunQueues(boss);
      const missing = new Set(
        registry.services.flatMap((service) =>
          service.steps.filter((step) => handlers[step.agent] === undefined).map((s) => s.agent),
        ),
      );
      if (missing.size > 0) {
        logger.warn({ agents: [...missing] }, 'no step handler registered for some agents');
      }
      const pollingIntervalSeconds =
        workOptions.pollingIntervalSeconds ?? DEFAULT_POLLING_INTERVAL_SECONDS;
      const work = {
        batchSize: 1,
        localConcurrency: workOptions.localConcurrency ?? 1,
        pollingIntervalSeconds,
        // NOTIFY wakes workers for new jobs only. A retry (after a failure, or after pg-boss
        // expires a crashed worker's job) sends none, so with the 30 s default notify backstop a
        // retry would idle up to 30 s. Poll at the base interval regardless.
        notifyPollingIntervalSeconds: pollingIntervalSeconds,
      };
      await boss.work(RUN_STEP_QUEUE, work, async (jobs) => {
        const outcomes: StepJobOutcome[] = [];
        for (const job of jobs) outcomes.push(await processStepJob(job));
        return outcomes;
      });
      await boss.work(RUN_STEP_DEAD_LETTER_QUEUE, work, async (jobs) => {
        for (const job of jobs) await processDeadStepJob(job);
      });
    },

    async startRun(runId, txOption = {}) {
      return inTransaction(txOption.tx, async (tx) => {
        const run = await lockRun(tx, runId);
        if (run === undefined) throw new NotFoundError('run', runId);
        return startLocked(tx, run);
      });
    },

    async resumeRun(runId, txOption = {}) {
      return inTransaction(txOption.tx, async (tx) => {
        const run = await lockRun(tx, runId);
        if (run === undefined) throw new NotFoundError('run', runId);
        const queued = await transitionRun(tx, runId, { to: 'queued' });
        return startLocked(tx, queued);
      });
    },

    async resumeAfterGate(runId, gateOptions = {}) {
      return inTransaction(gateOptions.tx, async (tx) => {
        const run = await lockRun(tx, runId);
        if (run === undefined) throw new NotFoundError('run', runId);
        if (run.status !== 'awaiting_gate' || run.gate === null) {
          throw new InvalidRunTransitionError(runId, run.status, 'running');
        }
        if (gateOptions.gate !== undefined && gateOptions.gate !== run.gate) {
          throw new GateNotOpenError(runId, gateOptions.gate);
        }
        const service = registry.getService(run.serviceId, run.serviceVersion);
        const completed = new Map(
          (await listCompletedRunSteps(tx, runId)).map((row) => [row.stepId, row]),
        );
        const gated = service.steps.find(
          (step) => step.gate_after === run.gate && completed.get(step.id)?.gateReleasedAt === null,
        );
        if (gated === undefined) {
          throw new Error(`Run ${runId} awaits gate ${run.gate} but no completed step holds it`);
        }
        await releaseRunStepGate(tx, runId, gated.id);
        await transitionRun(tx, runId, { to: 'running' });
        await advance(tx, runId, service);
        const current = await getRun(tx, runId);
        if (current === undefined) throw new NotFoundError('run', runId);
        return current;
      });
    },

    processStepJob,
    processDeadStepJob,
  };
}
