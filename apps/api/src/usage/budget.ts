import { compareDecimalStrings, usdAmountSchema } from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import { getCostUsdSince, getRunCostUsd } from '../db/repositories/usage.ts';
import { DEMO_OWNER_EMAIL } from '../demo/owner.ts';

// Budget caps are checked before every model call. The check reads committed ledger rows; it
// does not reserve the next call's cost (that cost is only known after the call returns), so
// calls that pass the check concurrently can overshoot a cap. The overshoot is bounded by the
// cost of the calls already in flight when the cap is crossed — see docs/architecture.md §10.

export type BudgetCapKind = 'run' | 'daily';

/** A cap has been reached; no further model calls may start. Not retryable. */
export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
  readonly kind: BudgetCapKind;
  /** The cap, as configured. */
  readonly limitUsd: string;
  /** Spend at the time of the check, 8 fraction digits. */
  readonly spentUsd: string;

  constructor(kind: BudgetCapKind, limitUsd: string, spentUsd: string) {
    super(
      kind === 'run'
        ? `Run budget cap reached: spent ${spentUsd} of ${limitUsd} USD`
        : `Global daily budget cap reached: spent ${spentUsd} of ${limitUsd} USD today (UTC)`,
    );
    this.kind = kind;
    this.limitUsd = limitUsd;
    this.spentUsd = spentUsd;
  }
}

// The amounts in a budget failure, and the budget configuration, are operator data
// (docs/architecture.md §10 "Cost visibility"). The exact message stays in the database
// (`runs.failure_reason`, `run_steps.error`, event payloads); a server that does not disclose
// run costs states these instead. The patterns are tied to `BudgetExceededError` and
// `InvalidBudgetCapError` (`ledger.ts`) by `budget.test.ts`.

/** A run budget failure as a user reads it. */
export const RUN_BUDGET_REACHED_REASON = 'This run reached its budget limit.';
/** A daily budget failure as a user reads it. */
export const DAILY_BUDGET_REACHED_REASON = "Today's budget for live runs is used up.";
/**
 * Stands in for a whole reason that names budget configuration (an invalid cap) or still names
 * an amount no rule above recognizes.
 */
export const UNDISCLOSED_FAILURE_REASON = 'The details of this failure are available to operators.';

const AMOUNT = '[0-9]+(?:\\.[0-9]+)?';
const RUN_CAP_MESSAGE = new RegExp(`Run budget cap reached: spent ${AMOUNT} of ${AMOUNT} USD`, 'g');
const DAILY_CAP_MESSAGE = new RegExp(
  `Global daily budget cap reached: spent ${AMOUNT} of ${AMOUNT} USD today \\(UTC\\)`,
  'g',
);
// Anything that still reads as money after the known messages are replaced: `3.00 USD`,
// `USD 3.00`, `$3`.
const LEFTOVER_AMOUNT = new RegExp(`${AMOUNT}\\s*USD\\b|\\bUSD\\s*[0-9]|\\$\\s*[0-9]`, 'i');
// `InvalidBudgetCapError`: names the env setting and how caps are configured.
const BUDGET_CONFIGURATION = /budget cap is not a valid USD amount|DAILY_BUDGET_USD/i;

/**
 * `reason` as a user may read it: each budget failure message (also inside a composed reason
 * such as `Step "copy" failed after 1 execution: …`) becomes its user-facing sentence without
 * amounts. Fail-closed: a reason that names budget configuration or still names an amount is
 * replaced as a whole.
 */
export function withoutBudgetDetails(reason: string): string {
  if (BUDGET_CONFIGURATION.test(reason)) return UNDISCLOSED_FAILURE_REASON;
  const replaced = reason
    .replace(RUN_CAP_MESSAGE, RUN_BUDGET_REACHED_REASON)
    .replace(DAILY_CAP_MESSAGE, DAILY_BUDGET_REACHED_REASON);
  return LEFTOVER_AMOUNT.test(replaced) ? UNDISCLOSED_FAILURE_REASON : replaced;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The UTC calendar day containing `now`, as `[start, end)`. UTC rather than Europe/Amsterdam:
 * every day is exactly 24 hours (no DST days of 23 or 25 hours), and the boundary does not
 * depend on the server's time zone.
 */
export function utcDayWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export interface BudgetCheckInput {
  /** `DAILY_BUDGET_USD`: spend across all runs and calls outside runs, per UTC day. */
  readonly dailyCapUsd: string;
  /** Per-run cap from the service definition (`budget.max_cost_usd_per_run`). */
  readonly run?: { readonly runId: string; readonly capUsd: string } | undefined;
  readonly now: Date;
}

export interface BudgetStatus {
  readonly dailySpentUsd: string;
  /** `undefined` when no run cap applies. */
  readonly runSpentUsd: string | undefined;
}

/**
 * Throws {@link BudgetExceededError} when spend has reached a cap (`spent >= limit`, so a cap of
 * `0` blocks every call). The run cap is checked first, then the daily cap.
 */
export async function checkBudget(db: Executor, input: BudgetCheckInput): Promise<BudgetStatus> {
  const dailyCapUsd = usdAmountSchema.parse(input.dailyCapUsd);

  let runSpentUsd: string | undefined;
  if (input.run !== undefined) {
    const runCapUsd = usdAmountSchema.parse(input.run.capUsd);
    runSpentUsd = await getRunCostUsd(db, input.run.runId);
    if (compareDecimalStrings(runSpentUsd, runCapUsd) >= 0) {
      throw new BudgetExceededError('run', runCapUsd, runSpentUsd);
    }
  }

  const { start, end } = utcDayWindow(input.now);
  // Replayed demo runs bill nothing, so they never use up the live budget (docs §10).
  const dailySpentUsd = await getCostUsdSince(db, start, end, {
    excludeOwnerEmail: DEMO_OWNER_EMAIL,
  });
  if (compareDecimalStrings(dailySpentUsd, dailyCapUsd) >= 0) {
    throw new BudgetExceededError('daily', dailyCapUsd, dailySpentUsd);
  }
  return { dailySpentUsd, runSpentUsd };
}
