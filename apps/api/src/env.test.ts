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

  describe('MODEL_API_KEY', () => {
    const DATABASE_URL = 'postgres://u:p@localhost:5432/db';

    it('is optional outside production', () => {
      expect(loadEnv({ DATABASE_URL, NODE_ENV: 'test' }).MODEL_API_KEY).toBeUndefined();
      expect(loadEnv({ DATABASE_URL, NODE_ENV: 'development' }).MODEL_API_KEY).toBeUndefined();
    });

    it('treats an empty value as unset', () => {
      expect(loadEnv({ DATABASE_URL, MODEL_API_KEY: '' }).MODEL_API_KEY).toBeUndefined();
    });

    it('passes a provided key through', () => {
      expect(loadEnv({ DATABASE_URL, MODEL_API_KEY: 'test-key' }).MODEL_API_KEY).toBe('test-key');
    });

    it('is required in production', () => {
      expect(() => loadEnv({ DATABASE_URL, NODE_ENV: 'production' })).toThrow(/MODEL_API_KEY/);
      expect(() => loadEnv({ DATABASE_URL, NODE_ENV: 'production', MODEL_API_KEY: '' })).toThrow(
        EnvError,
      );
      expect(
        loadEnv({ DATABASE_URL, NODE_ENV: 'production', MODEL_API_KEY: 'test-key' }).MODEL_API_KEY,
      ).toBe('test-key');
    });
  });
});
