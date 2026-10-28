import { describe, expect, it } from 'vitest';
import {
  factsExtractedPayloadSchema,
  photosInventoriedPayloadSchema,
  stepCompletedPayloadSchema,
  stepFailedPayloadSchema,
  transcriptStoredPayloadSchema,
} from './run-events.ts';

const completed = {
  stepId: 'intake',
  attempt: 1,
  execution: 1,
  artifactIds: ['3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf'],
  stepCostUsd: '0.00337500',
  runCostUsd: '0.01000000',
};

describe('run event payloads', () => {
  it('accepts the engine payloads', () => {
    expect(stepCompletedPayloadSchema.parse(completed)).toEqual(completed);
    expect(
      stepFailedPayloadSchema.parse({
        stepId: 'intake',
        attempt: 2,
        execution: 2,
        reason: 'Step "intake" timed out after 600 s',
        willRetry: false,
        stepCostUsd: '0',
        runCostUsd: '0',
      }).willRetry,
    ).toBe(false);
  });

  it('rejects float costs and unknown keys, so payloads stay exact and minimal', () => {
    expect(
      stepCompletedPayloadSchema.safeParse({ ...completed, stepCostUsd: 0.0034 }).success,
    ).toBe(false);
    expect(stepCompletedPayloadSchema.safeParse({ ...completed, output: 'text' }).success).toBe(
      false,
    );
  });
});

describe('transcript_stored payload', () => {
  const summary = {
    stepId: 'intake',
    artifactId: '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf',
    mode: 'DIARIZATION',
    audioDurationMs: 168_800,
    sourceTurnCount: 15,
    turnCount: 15,
    approximateTurnCount: 0,
    speakerCount: 1,
    keywordCount: 25,
  };

  it('carries counts only and rejects transcript text or keywords', () => {
    expect(transcriptStoredPayloadSchema.parse(summary)).toEqual(summary);
    expect(
      transcriptStoredPayloadSchema.safeParse({ ...summary, text: 'Goedemiddag' }).success,
    ).toBe(false);
    expect(
      transcriptStoredPayloadSchema.safeParse({ ...summary, keywords: ['Zandmeer'] }).success,
    ).toBe(false);
  });
});

describe('facts_extracted payload', () => {
  const summary = {
    stepId: 'fact_extraction',
    artifactId: '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf',
    formFactCount: 7,
    modelFactCount: 30,
    transcriptFactCount: 28,
    opinionCount: 3,
    repairedCount: 1,
    rejectedCount: 2,
  };

  it('carries counts only and rejects fact values or keys', () => {
    expect(factsExtractedPayloadSchema.parse(summary)).toEqual(summary);
    expect(
      factsExtractedPayloadSchema.safeParse({ ...summary, keys: ['living_area'] }).success,
    ).toBe(false);
    expect(
      factsExtractedPayloadSchema.safeParse({ ...summary, transcriptFactCount: -1 }).success,
    ).toBe(false);
  });
});

describe('photos_inventoried payload', () => {
  const summary = {
    stepId: 'vision_inventory',
    artifactId: '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf',
    photoCount: 12,
    classifiedCount: 11,
    classificationFailedCount: 1,
    privacyClearCount: 9,
    privacyMaskedCount: 1,
    privacyReviewCount: 1,
    privacyFailedCount: 1,
    privacyRegionCount: 2,
    observationCount: 40,
    evidenceRequestCount: 12,
    evidenceMaskCount: 12,
    factCount: 38,
  };

  it('carries counts only and rejects subjects or object names', () => {
    expect(photosInventoriedPayloadSchema.parse(summary)).toEqual(summary);
    expect(
      photosInventoriedPayloadSchema.safeParse({ ...summary, subjects: ['kitchen'] }).success,
    ).toBe(false);
    expect(photosInventoriedPayloadSchema.safeParse({ ...summary, factCount: -1 }).success).toBe(
      false,
    );
  });
});
