import {
  computeCostUsd,
  findModelPrice,
  formatDecimalCeil,
  PRICE_TABLE,
  usdAmountSchema,
  type PriceTable,
} from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import {
  recordUsage,
  type NewUsage,
  type UsageEntry as UsageRow,
} from '../db/repositories/usage.ts';
import type { CostEstimator, UsageEntry, UsageRecorder } from '../meta/usage.ts';
import { checkBudget, type BudgetStatus } from './budget.ts';

// The usage ledger behind the Meta clients' `UsageRecorder`. `record()` must stay synchronous
// (the AI SDK swallows errors thrown in its callbacks), so entries are buffered in memory and
// persisted by `flush()` after the SDK call returns. `meter()` wraps one model call:
// price check → budget check → call → flush.
//
// One ledger per step execution: the Meta clients bind one recorder at construction, so the
// worker builds clients with a fresh ledger for each step and every entry carries that step's
// run and step IDs.

export class UsageLedgerError extends Error {
  override name = 'UsageLedgerError';
}

/**
 * A budget cap is not a valid USD amount. A configuration error: every attempt would fail the
 * same way. The message names the cap but not its value, because it becomes a run's failure
 * reason.
 */
export class InvalidBudgetCapError extends UsageLedgerError {
  override name = 'InvalidBudgetCapError';
  readonly cap: 'daily' | 'run';

  constructor(cap: 'daily' | 'run') {
    super(
      `The ${cap === 'daily' ? 'daily (DAILY_BUDGET_USD)' : 'per-run'} budget cap is not a valid USD amount (up to 4 integer and 8 fraction digits)`,
    );
    this.cap = cap;
  }
}

/** Validates a budget cap; throws {@link InvalidBudgetCapError} instead of a `ZodError`. */
export function parseBudgetCapUsd(cap: 'daily' | 'run', value: string): string {
  const parsed = usdAmountSchema.safeParse(value);
  if (!parsed.success) throw new InvalidBudgetCapError(cap);
  return parsed.data;
}

/** The model has no price; refused before the call so no unmetered money is spent. */
export class UnpricedModelError extends UsageLedgerError {
  override name = 'UnpricedModelError';
  readonly modelId: string;

  constructor(modelId: string) {
    super(`Model "${modelId}" is not in the price table; refusing an unmetered call`);
    this.modelId = modelId;
  }
}

export interface UsageProblem {
  readonly modelId: string;
  readonly reason: 'unknown_model' | 'missing_units' | 'invalid_units';
  readonly fields: readonly string[];
}

/**
 * Calls completed but could not be priced (unknown response model, or the API did not report
 * the billable units). Pricing them as zero would silently stop them counting toward the caps,
 * so this fails loudly instead. Every priceable entry of the same flush is persisted first.
 */
export class UnpricedUsageError extends UsageLedgerError {
  override name = 'UnpricedUsageError';
  readonly problems: readonly UsageProblem[];
  readonly persisted: readonly UsageRow[];

  constructor(problems: readonly UsageProblem[], persisted: readonly UsageRow[]) {
    const summary = problems
      .map(
        (p) => `${p.modelId} (${p.reason}${p.fields.length > 0 ? `: ${p.fields.join(', ')}` : ''})`,
      )
      .join('; ');
    super(`${problems.length} model call(s) could not be priced: ${summary}`);
    this.problems = problems;
    this.persisted = persisted;
  }
}

/** Writing ledger rows failed. The entries stay buffered, so a later `flush()` can retry. */
export class UsagePersistenceError extends UsageLedgerError {
  override name = 'UsagePersistenceError';
  readonly entryCount: number;

  constructor(entryCount: number, cause: unknown) {
    super(`Failed to persist ${entryCount} usage ledger entr${entryCount === 1 ? 'y' : 'ies'}`, {
      cause,
    });
    this.entryCount = entryCount;
  }
}

export interface UsageLedgerOptions {
  readonly db: Executor;
  /** `null` for calls outside a run (e.g. evaluation); they still count toward the daily cap. */
  readonly runId: string | null;
  readonly stepId: string | null;
  /** `DAILY_BUDGET_USD`. */
  readonly dailyCapUsd: string;
  /** Per-run cap from the service definition; requires `runId`. */
  readonly runCapUsd?: string | undefined;
  /** Defaults to the shared {@link PRICE_TABLE}; tests pass fake prices. */
  readonly prices?: PriceTable;
  /** Clock for the daily window; defaults to the system clock. */
  readonly now?: () => Date;
}

export interface UsageLedger extends UsageRecorder {
  /** Entries recorded but not yet persisted. */
  readonly pendingCount: number;
  /**
   * Persists every buffered entry in one transaction, with its exact cost from the price
   * table. Throws {@link UsagePersistenceError} (entries stay buffered) or
   * {@link UnpricedUsageError} (after persisting the priceable entries).
   */
  flush(): Promise<UsageRow[]>;
  /** Throws `BudgetExceededError` when the run or daily cap has been reached. */
  checkBudget(): Promise<BudgetStatus>;
  /**
   * Runs one model call under the ledger: refuses unpriced models and exhausted budgets before
   * the call, and persists the call's usage afterwards, also when the call throws (a call that
   * fails after the model answered, e.g. on output parsing, has still been billed).
   */
  meter<T>(modelId: string, call: () => Promise<T>): Promise<T>;
}

