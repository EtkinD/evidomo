import { apiErrorSchema, type ApiErrorCode, type ApiValidationIssue } from '@evidomo/shared';

/** The part of a zod schema the client needs; keeps the web app off a direct zod dependency. */
export interface ResponseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

/** A non-2xx response from the API. */
export class ApiRequestError extends Error {
  override name = 'ApiRequestError';
  readonly status: number;
  /** `null` when the body was not a recognised API error (e.g. a proxy's HTML error page). */
  readonly code: ApiErrorCode | null;
  readonly issues: readonly ApiValidationIssue[];
  /** Seconds from the `Retry-After` header, when present and valid. */
  readonly retryAfterSeconds: number | null;

  constructor(init: {
    status: number;
    code: ApiErrorCode | null;
    issues?: readonly ApiValidationIssue[];
    retryAfterSeconds?: number | null;
  }) {
    super(`API request failed with ${init.status} (${init.code ?? 'unrecognised body'})`);
    this.status = init.status;
    this.code = init.code;
    this.issues = init.issues ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

/** A 2xx response whose body does not match the shared contract. */
export class UnexpectedResponseError extends Error {
  override name = 'UnexpectedResponseError';
  readonly status: number;

  constructor(path: string, status: number, options?: ErrorOptions) {
    super(`Unexpected response body from ${path} (${status})`, options);
    this.status = status;
  }
}

/** `Retry-After` is delay-seconds or an HTTP date (RFC 9110 §10.2.3). */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // HTTP dates always carry a day or month name; Date.parse alone would accept "-5" as a year.
  if (!/[a-z]/i.test(trimmed)) return null;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

async function toApiRequestError(response: Response): Promise<ApiRequestError> {
  let body: unknown = undefined;
  try {
    body = await response.json();
  } catch {
    // Not JSON (a proxy or gateway error page): the status still tells the caller enough.
  }
  const parsed = apiErrorSchema.safeParse(body);
  return new ApiRequestError({
    status: response.status,
    code: parsed.success ? parsed.data.error : null,
    issues: parsed.success ? (parsed.data.issues ?? []) : [],
    retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
  });
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method?: Method;
  /** Serialized as JSON. */
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Same-origin request to the API. Throws `ApiRequestError` for a non-2xx response; a network
 * failure rejects with the browser's `TypeError`.
 */
async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = {
    method: options.method ?? 'GET',
    // The session cookie is httpOnly; the browser attaches it to same-origin requests only.
    credentials: 'same-origin',
    headers,
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (options.signal !== undefined) init.signal = options.signal;

  const response = await fetch(path, init);
  if (!response.ok) throw await toApiRequestError(response);
  return response;
}

/** A request whose 2xx body is parsed with `schema` before the caller sees it. */
export async function apiJson<T>(
  path: string,
  schema: ResponseSchema<T>,
  options: RequestOptions = {},
): Promise<T> {
  const response = await send(path, options);
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new UnexpectedResponseError(path, response.status, { cause });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new UnexpectedResponseError(path, response.status);
  return parsed.data;
}

/** A request whose success response carries no body (204). */
export async function apiNoContent(path: string, options: RequestOptions = {}): Promise<void> {
  await send(path, options);
}

/** 4xx responses are deterministic; retrying them only repeats the failure. */
export function isClientError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status >= 400 && error.status < 500;
}
