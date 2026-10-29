import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DEV_APP_ORIGIN,
  DEFAULT_DEV_STORAGE_DIR,
  DEFAULT_SESSION_TTL_DAYS,
  EnvError,
  loadEnv,
} from './env.ts';

describe('loadEnv', () => {
  it('applies defaults and coerces the port', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', PORT: '4100' });

    expect(env).toEqual({
      NODE_ENV: 'development',
      PORT: 4100,
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      DAILY_BUDGET_USD: '5.00',
      STORAGE_DIR: DEFAULT_DEV_STORAGE_DIR,
      APP_ORIGIN: DEFAULT_DEV_APP_ORIGIN,
      SESSION_TTL_DAYS: DEFAULT_SESSION_TTL_DAYS,
      TRUST_PROXY_HOPS: 0,
      RUN_STARTS_PER_ACCOUNT_PER_DAY: 3,
      RUN_STARTS_PER_IP_PER_DAY: 5,
      ACCESS_CODE_FAILURES_PER_IP_PER_HOUR: 10,
      DEMO_RUN_IDS: [],
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
      const production = {
        DATABASE_URL,
        NODE_ENV: 'production',
        DAILY_BUDGET_USD: '20',
        STORAGE_DIR: '/data',
        APP_ORIGIN: 'https://evidomo.example',
      };
      expect(() => loadEnv(production)).toThrow(/MODEL_API_KEY/);
      expect(() => loadEnv({ ...production, MODEL_API_KEY: '' })).toThrow(/MODEL_API_KEY/);
      expect(loadEnv({ ...production, MODEL_API_KEY: 'test-key' }).MODEL_API_KEY).toBe('test-key');
    });
  });

  describe('DAILY_BUDGET_USD', () => {
    const DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    const production = {
      DATABASE_URL,
      NODE_ENV: 'production',
      MODEL_API_KEY: 'test-key',
      STORAGE_DIR: '/data',
      APP_ORIGIN: 'https://evidomo.example',
    };

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

  describe('STORAGE_DIR', () => {
    const DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    const production = {
      DATABASE_URL,
      NODE_ENV: 'production',
      MODEL_API_KEY: 'test-key',
      DAILY_BUDGET_USD: '20',
      APP_ORIGIN: 'https://evidomo.example',
    };

    it('defaults to data/storage at the repository root, also for an empty value', () => {
      const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
      expect(DEFAULT_DEV_STORAGE_DIR).toBe(path.join(repoRoot, 'data', 'storage'));
      expect(loadEnv({ DATABASE_URL }).STORAGE_DIR).toBe(DEFAULT_DEV_STORAGE_DIR);
      expect(loadEnv({ DATABASE_URL, STORAGE_DIR: '' }).STORAGE_DIR).toBe(DEFAULT_DEV_STORAGE_DIR);
    });

    it('accepts an absolute path and normalizes it', () => {
      expect(loadEnv({ DATABASE_URL, STORAGE_DIR: '/data' }).STORAGE_DIR).toBe('/data');
      expect(loadEnv({ DATABASE_URL, STORAGE_DIR: '/srv/x/../data/' }).STORAGE_DIR).toBe(
        '/srv/data',
      );
    });

    it('rejects a relative path', () => {
      expect(() => loadEnv({ DATABASE_URL, STORAGE_DIR: 'data/storage' })).toThrow(/STORAGE_DIR/);
      expect(() => loadEnv({ DATABASE_URL, STORAGE_DIR: './data' })).toThrow(/absolute/);
    });

    it('is required in production', () => {
      expect(() => loadEnv(production)).toThrow(/STORAGE_DIR/);
      expect(loadEnv({ ...production, STORAGE_DIR: '/data' }).STORAGE_DIR).toBe('/data');
    });
  });

  describe('auth settings', () => {
    const DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    const production = {
      DATABASE_URL,
      NODE_ENV: 'production',
      MODEL_API_KEY: 'test-key',
      DAILY_BUDGET_USD: '20',
      STORAGE_DIR: '/data',
    };

    it('defaults APP_ORIGIN to the web dev server outside production, also for an empty value', () => {
      expect(loadEnv({ DATABASE_URL }).APP_ORIGIN).toBe('http://localhost:3000');
      expect(loadEnv({ DATABASE_URL, APP_ORIGIN: '' }).APP_ORIGIN).toBe('http://localhost:3000');
    });

    it('normalizes APP_ORIGIN to a bare origin and rejects paths and other schemes', () => {
      expect(loadEnv({ DATABASE_URL, APP_ORIGIN: 'https://Evidomo.Example/' }).APP_ORIGIN).toBe(
        'https://evidomo.example',
      );
      for (const value of ['https://evidomo.example/app', 'ftp://evidomo.example', 'evidomo']) {
        expect(() => loadEnv({ DATABASE_URL, APP_ORIGIN: value })).toThrow(/APP_ORIGIN/);
      }
    });

    it('requires an https APP_ORIGIN in production, except on localhost', () => {
      expect(() => loadEnv(production)).toThrow(/APP_ORIGIN is required/);
      expect(() => loadEnv({ ...production, APP_ORIGIN: 'http://evidomo.example' })).toThrow(
        /https/,
      );
      expect(loadEnv({ ...production, APP_ORIGIN: 'http://localhost' }).APP_ORIGIN).toBe(
        'http://localhost',
      );
      expect(loadEnv({ ...production, APP_ORIGIN: 'https://evidomo.example' }).APP_ORIGIN).toBe(
        'https://evidomo.example',
      );
    });

    it('defaults TRUST_PROXY_HOPS to 1 behind Caddy in production and 0 elsewhere', () => {
      expect(loadEnv({ DATABASE_URL }).TRUST_PROXY_HOPS).toBe(0);
      expect(
        loadEnv({ ...production, APP_ORIGIN: 'https://evidomo.example' }).TRUST_PROXY_HOPS,
      ).toBe(1);
      expect(loadEnv({ DATABASE_URL, TRUST_PROXY_HOPS: '2' }).TRUST_PROXY_HOPS).toBe(2);
      expect(() => loadEnv({ DATABASE_URL, TRUST_PROXY_HOPS: '-1' })).toThrow(/TRUST_PROXY_HOPS/);
    });

    it('coerces SESSION_TTL_DAYS and bounds it', () => {
      expect(loadEnv({ DATABASE_URL, SESSION_TTL_DAYS: '7' }).SESSION_TTL_DAYS).toBe(7);
      expect(loadEnv({ DATABASE_URL, SESSION_TTL_DAYS: '' }).SESSION_TTL_DAYS).toBe(30);
      for (const value of ['0', '366', '1.5', 'week']) {
        expect(() => loadEnv({ DATABASE_URL, SESSION_TTL_DAYS: value })).toThrow(
          /SESSION_TTL_DAYS/,
        );
      }
    });
  });

  describe('live-run access control and demo runs', () => {
    const DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    const production = {
      DATABASE_URL,
      NODE_ENV: 'production',
      MODEL_API_KEY: 'test-key',
      DAILY_BUDGET_USD: '20',
      STORAGE_DIR: '/data',
      APP_ORIGIN: 'https://evidomo.example',
    };
    const CODE = 'a-synthetic-test-code';

    it('makes LIVE_RUN_ACCESS_CODE optional outside production and for non-API processes', () => {
      expect(loadEnv({ DATABASE_URL }, 'api').LIVE_RUN_ACCESS_CODE).toBeUndefined();
      expect(
        loadEnv({ DATABASE_URL, LIVE_RUN_ACCESS_CODE: '' }).LIVE_RUN_ACCESS_CODE,
      ).toBeUndefined();
      expect(loadEnv(production).LIVE_RUN_ACCESS_CODE).toBeUndefined();
      expect(loadEnv(production, 'worker').LIVE_RUN_ACCESS_CODE).toBeUndefined();
    });

    it('requires LIVE_RUN_ACCESS_CODE for the API in production', () => {
      expect(() => loadEnv(production, 'api')).toThrow(/LIVE_RUN_ACCESS_CODE is required/);
      expect(
        loadEnv({ ...production, LIVE_RUN_ACCESS_CODE: CODE }, 'api').LIVE_RUN_ACCESS_CODE,
      ).toBe(CODE);
    });

    it('rejects short codes and codes with surrounding whitespace', () => {
      for (const value of ['short-code', ` ${CODE}`, `${CODE}\n`, 'x'.repeat(257)]) {
        expect(() => loadEnv({ DATABASE_URL, LIVE_RUN_ACCESS_CODE: value })).toThrow(
          /LIVE_RUN_ACCESS_CODE/,
        );
      }
    });

    it('never puts the code into the error message', () => {
      let message = '';
      try {
        loadEnv({ DATABASE_URL, LIVE_RUN_ACCESS_CODE: ' secret-value-1234' });
      } catch (error) {
        message = error instanceof EnvError ? error.message : 'unexpected error';
      }
      expect(message).toContain('LIVE_RUN_ACCESS_CODE');
      expect(message).not.toContain('secret-value');
    });

    it('lets the demo seed run in production without MODEL_API_KEY', () => {
      const { MODEL_API_KEY: _unused, ...withoutKey } = production;
      expect(() => loadEnv(withoutKey)).toThrow(/MODEL_API_KEY/);
      expect(() => loadEnv(withoutKey, 'api')).toThrow(/MODEL_API_KEY/);
      expect(loadEnv(withoutKey, 'demo-seed').MODEL_API_KEY).toBeUndefined();
    });

    it('coerces the run-start limits and bounds them', () => {
      const env = loadEnv({
        DATABASE_URL,
        RUN_STARTS_PER_ACCOUNT_PER_DAY: '1',
        RUN_STARTS_PER_IP_PER_DAY: '20',
        ACCESS_CODE_FAILURES_PER_IP_PER_HOUR: '',
      });
      expect(env.RUN_STARTS_PER_ACCOUNT_PER_DAY).toBe(1);
      expect(env.RUN_STARTS_PER_IP_PER_DAY).toBe(20);
      expect(env.ACCESS_CODE_FAILURES_PER_IP_PER_HOUR).toBe(10);
      for (const value of ['0', '-1', '1.5', 'many', '10001']) {
        expect(() => loadEnv({ DATABASE_URL, RUN_STARTS_PER_IP_PER_DAY: value })).toThrow(
          /RUN_STARTS_PER_IP_PER_DAY/,
        );
      }
    });

    it('parses DEMO_RUN_IDS as a deduplicated, lower-cased list of UUIDs', () => {
      const a = '3BFCF0BB-5581-4E10-8691-6CC7A8E66DCF';
      const b = '9c1f0a52-7a43-4b8e-9d0e-2f1e3c4b5a69';
      expect(
        loadEnv({ DATABASE_URL, DEMO_RUN_IDS: ` ${a}, ${b},,${a.toLowerCase()} ` }).DEMO_RUN_IDS,
      ).toEqual([a.toLowerCase(), b]);
      expect(loadEnv({ DATABASE_URL, DEMO_RUN_IDS: '' }).DEMO_RUN_IDS).toEqual([]);
      expect(() => loadEnv({ DATABASE_URL, DEMO_RUN_IDS: `${a},not-a-uuid` })).toThrow(
        /DEMO_RUN_IDS/,
      );
      const many = Array.from(
        { length: 21 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
      expect(() => loadEnv({ DATABASE_URL, DEMO_RUN_IDS: many.join(',') })).toThrow(/DEMO_RUN_IDS/);
    });
  });
});
