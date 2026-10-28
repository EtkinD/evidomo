import { usdAmountSchema } from '@evidomo/shared';
import { z } from 'zod';

// An empty `MODEL_API_KEY=` line in an env file means "not set", not "set to an empty key".
const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

// The safety net for unattended development runs; production must set its own value.
export const DEFAULT_DEV_DAILY_BUDGET_USD = '5.00';

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
  })
  .transform((env) => ({
    ...env,
    DAILY_BUDGET_USD: env.DAILY_BUDGET_USD ?? DEFAULT_DEV_DAILY_BUDGET_USD,
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
