import { APICallError, RetryError } from 'ai';
import { APIConnectionError, APIError } from 'openai';
import { describe, expect, it } from 'vitest';
import { REPLAY_MISS_HEADER, REPLAY_MISS_VALUE } from '../meta/service-errors.ts';
import { DefinitionNotFoundError } from '../definitions/loader.ts';
import { BudgetExceededError } from '../usage/budget.ts';
import { InvalidBudgetCapError, UnpricedModelError, UnpricedUsageError } from '../usage/ledger.ts';
import {
  describeStepError,
  isRetryableStepError,
  MissingStepHandlerError,
  NonRetryableStepError,
  REPLAY_MISS_REASON,
  StepInterruptedError,
  StepTimeoutError,
} from './steps.ts';

describe('isRetryableStepError', () => {
  it('does not retry budget, budget-configuration, pricing, definition, and explicit non-retryable errors', () => {
    for (const error of [
      new BudgetExceededError('run', '0.50', '0.50000000'),
      new InvalidBudgetCapError('daily'),
      new InvalidBudgetCapError('run'),
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
    expect(describeStepError(new InvalidBudgetCapError('daily'))).toBe(
      'The daily (DAILY_BUDGET_USD) budget cap is not a valid USD amount (up to 4 integer and 8 fraction digits)',
    );
  });

  it('reduces any other error to its class name, so no payload text is stored', () => {
    class TypeValidationError extends Error {
      override name = 'AI_TypeValidationError';
    }
    expect(describeStepError(new TypeValidationError('Value: {"address":"Zandmeer Lane 1"}'))).toBe(
      'Unexpected AI_TypeValidationError',
    );
    expect(describeStepError({ message: 'not an Error' })).toBe('Unexpected non-error failure');
  });
});

// What the SDKs throw for an HTTP error. The message and body quote the request, as real SDK
// errors can; none of it may reach the stored reason.
const REQUEST_TEXT = 'Zandmeer Lane 1, built 1987';

function aiSdkError(statusCode: number | undefined, headers: Record<string, string> = {}) {
  return new APICallError({
    message: `Bad request: ${REQUEST_TEXT}`,
    url: 'https://api.example.invalid/v1/responses',
    requestBodyValues: { input: REQUEST_TEXT },
    ...(statusCode === undefined ? {} : { statusCode }),
    responseHeaders: headers,
    responseBody: JSON.stringify({ error: { message: REQUEST_TEXT } }),
  });
}

function openaiError(status: number, headers: Record<string, string> = {}): APIError {
  return APIError.generate(
    status,
    { error: { message: REQUEST_TEXT } },
    `Error: ${REQUEST_TEXT}`,
    new Headers(headers),
  );
}

describe('model-service errors', () => {
  it('names the HTTP status of either SDK, and nothing of the request', () => {
    for (const error of [aiSdkError(404), openaiError(404)]) {
      expect(describeStepError(error)).toBe('The model service returned HTTP 404');
    }
    expect(describeStepError(aiSdkError(503))).toBe('The model service returned HTTP 503');
    expect(describeStepError(openaiError(429))).toBe('The model service returned HTTP 429');
    for (const error of [aiSdkError(400), openaiError(422), aiSdkError(500)]) {
      expect(describeStepError(error)).not.toContain(REQUEST_TEXT);
    }
  });

  it('does not retry permanent 4xx statuses', () => {
    for (const status of [400, 401, 403, 404, 413, 415, 422]) {
      expect(isRetryableStepError(aiSdkError(status))).toBe(false);
      expect(isRetryableStepError(openaiError(status))).toBe(false);
    }
  });

  it('retries 408, 409, 429, 5xx, and failures without a status (network)', () => {
    for (const status of [408, 409, 429, 500, 502, 503]) {
      expect(isRetryableStepError(aiSdkError(status))).toBe(true);
      expect(isRetryableStepError(openaiError(status))).toBe(true);
    }
    const network = aiSdkError(undefined);
    expect(isRetryableStepError(network)).toBe(true);
    expect(describeStepError(network)).toBe('Unexpected AI_APICallError');
    const connection = new APIConnectionError({ message: 'Connection error.' });
    expect(isRetryableStepError(connection)).toBe(true);
  });

  it('reads the last error behind the AI SDK retry wrapper and wrapped causes', () => {
    const exhausted = new RetryError({
      message: `Failed after 3 attempts. Last error: ${REQUEST_TEXT}`,
      reason: 'maxRetriesExceeded',
      errors: [aiSdkError(503), aiSdkError(503), aiSdkError(503)],
    });
    expect(isRetryableStepError(exhausted)).toBe(true);
    expect(describeStepError(exhausted)).toBe('The model service returned HTTP 503');

    const notRetryable = new RetryError({
      message: 'Failed',
      reason: 'errorNotRetryable',
      errors: [aiSdkError(503), aiSdkError(400)],
    });
    expect(isRetryableStepError(notRetryable)).toBe(false);
    expect(describeStepError(notRetryable)).toBe('The model service returned HTTP 400');

    const wrapped = new Error('copy failed', { cause: openaiError(401) });
    expect(isRetryableStepError(wrapped)).toBe(false);
    expect(describeStepError(wrapped)).toBe('The model service returned HTTP 401');
  });

  it('fails at once with the development-replay reason when the replay has no recording', () => {
    const miss = { [REPLAY_MISS_HEADER]: REPLAY_MISS_VALUE };
    for (const error of [aiSdkError(404, miss), openaiError(404, miss)]) {
      expect(isRetryableStepError(error)).toBe(false);
      expect(describeStepError(error)).toBe(REPLAY_MISS_REASON);
    }
    expect(REPLAY_MISS_REASON).toMatch(/^Development replay has no recording/);
    expect(REPLAY_MISS_REASON).toContain('recorded paths listed by dev:seed');
    // Another 404 is just a 404.
    expect(describeStepError(aiSdkError(404, { [REPLAY_MISS_HEADER]: 'other' }))).toBe(
      'The model service returned HTTP 404',
    );
  });
});
