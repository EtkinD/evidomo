import { pino, type Logger } from 'pino';
import type { Env } from './env.ts';

export type { Logger };

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: env.LOG_LEVEL,
    // Tests assert on behavior, not log output; keep test runs quiet.
    enabled: env.NODE_ENV !== 'test',
  });
}
