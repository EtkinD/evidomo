import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCESS_CODE_MAX_LENGTH, usdAmountSchema } from '@evidomo/shared';
import { z } from 'zod';

// An empty `MODEL_API_KEY=` line in an env file means "not set", not "set to an empty key".
const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

// The safety net for unattended development runs; production must set its own value.
export const DEFAULT_DEV_DAILY_BUDGET_USD = '5.00';

// `<repo>/data/storage`; `data/` is gitignored. Production sets the `/data` volume explicitly.
export const DEFAULT_DEV_STORAGE_DIR = fileURLToPath(
  new URL('../../../data/storage', import.meta.url),
);

// The Next.js dev server; it proxies `/api/*` to the API so the browser stays same-origin.
export const DEFAULT_DEV_APP_ORIGIN = 'http://localhost:3000';
export const DEFAULT_SESSION_TTL_DAYS = 30;

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const emptyAsUnset = (value: unknown): unknown => (value === '' ? undefined : value);

// A bare origin (`https://evidomo.example`); a trailing slash is accepted and dropped. Anything
// with a path, query, or fragment is a misconfiguration, not an origin.
const originSchema = z
  .url({ protocol: /^https?$/ })
  .refine((value) => {
    // Refinements still run after a failed format check, so the value may not parse.
    const url = URL.parse(value);
    return (
      url !== null &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.username === ''
    );
  }, 'APP_ORIGIN must be a bare origin such as https://evidomo.example')
  .transform((value) => new URL(value).origin);

// Starting a live run needs this code on the public deployment (P4-10). At least 12 characters
// so that, with wrong attempts throttled per IP, guessing it online is impractical; no
// surrounding whitespace, because the API trims the submitted code.
export const ACCESS_CODE_MIN_LENGTH = 12;

const accessCodeSchema = z.preprocess(
  emptyAsUnset,
  z
    .string()
    .min(
      ACCESS_CODE_MIN_LENGTH,
      `LIVE_RUN_ACCESS_CODE must be at least ${ACCESS_CODE_MIN_LENGTH} characters`,
    )
    .max(ACCESS_CODE_MAX_LENGTH)
    .refine(
      (value) => value.trim() === value,
      'LIVE_RUN_ACCESS_CODE must not start or end with whitespace',
    )
    .optional(),
);

/** A positive request budget per window, e.g. run starts per account per day. */
const limitCount = (fallback: number) =>
  z.preprocess(emptyAsUnset, z.coerce.number().int().min(1).max(10_000).default(fallback));

export const DEFAULT_RUN_STARTS_PER_ACCOUNT_PER_DAY = 3;
export const DEFAULT_RUN_STARTS_PER_IP_PER_DAY = 5;
export const DEFAULT_ACCESS_CODE_FAILURES_PER_IP_PER_HOUR = 10;
/** More demo runs than a landing page can sensibly show is a misconfiguration. */
export const MAX_DEMO_RUN_IDS = 20;

// `DEMO_RUN_IDS`: comma-separated run UUIDs whose completed runs the public demo API serves.
// Whatever is listed becomes public without login, so only synthetic demo runs belong here.
const demoRunIdsSchema = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== '')
      : value,
  z
    .array(z.uuid('DEMO_RUN_IDS must be a comma-separated list of run UUIDs'))
    .max(MAX_DEMO_RUN_IDS)
    .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
    .default([]),
);

// `RUN_COSTS_VISIBLE`: `true`/`false` (or `1`/`0`). Anything else is a typo that would silently
// pick a side, so it fails at boot instead.
const booleanFlagSchema = z.preprocess(
  emptyAsUnset,
  z
    .enum(['true', 'false', '1', '0'], 'Expected true or false')
    .transform((value) => value === 'true' || value === '1')
    .optional(),
);

/**
 * Which process reads the environment. Production requirements differ per role:
 * - `worker` (the default; also tests): `MODEL_API_KEY`, `DAILY_BUDGET_USD`, `STORAGE_DIR`, and
 *   `APP_ORIGIN` are required.
 * - `api`: the same plus `LIVE_RUN_ACCESS_CODE` (only the API starts runs, so only it holds the
 *   code).
 * - `demo-seed` (`npm run demo:seed`): `MODEL_API_KEY` is not required; the seed replays
 *   recorded responses and never builds a live client.
 * - `maintenance` (operator scripts such as `npm run storage:sweep`): like `demo-seed`, no
 *   `MODEL_API_KEY`; they touch only the database and storage.
 */
export type EnvRole = 'api' | 'worker' | 'demo-seed' | 'maintenance';

