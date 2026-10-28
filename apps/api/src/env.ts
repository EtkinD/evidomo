import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { usdAmountSchema } from '@evidomo/shared';
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

const envSchema = z
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
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.MODEL_API_KEY === undefined) {
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
  })
  .transform((env) => ({
    ...env,
    DAILY_BUDGET_USD: env.DAILY_BUDGET_USD ?? DEFAULT_DEV_DAILY_BUDGET_USD,
    STORAGE_DIR: env.STORAGE_DIR ?? DEFAULT_DEV_STORAGE_DIR,
  }));

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  override name = 'EnvError';
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
