import { describe, expect, it } from 'vitest';
import { stepCompletedPayloadSchema, stepFailedPayloadSchema } from './run-events.ts';

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
