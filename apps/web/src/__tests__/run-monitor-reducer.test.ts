import type { RunSnapshot, RunStepSnapshot, RunStreamEvent } from '@evidomo/shared';
import { describe, expect, it } from 'vitest';
import { applyRunEnd, applyRunEvent } from '../lib/run-monitor';

const AT = '2026-10-29T10:00:00.000Z';
const LATER = '2026-10-29T10:05:00.000Z';

function step(stepId: string, overrides: Partial<RunStepSnapshot> = {}): RunStepSnapshot {
  return {
    stepId,
    agent: 'extractor',
    gateAfter: null,
    status: 'pending',
    attempt: null,
    attempts: 0,
    executions: 0,
    totalExecutions: 0,
    costUsd: '0',
    startedAt: null,
    finishedAt: null,
    gateReleasedAt: null,
    error: null,
    ...overrides,
  };
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: '0b9f7c1e-5d2a-4e8b-9c3d-1a2b3c4d5e6f',
    projectId: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
    status: 'running',
    serviceId: 's',
    serviceVersion: 1,
    marketProfileId: 'm',
    marketProfileVersion: 1,
    outputLanguage: 'de',
    gate: null,
    currentStepId: 'a',
    failureReason: null,
    createdAt: AT,
    startedAt: AT,
    finishedAt: null,
    updatedAt: AT,
    costUsd: '0',
    lastEventSeq: 4,
    costCapUsd: '2',
    maxExecutionsPerAttempt: 2,
    steps: [step('a'), step('b')],
    export: null,
    ...overrides,
  };
}

function ev(seq: number, type: string, payload: unknown): RunStreamEvent {
  return { seq, type, payload, occurredAt: LATER } as RunStreamEvent;
}

describe('applyRunEvent', () => {
  it('ignores an event the snapshot already reflects (idempotent)', () => {
    const snapshot = run();
    const event = ev(4, 'usage_recorded', { stepId: 'a', stepCostUsd: '1', runCostUsd: '1' });
    expect(applyRunEvent(snapshot, event)).toBe(snapshot);
  });

  it('returns null on a gap so the caller refetches', () => {
    const event = ev(6, 'usage_recorded', { stepId: 'a', stepCostUsd: '1', runCostUsd: '1' });
    expect(applyRunEvent(run(), event)).toBeNull();
  });

  it('applies absolute cost, so a replay of the same totals changes nothing further', () => {
    const first = applyRunEvent(
      run(),
      ev(5, 'usage_recorded', { stepId: 'a', stepCostUsd: '0.4', runCostUsd: '0.9' }),
    );
    expect(first?.costUsd).toBe('0.9');
    expect(first?.steps[0]?.costUsd).toBe('0.4');
    expect(first?.lastEventSeq).toBe(5);
  });

  it('keeps a retried step queued with its reason, then clears it when it runs again', () => {
    const failed = applyRunEvent(
      run(),
      ev(5, 'step_failed', {
        stepId: 'a',
        attempt: 1,
        execution: 1,
        reason: 'timed out',
        willRetry: true,
        stepCostUsd: '0.1',
        runCostUsd: '0.1',
      }),
    );
    expect(failed?.steps[0]).toMatchObject({
      status: 'queued',
      error: 'timed out',
      finishedAt: null,
    });
    const started = applyRunEvent(
      failed ?? run(),
      ev(6, 'step_started', { stepId: 'a', attempt: 1, execution: 2 }),
    );
    expect(started?.steps[0]).toMatchObject({ status: 'running', error: null, executions: 2 });
  });

  it('marks a final failure failed with a finish time', () => {
    const failed = applyRunEvent(
      run(),
      ev(5, 'step_failed', {
        stepId: 'a',
        attempt: 1,
        execution: 2,
        reason: 'bad',
        willRetry: false,
        stepCostUsd: '0.1',
        runCostUsd: '0.1',
      }),
    );
    expect(failed?.steps[0]).toMatchObject({ status: 'failed', finishedAt: LATER });
  });

  it('models a resume: failed run back to running clears reason and finish time', () => {
    const failedRun = run({
      status: 'failed',
      failureReason: 'Boom',
      finishedAt: AT,
      currentStepId: null,
    });
    const resumed = applyRunEvent(
      failedRun,
      ev(5, 'run_status_changed', { from: 'failed', to: 'running' }),
    );
    expect(resumed).toMatchObject({ status: 'running', failureReason: null, finishedAt: null });
    const restarted = applyRunEvent(
      resumed ?? failedRun,
      ev(6, 'step_started', { stepId: 'b', attempt: 2, execution: 1 }),
    );
    expect(restarted).toMatchObject({ currentStepId: 'b' });
    expect(restarted?.steps[1]).toMatchObject({ attempt: 2, attempts: 2 });
  });

  it('clears the current step on a terminal transition', () => {
    const done = applyRunEvent(
      run(),
      ev(5, 'run_status_changed', { from: 'running', to: 'failed', reason: 'x' }),
    );
    expect(done).toMatchObject({ status: 'failed', currentStepId: null, failureReason: 'x' });
  });

  it('moves only the cursor for events without monitor state', () => {
    const next = applyRunEvent(run(), ev(5, 'photos_inventoried', {}));
    expect(next?.lastEventSeq).toBe(5);
  });
});

describe('applyRunEnd', () => {
  it('shows the terminal state and cursor immediately', () => {
    const ended = applyRunEnd(run({ gate: 'claim_audit' }), {
      status: 'completed',
      lastEventSeq: 9,
    });
    expect(ended).toMatchObject({
      status: 'completed',
      gate: null,
      currentStepId: null,
      lastEventSeq: 9,
      finishedAt: AT,
    });
  });
});
