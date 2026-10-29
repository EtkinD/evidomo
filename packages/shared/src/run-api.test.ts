import { describe, expect, it } from 'vitest';
import { RUN_EVENT_TYPES } from './domain.ts';
import {
  isRunStreamTerminal,
  runEventCursorSchema,
  runEventsUrl,
  runExportFileUrl,
  runFactMaskUrl,
  runMaterialFileUrl,
  projectMaterialFileUrl,
  runStreamEventSchema,
  runTranscriptAudioUrl,
} from './run-api.ts';

const uuid = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';
const other = '9c1f0a52-7a43-4b8e-9d0e-2f1e3c4b5a69';

describe('runStreamEventSchema', () => {
  it('has a payload schema for every run event type', () => {
    expect(runStreamEventSchema.options.map((option) => option.shape.type.value).sort()).toEqual(
      [...RUN_EVENT_TYPES].sort(),
    );
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
