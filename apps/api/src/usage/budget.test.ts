import { describe, expect, it } from 'vitest';
import { BudgetExceededError, utcDayWindow } from './budget.ts';

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
