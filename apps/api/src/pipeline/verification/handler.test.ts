import { NoObjectGeneratedError } from 'ai';
import { describe, expect, it } from 'vitest';
import { NonRetryableStepError } from '../../runs/steps.ts';
import { BudgetExceededError } from '../../usage/budget.ts';
import { CopyOutputError } from '../creative/check.ts';
import { classifyCopyError } from '../creative/generate.ts';
import { revisionFailureClass } from './handler.ts';

// Which failures inside a revision loop end the loop at the last audited draft (a class) and
// which still fail the execution (undefined).

const truncated = new NoObjectGeneratedError({
  message: 'No object generated',
  text: '{"variants": [',
  response: { id: 'resp_1', timestamp: new Date(0), modelId: 'muse-spark-1.3' },
  usage: {
    inputTokens: 1,
    inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 1,
    outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
    totalTokens: 2,
  },
  finishReason: 'length',
});

describe('revisionFailureClass', () => {
  it('absorbs unusable or truncated revisions, the model failures of a revision', () => {
    expect(revisionFailureClass(new CopyOutputError('unknown_fact_id', 'unknown ID'))).toBe(
      'CopyOutputError unknown_fact_id',
    );
    // Creative wraps a truncated answer in NonRetryableStepError; the cause decides.
    const wrapped = classifyCopyError(truncated, 16_000);
    expect(wrapped).toBeInstanceOf(NonRetryableStepError);
    expect(revisionFailureClass(wrapped)).toBe('NoObjectGeneratedError length');
  });

  it('still fails the execution on abort, configuration, budget, and programming errors', () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(
      revisionFailureClass(new CopyOutputError('empty_variant', 'empty'), aborted.signal),
    ).toBeUndefined();
    expect(
      revisionFailureClass(new NonRetryableStepError('Unknown language "xx"')),
    ).toBeUndefined();
    expect(
      revisionFailureClass(new BudgetExceededError('run', '1.00', '1.00000000')),
    ).toBeUndefined();
    expect(revisionFailureClass(new TypeError('bug'))).toBeUndefined();
  });
});
