import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from './env.ts';

describe('loadEnv', () => {
  it('applies defaults and coerces the port', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', PORT: '4100' });

    expect(env).toEqual({
      NODE_ENV: 'development',
      PORT: 4100,
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    });
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadEnv({})).toThrow(EnvError);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://u:p@localhost/db' })).toThrow(EnvError);
  });
});
