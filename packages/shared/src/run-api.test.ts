import { describe, expect, it } from 'vitest';
import { RUN_EVENT_TYPES } from './domain.ts';
import {
  isRunStreamTerminal,
  RUN_STREAM_WITHHELD_TYPE,
  runEventCursorSchema,
  runEventsUrl,
  runExportFileUrl,
  runFactMaskUrl,
  runMaterialFileUrl,
  projectMaterialFileUrl,
  runSnapshotSchema,
  runStreamEventSchema,
  runSummarySchema,
  runTranscriptAudioUrl,
} from './run-api.ts';

const uuid = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';
const other = '9c1f0a52-7a43-4b8e-9d0e-2f1e3c4b5a69';

describe('runStreamEventSchema', () => {
  it('has a payload schema for every run event type, plus the stream-only withheld type', () => {
    expect(runStreamEventSchema.options.map((option) => option.shape.type.value).sort()).toEqual(
      [...RUN_EVENT_TYPES, RUN_STREAM_WITHHELD_TYPE].sort(),
    );
    expect(RUN_EVENT_TYPES).not.toContain(RUN_STREAM_WITHHELD_TYPE);
  });

  it('accepts step events with and without their cost totals, and stays strict', () => {
    const base = { seq: 4, occurredAt: '2026-10-29T10:00:00.000Z', type: 'step_completed' };
    const payload = { stepId: 'intake', attempt: 1, execution: 1, artifactIds: [uuid] };
    const costs = { stepCostUsd: '0.01', runCostUsd: '0.02' };
    expect(runStreamEventSchema.parse({ ...base, payload: { ...payload, ...costs } })).toEqual({
      ...base,
      payload: { ...payload, ...costs },
    });
    expect(runStreamEventSchema.parse({ ...base, payload })).toEqual({ ...base, payload });
    expect(
      runStreamEventSchema.safeParse({ ...base, payload: { ...payload, costUsd: '0.01' } }).success,
    ).toBe(false);
    const failed = {
      ...base,
      type: 'step_failed',
      payload: { stepId: 'intake', attempt: 1, execution: 2, reason: 'x', willRetry: false },
    };
    expect(runStreamEventSchema.safeParse(failed).success).toBe(true);
  });

  it('accepts withheld only with an empty payload', () => {
    const base = { seq: 5, occurredAt: '2026-10-29T10:00:00.000Z', type: RUN_STREAM_WITHHELD_TYPE };
    expect(runStreamEventSchema.parse({ ...base, payload: {} }).type).toBe('withheld');
    expect(
      runStreamEventSchema.safeParse({ ...base, payload: { stepId: 'intake', runCostUsd: '1' } })
        .success,
    ).toBe(false);
  });

  it('parses stored events and refuses a payload that does not fit its type', () => {
    const base = { seq: 3, occurredAt: '2026-10-29T10:00:00.000Z' };
    expect(
      runStreamEventSchema.parse({
        ...base,
        type: 'run_status_changed',
        payload: { from: 'running', to: 'awaiting_gate', gate: 'fact_conflicts' },
      }).type,
    ).toBe('run_status_changed');
    expect(
      runStreamEventSchema.safeParse({
        ...base,
        type: 'usage_recorded',
        payload: { stepId: 'intake', stepCostUsd: '0.01', runCostUsd: 0.02 },
      }).success,
    ).toBe(false);
  });
});