const envSchemaFor = (role: EnvRole) =>
  z
    .object({
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
      LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
      DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
      // Required in production so api/worker fail at boot. Optional elsewhere: tests replay
      // recorded fixtures and never need a real key; the Meta client factory rejects a missing
      // key at the point a live client is actually built.
      MODEL_API_KEY: optionalSecret,
      // Global cap on estimated model spend per UTC day, as an exact decimal string. `0` stops
      // all model calls. Required in production; defaulted below for development and test.
      DAILY_BUDGET_USD: z.preprocess(
        (value) => (value === '' ? undefined : value),
        usdAmountSchema.optional(),
      ),
      // Directory with `services/` and `markets/` definition files. Defaults to the repository's
      // `definitions/` (resolved from the source location, so it also works in the image).
      DEFINITIONS_DIR: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.string().min(1).optional(),
      ),
      // Root of the local storage interface. Absolute, so api, worker, and scripts started from
      // different working directories agree on it. Required in production.
      STORAGE_DIR: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z
          .string()
          .refine((value) => path.isAbsolute(value), 'STORAGE_DIR must be an absolute path')
          .transform((value) => path.resolve(value))
          .optional(),
      ),
      // The browser-facing origin of the web app (Caddy serves web and API on it). State-changing
      // requests from any other Origin are rejected, and an https origin turns on Secure,
      // `__Host-` session cookies. Required in production.
      APP_ORIGIN: z.preprocess(emptyAsUnset, originSchema.optional()),
      // Absolute session lifetime; there is no sliding renewal.
      SESSION_TTL_DAYS: z.preprocess(
        emptyAsUnset,
        z.coerce.number().int().min(1).max(365).default(DEFAULT_SESSION_TTL_DAYS),
      ),
      // Reverse proxies in front of the API whose X-Forwarded-For entry is trusted for the client
      // IP (rate limits). Production has exactly one (Caddy, which discards client-supplied
      // X-Forwarded-For); development has none, so a direct client cannot spoof its IP.
      TRUST_PROXY_HOPS: z.preprocess(
        emptyAsUnset,
        z.coerce.number().int().min(0).max(5).optional(),
      ),
      // The access code for starting live runs. Optional in development and test (no code: run
      // starts need only a session); the API refuses to start without it in production.
      LIVE_RUN_ACCESS_CODE: accessCodeSchema,
      // Run starts per account and per client IP in a rolling-reset 24-hour window, and wrong
      // access codes per client IP per hour (in-process fixed windows, like the login limits).
      RUN_STARTS_PER_ACCOUNT_PER_DAY: limitCount(DEFAULT_RUN_STARTS_PER_ACCOUNT_PER_DAY),
      RUN_STARTS_PER_IP_PER_DAY: limitCount(DEFAULT_RUN_STARTS_PER_IP_PER_DAY),
      ACCESS_CODE_FAILURES_PER_IP_PER_HOUR: limitCount(
        DEFAULT_ACCESS_CODE_FAILURES_PER_IP_PER_HOUR,
      ),
      DEMO_RUN_IDS: demoRunIdsSchema,
      // Whether the run and demo APIs send run costs (snapshot, events, budget amounts in
      // failure reasons) to clients. Costs are for operators: on by default outside production,
      // off in production unless set. Ledger, caps, and stored reasons are unaffected.
      RUN_COSTS_VISIBLE: booleanFlagSchema,
    })
    .superRefine((env, ctx) => {
      if (
        env.NODE_ENV === 'production' &&
        env.MODEL_API_KEY === undefined &&
        role !== 'demo-seed' &&
        role !== 'maintenance'
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['MODEL_API_KEY'],
          message: 'MODEL_API_KEY is required in production',
        });
      }
      if (env.NODE_ENV === 'production' && env.DAILY_BUDGET_USD === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['DAILY_BUDGET_USD'],
          message: 'DAILY_BUDGET_USD is required in production',
        });
      }
      if (env.NODE_ENV === 'production' && env.STORAGE_DIR === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['STORAGE_DIR'],
          message: 'STORAGE_DIR is required in production',
        });
      }
      if (
        env.NODE_ENV === 'production' &&
        role === 'api' &&
        env.LIVE_RUN_ACCESS_CODE === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['LIVE_RUN_ACCESS_CODE'],
          message: 'LIVE_RUN_ACCESS_CODE is required in production',
        });
      }
      if (env.NODE_ENV === 'production') {
        if (env.APP_ORIGIN === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['APP_ORIGIN'],
            message: 'APP_ORIGIN is required in production',
          });
        } else {
          const url = new URL(env.APP_ORIGIN);
          // Plain http is tolerated only for a local run of the production stack.
          if (url.protocol !== 'https:' && !LOCAL_HOSTNAMES.has(url.hostname)) {
            ctx.addIssue({
              code: 'custom',
              path: ['APP_ORIGIN'],
              message: 'APP_ORIGIN must use https in production (except on localhost)',
            });
          }
        }
      }
    })
    .transform((env) => ({
      ...env,
      DAILY_BUDGET_USD: env.DAILY_BUDGET_USD ?? DEFAULT_DEV_DAILY_BUDGET_USD,
      STORAGE_DIR: env.STORAGE_DIR ?? DEFAULT_DEV_STORAGE_DIR,
      APP_ORIGIN: env.APP_ORIGIN ?? DEFAULT_DEV_APP_ORIGIN,
      TRUST_PROXY_HOPS: env.TRUST_PROXY_HOPS ?? (env.NODE_ENV === 'production' ? 1 : 0),
      RUN_COSTS_VISIBLE: env.RUN_COSTS_VISIBLE ?? env.NODE_ENV !== 'production',
    }));

export type Env = z.infer<ReturnType<typeof envSchemaFor>>;

export class EnvError extends Error {
  override name = 'EnvError';
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env, role: EnvRole = 'worker'): Env {
  const result = envSchemaFor(role).safeParse(source);
  if (!result.success) {
    throw new EnvError(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
