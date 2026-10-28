import { describe, expect, it } from 'vitest';
import { DefinitionNotFoundError } from '../definitions/loader.ts';
import { BudgetExceededError } from '../usage/budget.ts';
import { UnpricedModelError, UnpricedUsageError } from '../usage/ledger.ts';
import {
  describeStepError,
  isRetryableStepError,
  MissingStepHandlerError,
  NonRetryableStepError,
  StepInterruptedError,
  StepTimeoutError,
} from './steps.ts';

describe('isRetryableStepError', () => {
  it('does not retry budget, pricing, definition, and explicit non-retryable errors', () => {
    for (const error of [
      new BudgetExceededError('run', '0.50', '0.50000000'),
      new UnpricedModelError('muse-unknown'),
      new UnpricedUsageError(
        [{ modelId: 'muse-spark-1.3', reason: 'missing_units', fields: [] }],
        [],
      ),
      new NonRetryableStepError('The fact form is empty'),
      new MissingStepHandlerError('vision'),
      new DefinitionNotFoundError('No service definition "x" version 1'),
    ]) {
      expect(isRetryableStepError(error)).toBe(false);
    }
  });

  it('retries timeouts, interruptions, and unknown failures', () => {
    for (const error of [
      new StepTimeoutError('intake', 600_000),
      new StepInterruptedError('intake'),
      new Error('socket hang up'),
      'thrown string',
    ]) {
      expect(isRetryableStepError(error)).toBe(true);
    }
  });
});

describe('describeStepError', () => {
  it('uses messages this codebase controls', () => {
    expect(describeStepError(new StepTimeoutError('intake', 600_000))).toBe(
      'Step "intake" timed out after 600 s',
    );
    expect(describeStepError(new BudgetExceededError('daily', '5.00', '5.01000000'))).toBe(
      'Global daily budget cap reached: spent 5.01000000 of 5.00 USD today (UTC)',
    );
    expect(
      describeStepError(
        new UnpricedUsageError([{ modelId: 'muse-x', reason: 'unknown_model', fields: [] }], []),
      ),
    ).toBe('Model usage could not be priced (muse-x)');
  });

  it('reduces any other error to its class name, so no payload text is stored', () => {
    class TypeValidationError extends Error {
      override name = 'AI_TypeValidationError';
    }
    expect(describeStepError(new TypeValidationError('Value: {"address":"Keizersgracht 1"}'))).toBe(
      'Unexpected AI_TypeValidationError',
    );
    expect(describeStepError({ message: 'not an Error' })).toBe('Unexpected non-error failure');
  });
});
