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
      DAILY_BUDGET_USD: '5.00',
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
      // DAILY_BUDGET_USD is set so these assertions isolate MODEL_API_KEY.
      const production = { DATABASE_URL, NODE_ENV: 'production', DAILY_BUDGET_USD: '20' };
      expect(() => loadEnv(production)).toThrow(/MODEL_API_KEY/);
      expect(() => loadEnv({ ...production, MODEL_API_KEY: '' })).toThrow(/MODEL_API_KEY/);
      expect(loadEnv({ ...production, MODEL_API_KEY: 'test-key' }).MODEL_API_KEY).toBe('test-key');
    });
  });

  describe('DAILY_BUDGET_USD', () => {
    const DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    const production = { DATABASE_URL, NODE_ENV: 'production', MODEL_API_KEY: 'test-key' };

    it('defaults to 5.00 outside production, also for an empty value', () => {
      expect(loadEnv({ DATABASE_URL, NODE_ENV: 'test' }).DAILY_BUDGET_USD).toBe('5.00');
      expect(loadEnv({ DATABASE_URL, DAILY_BUDGET_USD: '' }).DAILY_BUDGET_USD).toBe('5.00');
    });

    it('keeps the configured value as an exact decimal string', () => {
      expect(loadEnv({ DATABASE_URL, DAILY_BUDGET_USD: '12.5' }).DAILY_BUDGET_USD).toBe('12.5');
      expect(loadEnv({ DATABASE_URL, DAILY_BUDGET_USD: '0' }).DAILY_BUDGET_USD).toBe('0');
    });

    it('rejects negative, non-decimal, and over-precise values', () => {
      for (const value of ['-1', 'ten', '1e2', '0.000000001', '10000']) {
        expect(() => loadEnv({ DATABASE_URL, DAILY_BUDGET_USD: value })).toThrow(
          /DAILY_BUDGET_USD/,
        );
      }
    });

    it('is required in production', () => {
      expect(() => loadEnv(production)).toThrow(/DAILY_BUDGET_USD/);
      expect(() => loadEnv({ ...production, DAILY_BUDGET_USD: '' })).toThrow(EnvError);
      expect(loadEnv({ ...production, DAILY_BUDGET_USD: '20' }).DAILY_BUDGET_USD).toBe('20');
    });
  });

  describe('DEFINITIONS_DIR', () => {
    const DATABASE_URL = 'postgres://u:p@localhost:5432/db';

    it('is optional, and an empty value means unset', () => {
      expect(loadEnv({ DATABASE_URL }).DEFINITIONS_DIR).toBeUndefined();
      expect(loadEnv({ DATABASE_URL, DEFINITIONS_DIR: '' }).DEFINITIONS_DIR).toBeUndefined();
    });

    it('passes a configured directory through', () => {
      expect(loadEnv({ DATABASE_URL, DEFINITIONS_DIR: '/srv/definitions' }).DEFINITIONS_DIR).toBe(
        '/srv/definitions',
      );
    });
  });
});
