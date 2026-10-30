import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  DAILY_BUDGET_REACHED_REASON,
  RUN_BUDGET_REACHED_REASON,
  UNDISCLOSED_FAILURE_REASON,
  utcDayWindow,
  withoutBudgetDetails,
} from './budget.ts';
import { InvalidBudgetCapError } from './ledger.ts';

describe('utcDayWindow', () => {
  it('spans exactly one UTC calendar day, [start, end)', () => {
    expect(utcDayWindow(new Date('2026-10-28T23:59:59.999Z'))).toEqual({
      start: new Date('2026-10-28T00:00:00.000Z'),
      end: new Date('2026-10-29T00:00:00.000Z'),
    });
    expect(utcDayWindow(new Date('2026-10-29T00:00:00.000Z')).start).toEqual(
      new Date('2026-10-29T00:00:00.000Z'),
    );
  });

  it('is 24 hours on a European DST change day', () => {
    // Europe/Amsterdam falls back from CEST to CET on 2026-10-25 (a 25-hour local day).
    const { start, end } = utcDayWindow(new Date('2026-10-25T12:00:00+01:00'));
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('BudgetExceededError', () => {
  it('carries the cap kind, limit, and spend', () => {
    const error = new BudgetExceededError('run', '0.50', '0.50120000');
    expect(error).toMatchObject({
      name: 'BudgetExceededError',
      kind: 'run',
      limitUsd: '0.50',
      spentUsd: '0.50120000',
    });
    expect(error.message).toBe('Run budget cap reached: spent 0.50120000 of 0.50 USD');
    expect(new BudgetExceededError('daily', '5.00', '5.00000000').message).toMatch(/daily.*UTC/);
  });
});

describe('withoutBudgetDetails', () => {
  it('states the real budget failure messages without amounts, also inside a step reason', () => {
    const run = new BudgetExceededError('run', '1.00', '1.00412000').message;
    const daily = new BudgetExceededError('daily', '5.00', '5.12000000').message;
    expect(withoutBudgetDetails(run)).toBe(RUN_BUDGET_REACHED_REASON);
    expect(withoutBudgetDetails(daily)).toBe(DAILY_BUDGET_REACHED_REASON);
    expect(withoutBudgetDetails(`Step "copy" failed after 1 execution: ${run}`)).toBe(
      `Step "copy" failed after 1 execution: ${RUN_BUDGET_REACHED_REASON}`,
    );
    expect(withoutBudgetDetails(`Step "vision" failed after 2 executions: ${daily}`)).toBe(
      `Step "vision" failed after 2 executions: ${DAILY_BUDGET_REACHED_REASON}`,
    );
    // A daily cap of 0 (all model calls stopped) has integer amounts.
    expect(withoutBudgetDetails(new BudgetExceededError('daily', '0', '0').message)).toBe(
      DAILY_BUDGET_REACHED_REASON,
    );
  });

  it('keeps reasons without budget details as they are', () => {
    for (const reason of [
      'Step "intake" timed out after 600 s',
      'Step "export" could not be recovered after repeated failures',
      'Model usage could not be priced (muse-spark-1.3)',
    ]) {
      expect(withoutBudgetDetails(reason)).toBe(reason);
    }
  });

  it('replaces a whole reason that still names an amount it does not know, in either order', () => {
    for (const reason of [
      'Spend limit hit at 0.98 USD',
      'Spend limit hit at USD 0.98',
      'Spend limit hit at usd3',
      'Spent $1.20 so far',
    ]) {
      expect(withoutBudgetDetails(reason), reason).toBe(UNDISCLOSED_FAILURE_REASON);
    }
  });

  it('replaces a reason that exposes the budget configuration (an invalid cap)', () => {
    for (const cap of ['daily', 'run'] as const) {
      const message = new InvalidBudgetCapError(cap).message;
      expect(withoutBudgetDetails(message)).toBe(UNDISCLOSED_FAILURE_REASON);
      expect(withoutBudgetDetails(`Step "copy" failed after 1 execution: ${message}`)).toBe(
        UNDISCLOSED_FAILURE_REASON,
      );
    }
  });
});
