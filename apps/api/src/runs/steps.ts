import type { ServiceDefinition, ServiceStep, StepAgent } from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import type { Run } from '../db/repositories/runs.ts';
import { DefinitionNotFoundError } from '../definitions/loader.ts';
import type { Logger } from '../logger.ts';
import type { MetaClients } from '../meta/clients.ts';
import { BudgetExceededError, type BudgetStatus } from '../usage/budget.ts';
import { InvalidBudgetCapError, UnpricedModelError, UnpricedUsageError } from '../usage/ledger.ts';

// The contract between the run engine and step implementations (docs/architecture.md §9).
// Handlers are registered by `agent`; real ones arrive with P2-06 and later.

/** The usage ledger as a step sees it: model calls go through `meter`. */
export interface StepLedger {
  /**
   * Runs one model call: refuses unpriced models, exhausted budgets, and calls after the step
   * was aborted, then persists the call's usage. Every model call of a step goes through here.
   */
  meter<T>(modelId: string, call: () => Promise<T>): Promise<T>;
  checkBudget(): Promise<BudgetStatus>;
}

/** Each agent's step configuration, e.g. `StepConfig<'vision'>` has `max_evidence_masks`. */
export type StepConfigByAgent = { [S in ServiceStep as S['agent']]: S };
export type StepConfig<A extends StepAgent> = StepConfigByAgent[A];

export interface StepContext<A extends StepAgent = StepAgent> {
  /** The run as it was when this execution claimed the step. */
  readonly run: Run;
  readonly service: ServiceDefinition;
  /** This step's configuration from the service definition (model, effort, token cap, ...). */
  readonly step: StepConfig<A>;
  readonly attempt: number;
  /** 1 for the first execution of this attempt, 2 for its retry. */
  readonly execution: number;
  /**
   * For reads. Writes that make up the step's result belong in {@link StepResult.commit}, which
   * runs in the completion transaction: a superseded execution then cannot write anything.
   */
  readonly db: Executor;
  readonly ledger: StepLedger;
  /**
   * Meta clients bound to this execution's ledger, built on first use (they need
   * `MODEL_API_KEY`). Wrap each call in `ledger.meter(...)` and pass `signal` to it.
   */
  metaClients(): MetaClients;
  readonly logger: Logger;
  /** Aborted on the step timeout, on worker shutdown, and when pg-boss loses the job's claim. */
  readonly signal: AbortSignal;
}

export interface StepCommitResult {
  /** Artifacts written by `commit`; recorded on the step and in `step_completed`. */
  readonly artifactIds?: readonly string[];
  /**
   * The step's `gate_after` has nothing for a human to decide (e.g. reconciliation found no
   * conflicts): the engine releases the gate in the completion transaction and the run goes on.
   * Ignored for steps without `gate_after`.
   */
  readonly releaseGate?: boolean;
}

export interface StepResult {
  /**
   * Persists the step's output inside the transaction that marks the step completed and
   * schedules what comes next, so output and completion commit exactly once, together.
   */
  commit?(tx: Executor): Promise<StepCommitResult | undefined>;
}

export type StepHandler<A extends StepAgent = StepAgent> = (
  context: StepContext<A>,
) => Promise<StepResult | undefined>;

export type StepHandlers = { readonly [A in StepAgent]?: StepHandler<A> };

/**
 * A failure that a retry cannot fix (invalid input, a missing handler). The run fails at once.
 * `message` is shown to the operator and stored: no customer content, secrets, or model output.
 */
export class NonRetryableStepError extends Error {
  override name = 'NonRetryableStepError';
}

export class MissingStepHandlerError extends NonRetryableStepError {
  override name = 'MissingStepHandlerError';

  constructor(agent: string) {
    super(`No step handler is registered for agent "${agent}"`);
  }
}

export class StepTimeoutError extends Error {
  override name = 'StepTimeoutError';
  readonly timeoutMs: number;

  constructor(stepId: string, timeoutMs: number) {
    super(`Step "${stepId}" timed out after ${Math.round(timeoutMs / 1000)} s`);
    this.timeoutMs = timeoutMs;
  }
}

/** Worker shutdown, or pg-boss failed the job's claim (expired or heartbeat lost). */
export class StepInterruptedError extends Error {
  override name = 'StepInterruptedError';

  constructor(stepId: string) {
    super(`Step "${stepId}" was interrupted`);
  }
}

/** Thrown to pg-boss to request the retry; carries only the operator-safe reason. */
export class StepRetryError extends Error {
  override name = 'StepRetryError';
}

/**
 * Budget, budget-configuration, and pricing errors would fail the same way again (and a retry
 * could spend more), so they fail the run at once, as do explicit non-retryable step errors.
 * Everything else, including timeouts, interruptions, and unknown errors, is transient: the
 * attempt is retried once.
 */
export function isRetryableStepError(error: unknown): boolean {
  return !(
    error instanceof BudgetExceededError ||
    error instanceof InvalidBudgetCapError ||
    error instanceof UnpricedModelError ||
    error instanceof UnpricedUsageError ||
    error instanceof NonRetryableStepError ||
    error instanceof DefinitionNotFoundError
  );
}

/**
 * A description of a step failure that is safe to store, show, and log. Messages are used only
 * for errors whose text this codebase controls; any other error (SDK errors can carry request
 * bodies, validation errors can quote model output) is reduced to its class name.
 */
export function describeStepError(error: unknown): string {
  if (
    error instanceof StepTimeoutError ||
    error instanceof StepInterruptedError ||
    error instanceof BudgetExceededError ||
    error instanceof InvalidBudgetCapError ||
    error instanceof UnpricedModelError ||
    error instanceof NonRetryableStepError ||
    error instanceof DefinitionNotFoundError
  ) {
    return error.message;
  }
  if (error instanceof UnpricedUsageError) {
    return `Model usage could not be priced (${error.problems.map((p) => p.modelId).join(', ')})`;
  }
  if (error instanceof Error) return `Unexpected ${error.name}`;
  return 'Unexpected non-error failure';
}