describe('runEventCursorSchema', () => {
  it('accepts sequence numbers and refuses anything else', () => {
    expect(runEventCursorSchema.parse('0')).toBe(0);
    expect(runEventCursorSchema.parse('42')).toBe(42);
    for (const bad of ['', '-1', '01', '1.5', 'abc', '99999999999']) {
      expect(runEventCursorSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('URL builders', () => {
  it('spell out the evidence and export URL scheme', () => {
    expect(projectMaterialFileUrl(uuid, other)).toBe(
      `/api/projects/${uuid}/materials/${other}/file`,
    );
    expect(projectMaterialFileUrl(uuid, '../x', { download: true })).toBe(
      `/api/projects/${uuid}/materials/..%2Fx/file?download=1`,
    );
    expect(runEventsUrl(uuid)).toBe(`/api/runs/${uuid}/events`);
    expect(runEventsUrl(uuid, 7)).toBe(`/api/runs/${uuid}/events?after=7`);
    expect(runMaterialFileUrl(uuid, other)).toBe(`/api/runs/${uuid}/materials/${other}/file`);
    expect(runMaterialFileUrl(uuid, other, { download: true })).toBe(
      `/api/runs/${uuid}/materials/${other}/file?download=1`,
    );
    expect(runTranscriptAudioUrl(uuid, other)).toBe(`/api/runs/${uuid}/transcripts/${other}/audio`);
    expect(runFactMaskUrl(uuid, other)).toBe(`/api/runs/${uuid}/facts/${other}/mask.png`);
    expect(runExportFileUrl(uuid, other, { download: true })).toBe(
      `/api/runs/${uuid}/export/files/${other}?download=1`,
    );
  });
});

describe('URL builder input', () => {
  it('encodes path segments and refuses an invalid cursor', () => {
    expect(runMaterialFileUrl('a/../b', 'c?d=1#e')).toBe(
      '/api/runs/a%2F..%2Fb/materials/c%3Fd%3D1%23e/file',
    );
    expect(runEventsUrl(uuid, 0)).toBe(`/api/runs/${uuid}/events?after=0`);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => runEventsUrl(uuid, bad), String(bad)).toThrow(RangeError);
    }
  });
});

describe('isRunStreamTerminal', () => {
  it('ends the stream on completed and failed runs only', () => {
    expect(isRunStreamTerminal('completed')).toBe(true);
    expect(isRunStreamTerminal('failed')).toBe(true);
    expect(isRunStreamTerminal('awaiting_gate')).toBe(false);
    expect(isRunStreamTerminal('running')).toBe(false);
    expect(isRunStreamTerminal('queued')).toBe(false);
  });
});

describe('cost keys in snapshots and summaries', () => {
  const step = {
    stepId: 'intake',
    agent: 'intake',
    gateAfter: null,
    status: 'completed',
    attempt: 1,
    attempts: 1,
    executions: 1,
    totalExecutions: 1,
    costUsd: '0.10000000',
    startedAt: '2026-10-29T10:00:00.000Z',
    finishedAt: '2026-10-29T10:01:00.000Z',
    gateReleasedAt: null,
    error: null,
  };
  const summary = {
    id: uuid,
    projectId: other,
    status: 'running',
    serviceId: 'listing-launch',
    serviceVersion: 1,
    marketProfileId: 'nl',
    marketProfileVersion: 1,
    outputLanguage: 'nl',
    gate: null,
    currentStepId: 'intake',
    failureReason: null,
    createdAt: '2026-10-29T09:59:00.000Z',
    startedAt: '2026-10-29T10:00:00.000Z',
    finishedAt: null,
    costUsd: '0.10000000',
  };
  const snapshot = {
    ...summary,
    updatedAt: '2026-10-29T10:01:00.000Z',
    lastEventSeq: 3,
    costCapUsd: '1.00',
    maxExecutionsPerAttempt: 2,
    steps: [step],
    export: null,
  };
  const { costUsd: _runCost, costCapUsd: _cap, ...hiddenSnapshot } = snapshot;
  const { costUsd: _stepCost, ...hiddenStep } = step;
  const { costUsd: _summaryCost, ...hiddenSummary } = summary;

  it('accepts a snapshot with every cost key and one with none', () => {
    expect(runSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(runSnapshotSchema.parse({ ...snapshot, costCapUsd: null }).costCapUsd).toBeNull();
    const hidden = { ...hiddenSnapshot, steps: [hiddenStep] };
    const parsed = runSnapshotSchema.parse(hidden);
    expect(parsed).toEqual(hidden);
    expect('costUsd' in parsed || 'costCapUsd' in parsed).toBe(false);
  });

  it('refuses a snapshot that discloses only some of its costs', () => {
    for (const mixed of [
      { ...snapshot, steps: [hiddenStep] },
      { ...hiddenSnapshot, steps: [step] },
      { ...hiddenSnapshot, costCapUsd: '1.00', steps: [hiddenStep] },
      { ...hiddenSnapshot, costUsd: '0.1', steps: [step] },
    ]) {
      expect(runSnapshotSchema.safeParse(mixed).success).toBe(false);
    }
  });

  it('accepts a run summary with and without its cost', () => {
    expect(runSummarySchema.parse(summary)).toEqual(summary);
    expect(runSummarySchema.parse(hiddenSummary)).toEqual(hiddenSummary);
  });
});