const UNIT_FIELDS = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'audioDurationMs',
  'images',
] as const;

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Reported values that cannot be stored: negative, fractional, or non-finite. */
function invalidFields(entry: UsageEntry): string[] {
  const invalid: string[] = UNIT_FIELDS.filter((field) => {
    const value = entry[field];
    return value !== undefined && !isCount(value);
  });
  if (!Number.isFinite(entry.latencyMs) || entry.latencyMs < 0) invalid.push('latencyMs');
  return invalid;
}

function toNewUsage(
  entry: UsageEntry,
  costUsd: string,
  runId: string | null,
  stepId: string | null,
): NewUsage {
  return {
    runId,
    stepId,
    modelId: entry.modelId,
    // Units outside the model's billing kind may be unreported; the columns store 0 then.
    inputTokens: entry.inputTokens ?? 0,
    outputTokens: entry.outputTokens ?? 0,
    reasoningTokens: entry.reasoningTokens ?? 0,
    audioSeconds:
      entry.audioDurationMs === undefined
        ? '0'
        : formatDecimalCeil({ units: BigInt(entry.audioDurationMs), scale: 3 }, 3),
    images: entry.images ?? 0,
    estimatedCostUsd: costUsd,
    latencyMs: Math.round(entry.latencyMs),
  };
}

export function createUsageLedger(options: UsageLedgerOptions): UsageLedger {
  const { db, runId, stepId } = options;
  const prices = options.prices ?? PRICE_TABLE;
  const now = options.now ?? (() => new Date());
  const dailyCapUsd = parseBudgetCapUsd('daily', options.dailyCapUsd);
  if (options.runCapUsd !== undefined && runId === null) {
    throw new UsageLedgerError('A run budget cap requires a run ID');
  }
  const run =
    options.runCapUsd === undefined || runId === null
      ? undefined
      : { runId, capUsd: parseBudgetCapUsd('run', options.runCapUsd) };

  const buffer: UsageEntry[] = [];

  async function flush(): Promise<UsageRow[]> {
    // Taken synchronously, so a concurrent flush never persists the same entry twice.
    const batch = buffer.splice(0);
    if (batch.length === 0) return [];

    const priced: NewUsage[] = [];
    const problems: UsageProblem[] = [];
    for (const entry of batch) {
      const invalid = invalidFields(entry);
      if (invalid.length > 0) {
        problems.push({ modelId: entry.modelId, reason: 'invalid_units', fields: invalid });
        continue;
      }
      const cost = computeCostUsd(prices, entry.modelId, entry);
      if (cost.ok) {
        priced.push(toNewUsage(entry, cost.costUsd, runId, stepId));
      } else {
        problems.push({
          modelId: entry.modelId,
          reason: cost.reason,
          fields: cost.reason === 'unknown_model' ? [] : cost.fields,
        });
      }
    }

    let rows: UsageRow[] = [];
    if (priced.length > 0) {
      try {
        rows = await db.transaction(async (tx) => {
          const inserted: UsageRow[] = [];
          for (const usage of priced) inserted.push(await recordUsage(tx, usage));
          return inserted;
        });
      } catch (error) {
        // Nothing was written; keep the whole batch so a retry re-prices and re-reports it.
        buffer.unshift(...batch);
        throw new UsagePersistenceError(priced.length, error);
      }
    }
    if (problems.length > 0) throw new UnpricedUsageError(problems, rows);
    return rows;
  }

  async function guard(): Promise<BudgetStatus> {
    return checkBudget(db, { dailyCapUsd, run, now: now() });
  }

  return {
    get pendingCount() {
      return buffer.length;
    },
    record(entry) {
      buffer.push(entry);
    },
    flush,
    checkBudget: guard,
    async meter(modelId, call) {
      if (findModelPrice(prices, modelId) === undefined) throw new UnpricedModelError(modelId);
      await guard();
      let result: Awaited<ReturnType<typeof call>>;
      try {
        result = await call();
      } catch (callError) {
        try {
          await flush();
        } catch (flushError) {
          throw new AggregateError(
            [callError, flushError],
            'The model call failed and its usage could not be recorded',
            { cause: flushError },
          );
        }
        throw callError;
      }
      await flush();
      return result;
    },
  };
}

/**
 * A `CostEstimator` for the Meta clients' display/log value, derived from the same exact
 * computation the ledger persists. Token-billed models only (the estimator sees token usage);
 * `undefined` otherwise.
 */
export function createPriceTableCostEstimator(prices: PriceTable = PRICE_TABLE): CostEstimator {
  return (usage) => {
    const cost = computeCostUsd(prices, usage.modelId, usage);
    return cost.ok ? Number(cost.costUsd) : undefined;
  };
}
