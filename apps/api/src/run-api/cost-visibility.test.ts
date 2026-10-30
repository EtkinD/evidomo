import { describe, expect, it } from 'vitest';
import { BudgetExceededError, UNDISCLOSED_FAILURE_REASON } from '../usage/budget.ts';
import { InvalidBudgetCapError } from '../usage/ledger.ts';
import { disclosedEvent, disclosedReason, runCostVisibility } from './cost-visibility.ts';
import type { StreamedRunEvent } from './event-stream.ts';

const occurredAt = new Date('2026-10-30T10:00:00.000Z');
const event = (type: string, payload: unknown): StreamedRunEvent => ({
  seq: 7,
  type,
  payload,
  occurredAt,
});
const DAILY = `Step "vision" failed after 1 execution: ${new BudgetExceededError('daily', '5.00', '5.01000000').message}`;

describe('runCostVisibility', () => {
  it('maps RUN_COSTS_VISIBLE to the visibility', () => {
    expect(runCostVisibility(true)).toBe('visible');
    expect(runCostVisibility(false)).toBe('hidden');
  });
});

describe('disclosedReason', () => {
  it('keeps the exact reason when visible and drops budget amounts when hidden', () => {
    expect(disclosedReason(DAILY, 'visible')).toBe(DAILY);
    expect(disclosedReason(DAILY, 'hidden')).toBe(
      `Step "vision" failed after 1 execution: Today's budget for live runs is used up.`,
    );
  });
});

describe('disclosedEvent', () => {
  it('returns the stored event itself when costs are visible', () => {
    const stored = event('usage_recorded', { stepId: 'a', stepCostUsd: '1', runCostUsd: '1' });
    expect(disclosedEvent(stored, 'visible')).toBe(stored);
  });

  it('withholds usage_recorded, keeping seq and time', () => {
    expect(
      disclosedEvent(
        event('usage_recorded', { stepId: 'a', stepCostUsd: '1', runCostUsd: '1' }),
        'hidden',
      ),
    ).toEqual({ seq: 7, type: 'withheld', payload: {}, occurredAt });
  });

  it('passes a known event without its cost totals and keeps the rest', () => {
    const stored = event('step_completed', {
      stepId: 'a',
      attempt: 1,
      execution: 1,
      artifactIds: [],
      stepCostUsd: '0.1',
      runCostUsd: '0.2',
    });
    expect(disclosedEvent(stored, 'hidden')).toEqual({
      ...stored,
      payload: { stepId: 'a', attempt: 1, execution: 1, artifactIds: [] },
    });
    const opened = event('gate_opened', { gate: 'fact_conflicts', stepId: 'reconcile' });
    expect(disclosedEvent(opened, 'hidden')).toEqual(opened);
  });

  it('withholds a known event whose payload carries any key outside its schema', () => {
    const step = { stepId: 'a', attempt: 1, execution: 1, artifactIds: [] };
    for (const extra of [
      { costUsd: '0.3' },
      { spentUsd: '1' },
      { limitUsd: '2' },
      { cost_usd: '3' },
      { usdCost: '4' },
      { nested: { runCostUsd: '3' } },
    ]) {
      expect(disclosedEvent(event('step_completed', { ...step, ...extra }), 'hidden')).toEqual({
        seq: 7,
        type: 'withheld',
        payload: {},
        occurredAt,
      });
    }
  });

  it('withholds an event type this server does not know, whatever it carries', () => {
    const unknown = event('foo', {
      spentUsd: '1',
      nested: { runCostUsd: '3' },
      cost_usd: '3',
      usdCost: '4',
    });
    expect(disclosedEvent(unknown, 'hidden')).toEqual({
      seq: 7,
      type: 'withheld',
      payload: {},
      occurredAt,
    });
    expect(disclosedEvent(event('foo', {}), 'hidden').type).toBe('withheld');
    // Only a stream-only placeholder may be called that; a stored row claiming it is withheld.
    expect(disclosedEvent(event('withheld', { runCostUsd: '1' }), 'hidden').payload).toEqual({});
  });

  it('states a budget reason without amounts and leaves other reasons alone', () => {
    expect(
      disclosedEvent(
        event('run_status_changed', { from: 'running', to: 'failed', reason: DAILY }),
        'hidden',
      ).payload,
    ).toEqual({
      from: 'running',
      to: 'failed',
      reason: `Step "vision" failed after 1 execution: Today's budget for live runs is used up.`,
    });
    const timeout = {
      from: 'running',
      to: 'failed',
      reason: 'Step "intake" timed out after 600 s',
    };
    expect(disclosedEvent(event('run_status_changed', timeout), 'hidden').payload).toEqual(timeout);
  });

  it('replaces a step reason that exposes the budget configuration', () => {
    const payload = {
      stepId: 'copy',
      attempt: 1,
      execution: 1,
      reason: `Step "copy" failed after 1 execution: ${new InvalidBudgetCapError('daily').message}`,
      willRetry: false,
      stepCostUsd: '0',
      runCostUsd: '0',
    };
    expect(disclosedEvent(event('step_failed', payload), 'hidden').payload).toEqual({
      stepId: 'copy',
      attempt: 1,
      execution: 1,
      reason: UNDISCLOSED_FAILURE_REASON,
      willRetry: false,
    });
  });

  it('withholds a row whose payload is not an object (fail-closed)', () => {
    for (const payload of ['1.00 USD', null, [{ runCostUsd: '1' }]]) {
      expect(disclosedEvent(event('step_completed', payload), 'hidden').type).toBe('withheld');
    }
  });
});
