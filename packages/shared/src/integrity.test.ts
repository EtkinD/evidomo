import { describe, expect, it } from 'vitest';
import { integrityPhotoSchema, type IntegrityPhoto } from './integrity.ts';

const FIRST = '6c1b6a43-0000-4000-8000-000000000001';
const RETRY = '6c1b6a43-0000-4000-8000-000000000002';
const image = { width: 1024, height: 682, segments: { window: [] } };
const verdict = {
  passed: true,
  aspectRatioChange: 0,
  failures: [],
  failedClasses: [],
  classes: [],
  thresholds: { minIoU: 0.75, minContainment: 0.85, minAreaRatio: 0.4, maxAspectRatioChange: 0.03 },
};

function checked(attempt: 1 | 2, id: string, passed: boolean) {
  return {
    status: 'checked' as const,
    attempt,
    stagedArtifactId: id,
    passed,
    edit: image,
    verdict: { ...verdict, passed },
    privacy: { passed: true, phrases: [{ phrase: 'person', count: 0 }] },
  };
}

function photo(overrides: Partial<IntegrityPhoto>): unknown {
  return {
    materialId: '0b7f2a0e-5c1d-4d6e-9a51-000000000001',
    operationId: 'furnish_living_room',
    original: image,
    attempts: [checked(1, FIRST, true)],
    outcome: 'passed',
    finalStagedArtifactId: FIRST,
    ...overrides,
  };
}

describe('integrityPhotoSchema', () => {
  it('accepts outcomes that follow from the last attempt', () => {
    expect(integrityPhotoSchema.safeParse(photo({})).success).toBe(true);
    const retried = [checked(1, FIRST, false), checked(2, RETRY, true)];
    expect(
      integrityPhotoSchema.safeParse(
        photo({ attempts: retried, outcome: 'passed_on_retry', finalStagedArtifactId: RETRY }),
      ).success,
    ).toBe(true);
    expect(
      integrityPhotoSchema.safeParse(
        photo({
          attempts: [
            checked(1, FIRST, false),
            { status: 'edit_failed', attempt: 2, reason: 'no_image' },
          ],
          outcome: 'fallback_original',
          finalStagedArtifactId: null,
        }),
      ).success,
    ).toBe(true);
  });

  it('never lets a failed or unchecked image be final', () => {
    const failed = [checked(1, FIRST, false)];
    expect(
      integrityPhotoSchema.safeParse(photo({ attempts: failed, outcome: 'passed' })).success,
    ).toBe(false);
    expect(
      integrityPhotoSchema.safeParse(
        photo({ attempts: failed, outcome: 'fallback_original', finalStagedArtifactId: FIRST }),
      ).success,
    ).toBe(false);
    const unchecked = {
      status: 'unchecked' as const,
      attempt: 1 as const,
      stagedArtifactId: FIRST,
      target: 'edit' as const,
      reason: 'invalid_output' as const,
    };
    expect(
      integrityPhotoSchema.safeParse(photo({ attempts: [unchecked], outcome: 'passed' })).success,
    ).toBe(false);
  });

  it('rejects attempts out of order', () => {
    expect(
      integrityPhotoSchema.safeParse(
        photo({
          attempts: [checked(2, RETRY, true)],
          outcome: 'passed_on_retry',
          finalStagedArtifactId: RETRY,
        }),
      ).success,
    ).toBe(false);
  });
});
