import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../lib/api';
import { busyDelayMs, describeLimit, isTransientFailure } from '../lib/capture';
import { isAbortError, uploadMaterial } from '../lib/upload';
import { stubXhr } from './capture-helpers';
import { testTranslator } from './test-utils';

const MATERIAL = {
  id: '5f0c9d1e-2b3a-4c4d-8e5f-6a7b8c9d0e1f',
  kind: 'photo',
  status: 'ready',
  position: 1,
  mimeType: 'image/jpeg',
  sizeBytes: 10,
  width: 10,
  height: 10,
  durationMs: null,
  failureReason: null,
  createdAt: '2026-10-29T10:00:00.000Z',
};

const request = {
  path: '/api/projects/p/materials/photos',
  method: 'POST',
  body: new Blob(['x']),
  contentType: 'image/jpeg',
} as const;

describe('uploadMaterial', () => {
  it('sends the raw body with its content type and validates the response', async () => {
    const xhr = stubXhr(() => ({ status: 201, body: { material: MATERIAL } }));
    const onProgress = vi.fn();

    const result = await uploadMaterial({ ...request, onProgress });

    expect(result.material.id).toBe(MATERIAL.id);
    expect(xhr.uploads[0]).toMatchObject({ method: 'POST', contentType: 'image/jpeg' });
    expect(onProgress).toHaveBeenCalledWith(0.5);
  });

  it('turns an API refusal into a typed error with reason and Retry-After', async () => {
    stubXhr(() => ({
      status: 429,
      body: { error: 'too_many_uploads' },
      headers: { 'Retry-After': '5' },
    }));
    await expect(uploadMaterial(request)).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 429,
      code: 'too_many_uploads',
      retryAfterSeconds: 5,
    });

    stubXhr(() => ({
      status: 422,
      body: { error: 'upload_rejected', reason: 'heic_not_supported' },
    }));
    const refused = await uploadMaterial(request).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiRequestError);
    expect(refused).toMatchObject({ code: 'upload_rejected', reason: 'heic_not_supported' });
  });

  it('rejects a 2xx body that does not match the contract', async () => {
    stubXhr(() => ({ status: 201, body: { material: { id: 'nope' } } }));
    await expect(uploadMaterial(request)).rejects.toMatchObject({
      name: 'UnexpectedResponseError',
    });
  });

  it('rejects with a TypeError when the network fails and with AbortError when cancelled', async () => {
    stubXhr(() => ({ status: 0, networkError: true }));
    await expect(uploadMaterial(request)).rejects.toBeInstanceOf(TypeError);

    stubXhr(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = uploadMaterial({ ...request, signal: controller.signal });
    controller.abort();
    const error: unknown = await pending.catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
  });
});

describe('Retry-After handling', () => {
  const busy = (retryAfterSeconds: number | null): ApiRequestError =>
    new ApiRequestError({ status: 429, code: 'too_many_uploads', retryAfterSeconds });

  it('clamps the wait to 1..60 seconds and defaults to 5', () => {
    expect(busyDelayMs(busy(0))).toBe(1000);
    expect(busyDelayMs(busy(7))).toBe(7000);
    expect(busyDelayMs(busy(3600))).toBe(60_000);
    expect(busyDelayMs(busy(null))).toBe(5000);
  });
});

describe('transient failures', () => {
  it('are network errors and 5xx answers only', () => {
    expect(isTransientFailure(new TypeError('offline'))).toBe(true);
    expect(isTransientFailure(new ApiRequestError({ status: 503, code: null }))).toBe(true);
    expect(isTransientFailure(new ApiRequestError({ status: 422, code: 'upload_rejected' }))).toBe(
      false,
    );
    expect(isTransientFailure(new ApiRequestError({ status: 409, code: 'inputs_locked' }))).toBe(
      false,
    );
  });
});

describe('describeLimit', () => {
  it('writes minutes where it can', () => {
    expect(describeLimit(testTranslator('capture'), 600_000)).toBe('10 minutes');
    expect(describeLimit(testTranslator('capture'), 60_000)).toBe('1 minute');
    expect(describeLimit(testTranslator('capture'), 90_000)).toBe('90 seconds');
  });
});
