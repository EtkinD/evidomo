import { describe, expect, it } from 'vitest';
import {
  demoArtifactFileUrl,
  demoClaimAuditGateResponseSchema,
  demoClaimAuditGateUrl,
  demoExportFileUrl,
  demoExportUrl,
  demoFactConflictsGateUrl,
  demoFactMaskUrl,
  demoMaterialFileUrl,
  demoReplaySpeedSchema,
  demoRunEventsQuerySchema,
  demoRunEventsUrl,
  demoRunExportResponseSchema,
  demoRunsUrl,
  demoRunUrl,
  demoTranscriptAudioUrl,
} from './demo.ts';

const uuid = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';
const other = '9c1f0a52-7a43-4b8e-9d0e-2f1e3c4b5a69';

describe('demo URL builders', () => {
  it('mirror the run API scheme under /api/demo/runs', () => {
    expect(demoRunsUrl()).toBe('/api/demo/runs');
    expect(demoRunUrl(uuid)).toBe(`/api/demo/runs/${uuid}`);
    expect(demoRunEventsUrl(uuid)).toBe(`/api/demo/runs/${uuid}/events`);
    expect(demoRunEventsUrl(uuid, { after: 7, speed: 2.5 })).toBe(
      `/api/demo/runs/${uuid}/events?after=7&speed=2.5`,
    );
    expect(demoFactConflictsGateUrl(uuid)).toBe(`/api/demo/runs/${uuid}/gates/fact-conflicts`);
    expect(demoClaimAuditGateUrl(uuid)).toBe(`/api/demo/runs/${uuid}/gates/claim-audit`);
    expect(demoMaterialFileUrl(uuid, other, { download: true })).toBe(
      `/api/demo/runs/${uuid}/materials/${other}/file?download=1`,
    );
    expect(demoArtifactFileUrl(uuid, other)).toBe(`/api/demo/runs/${uuid}/artifacts/${other}/file`);
    expect(demoTranscriptAudioUrl(uuid, other)).toBe(
      `/api/demo/runs/${uuid}/transcripts/${other}/audio`,
    );
    expect(demoFactMaskUrl(uuid, other)).toBe(`/api/demo/runs/${uuid}/facts/${other}/mask.png`);
    expect(demoExportUrl(uuid)).toBe(`/api/demo/runs/${uuid}/export`);
    expect(demoExportFileUrl(uuid, other, { download: true })).toBe(
      `/api/demo/runs/${uuid}/export/files/${other}?download=1`,
    );
  });

  it('never let input change the path', () => {
    expect(demoRunUrl('../x?y')).toBe('/api/demo/runs/..%2Fx%3Fy');
  });

  it('refuse an invalid cursor or speed', () => {
    expect(() => demoRunEventsUrl(uuid, { after: -1 })).toThrow(RangeError);
    expect(() => demoRunEventsUrl(uuid, { after: 1.5 })).toThrow(RangeError);
    for (const speed of [0, 0.2, 11, 1.125, Number.NaN]) {
      expect(() => demoRunEventsUrl(uuid, { speed }), String(speed)).toThrow(RangeError);
    }
  });
});

describe('demo replay query', () => {
  it('accepts speeds within bounds only', () => {
    expect(demoReplaySpeedSchema.parse('0.25')).toBe(0.25);
    expect(demoReplaySpeedSchema.parse('10')).toBe(10);
    for (const bad of ['', '0', '0.1', '10.01', '1e1', '-1', '2x', '1.234', 'Infinity']) {
      expect(demoReplaySpeedSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(demoRunEventsQuerySchema.parse({ after: '3', speed: '2' })).toEqual({
      after: 3,
      speed: 2,
    });
  });
});

describe('demo responses', () => {
  it('carry no user ID in the Gate 2 sign-off', () => {
    const approval = demoClaimAuditGateResponseSchema.shape.approval;
    expect(approval.safeParse({ decidedAt: '2026-10-29T10:00:00.000Z' }).success).toBe(true);
    expect(
      approval.safeParse({ decidedAt: '2026-10-29T10:00:00.000Z', decidedBy: uuid }).success,
    ).toBe(false);
  });

  it('link export files under the demo prefix only', () => {
    const file = demoRunExportResponseSchema.shape.files.element;
    expect(file.shape.url.safeParse(`/api/demo/runs/${uuid}/export/files/${other}`).success).toBe(
      true,
    );
    expect(file.shape.url.safeParse(`/api/runs/${uuid}/export/files/${other}`).success).toBe(false);
  });
});
