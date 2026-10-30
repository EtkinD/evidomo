import { authUserResponseSchema } from '@evidomo/shared';
import { describe, expect, it } from 'vitest';
import {
  ApiRequestError,
  apiJson,
  apiRequestErrorFrom,
  apiNoContent,
  isClientError,
  parseRetryAfter,
  UnexpectedResponseError,
} from '../lib/api';
import { fetchMe } from '../lib/auth';
import { jsonResponse, meSignedIn, meSignedOut, mockFetch, TEST_USER } from './test-utils';

describe('parseRetryAfter', () => {
  it('reads delay-seconds and HTTP dates', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter('Wed, 28 Oct 2026 12:01:30 GMT', now)).toBe(90);
    expect(parseRetryAfter('Wed, 28 Oct 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('returns null for a missing or invalid header', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('-5')).toBeNull();
  });
});

describe('apiJson', () => {
  it('sends JSON bodies same-origin and parses the response with the schema', async () => {
    const fetchMock = mockFetch({
      'POST /api/auth/login': () => jsonResponse(200, { user: TEST_USER }),
    });

    const result = await apiJson('/api/auth/login', authUserResponseSchema, {
      method: 'POST',
      body: { email: TEST_USER.email, password: 'x' },
    });

    expect(result).toEqual({ user: TEST_USER });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('same-origin');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init?.body).toBe(JSON.stringify({ email: TEST_USER.email, password: 'x' }));
  });

  it('sends no Content-Type without a body', async () => {
    const fetchMock = mockFetch({
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });

    await apiNoContent('/api/auth/logout', { method: 'POST' });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).not.toHaveProperty('Content-Type');
    expect(init?.body).toBeUndefined();
  });

  it('turns an API error body into a typed error with issues and Retry-After', async () => {
    mockFetch({
      'POST /api/auth/register': () =>
        jsonResponse(400, {
          error: 'validation_failed',
          issues: [{ path: ['password'], message: 'Too small' }],
        }),
      'POST /api/auth/login': () =>
        jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '42' }),
    });

    const validation = apiJson('/api/auth/register', authUserResponseSchema, {
      method: 'POST',
      body: {},
    });
    await expect(validation).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 400,
      code: 'validation_failed',
      issues: [{ path: ['password'], message: 'Too small' }],
      retryAfterSeconds: null,
    });

    const limited = apiJson('/api/auth/login', authUserResponseSchema, {
      method: 'POST',
      body: {},
    });
    await expect(limited).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 42,
    });
  });

  it('keeps the status when the error body is not an API error', async () => {
    mockFetch({
      'GET /api/auth/me': () => new Response('<html>Bad Gateway</html>', { status: 502 }),
    });

    const error: unknown = await apiJson('/api/auth/me', authUserResponseSchema).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 502, code: null, issues: [] });
    expect(isClientError(error)).toBe(false);
  });

  it('rejects a 2xx body that does not match the contract', async () => {
    mockFetch({ 'GET /api/auth/me': () => jsonResponse(200, { user: { id: 'not-a-uuid' } }) });

    await expect(apiJson('/api/auth/me', authUserResponseSchema)).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});

describe('fetchMe', () => {
  it('returns the user for 200 and null for 401', async () => {
    mockFetch({ 'GET /api/auth/me': meSignedIn });
    await expect(fetchMe()).resolves.toEqual(TEST_USER);

    mockFetch({ 'GET /api/auth/me': meSignedOut });
    await expect(fetchMe()).resolves.toBeNull();
  });

  it('throws for other failures', async () => {
    mockFetch({ 'GET /api/auth/me': () => jsonResponse(500, { error: 'internal_error' }) });
    await expect(fetchMe()).rejects.toMatchObject({ status: 500, code: 'internal_error' });
  });
});

describe('error codes', () => {
  it('knows the resume codes', () => {
    expect(apiRequestErrorFrom(409, { error: 'run_not_resumable' }, null).code).toBe(
      'run_not_resumable',
    );
  });

  it('leaves the code null for one a future server adds', () => {
    expect(apiRequestErrorFrom(409, { error: 'from_the_future' }, null).code).toBeNull();
    expect(apiRequestErrorFrom(502, '<html>', null).code).toBeNull();
  });
});
