import { Writable } from 'node:stream';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { apiErrorSchema, healthStatusSchema } from '@evidomo/shared';
import { appConfigFromEnv, createApp, type AppConfig } from './app.ts';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimits } from './auth/config.ts';
import { createDbClient } from './db/client.ts';
import { loadEnv } from './env.ts';
import { unusedProjectDeps, unusedRunDeps, unusedStorage } from './http/testing.ts';

const silentLogger = pino({ enabled: false });

// pg pools connect lazily: nothing in this file reaches the database, and a test that did
// would fail on the unreachable port instead of passing by accident.
const unusedDb = createDbClient('postgres://unused:unused@127.0.0.1:1/unused', {
  logger: silentLogger,
});
afterAll(async () => {
  await unusedDb.close();
});

const devEnv = loadEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', NODE_ENV: 'test' });

function config(
  overrides: { rateLimits?: AuthRateLimits; trustProxyHops?: number } = {},
): AppConfig {
  return appConfigFromEnv(
    { ...devEnv, TRUST_PROXY_HOPS: overrides.trustProxyHops ?? devEnv.TRUST_PROXY_HOPS },
    overrides.rateLimits ?? DEFAULT_AUTH_RATE_LIMITS,
  );
}

function appWith(
  options: { rateLimits?: AuthRateLimits; trustProxyHops?: number; logger?: pino.Logger } = {},
) {
  return createApp({
    db: { ping: () => Promise.resolve(), db: unusedDb.db },
    logger: options.logger ?? silentLogger,
    config: config(options),
    runs: unusedRunDeps(),
    storage: unusedStorage(),
    projects: unusedProjectDeps(),
  });
}

function capturingLogger(): { logger: pino.Logger; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { logger: pino({ level: 'trace' }, stream), output: () => chunks.join('') };
}

const tightRegisterLimit: AuthRateLimits = {
  ...DEFAULT_AUTH_RATE_LIMITS,
  registerPerIp: { limit: 2, windowMs: 60_000 },
};

describe('GET /api/healthz', () => {
  it('returns 200 and ok when the database responds', async () => {
    const response = await request(appWith()).get('/api/healthz');

    expect(response.status).toBe(200);
    expect(healthStatusSchema.parse(response.body)).toEqual({
      status: 'ok',
      checks: { database: 'ok' },
    });
  });

  it('returns 503 and degraded when the database ping fails', async () => {
    const app = createApp({
      db: { ping: () => Promise.reject(new Error('connection refused')), db: unusedDb.db },
      logger: silentLogger,
      config: config(),
      runs: unusedRunDeps(),
      storage: unusedStorage(),
      projects: unusedProjectDeps(),
    });

    const response = await request(app).get('/api/healthz');

    expect(response.status).toBe(503);
    expect(healthStatusSchema.parse(response.body)).toEqual({
      status: 'degraded',
      checks: { database: 'unavailable' },
    });
  });

  it('is not subject to the Origin check (safe method)', async () => {
    const response = await request(appWith())
      .get('/api/healthz')
      .set('Origin', 'https://evil.example');

    expect(response.status).toBe(200);
  });
});

describe('request guards', () => {
  it('rejects a state-changing request from a foreign Origin before reading the body', async () => {
    const response = await request(appWith())
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@example.test', password: 'whatever' });

    expect(response.status).toBe(403);
    expect(apiErrorSchema.parse(response.body)).toEqual({ error: 'forbidden_origin' });
  });

  it('rejects Sec-Fetch-Site: cross-site even without an Origin header', async () => {
    const response = await request(appWith())
      .post('/api/auth/logout')
      .set('Sec-Fetch-Site', 'cross-site');

    expect(response.status).toBe(403);
  });

  it("lets the app's own origin through to validation", async () => {
    const response = await request(appWith())
      .post('/api/auth/register')
      .set('Origin', 'http://localhost:3000')
      .send({ email: 'not-an-email', password: 'short' });

    expect(response.status).toBe(400);
  });

  it('rejects a non-JSON body with 415', async () => {
    for (const [type, body] of [
      ['application/x-www-form-urlencoded', 'email=a%40example.test&password=x'],
      ['text/plain', '{"email":"a@example.test","password":"x"}'],
    ] as const) {
      const response = await request(appWith())
        .post('/api/auth/login')
        .set('Content-Type', type)
        .send(body);

      expect(response.status).toBe(415);
      expect(response.body).toEqual({ error: 'unsupported_media_type' });
    }
  });

  it('answers malformed JSON with 400 and never logs the raw body', async () => {
    const { logger, output } = capturingLogger();
    const secret = 'hunter2-hunter2-hunter2';

    const response = await request(appWith({ logger }))
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(`{"email":"a@example.test","password":"${secret}"`);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_json' });
    expect(output()).toContain('rejected request body');
    expect(output()).not.toContain(secret);
    expect(output()).not.toContain('a@example.test');
  });
});

describe('POST /api/auth/register validation', () => {
  it('lists the failing fields without echoing the submitted values', async () => {
    const response = await request(appWith())
      .post('/api/auth/register')
      .send({ email: 'Not An Email', password: 'tooshort' });

    expect(response.status).toBe(400);
    const body = apiErrorSchema.parse(response.body);
    expect(body.error).toBe('validation_failed');
    expect(body.issues?.map((issue) => issue.path)).toEqual([['email'], ['password']]);
    expect(JSON.stringify(body)).not.toContain('tooshort');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('per-IP rate limiting', () => {
  it('responds 429 with Retry-After once the window is used up', async () => {
    const app = appWith({ rateLimits: tightRegisterLimit });
    const attempt = () => request(app).post('/api/auth/register').send({});

    expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(400);
    const limited = await attempt();

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(59);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  it('buckets by the client IP Caddy forwards when one proxy hop is trusted', async () => {
    const app = appWith({ rateLimits: tightRegisterLimit, trustProxyHops: 1 });
    const from = (ip: string) =>
      request(app).post('/api/auth/register').set('X-Forwarded-For', ip).send({});

    await from('203.0.113.1');
    await from('203.0.113.1');
    expect((await from('203.0.113.1')).status).toBe(429);
    expect((await from('203.0.113.2')).status).toBe(400);
  });

  it('ignores X-Forwarded-For when no proxy is trusted, so clients cannot pick a bucket', async () => {
    const app = appWith({ rateLimits: tightRegisterLimit, trustProxyHops: 0 });
    const from = (ip: string) =>
      request(app).post('/api/auth/register').set('X-Forwarded-For', ip).send({});

    await from('203.0.113.1');
    await from('203.0.113.2');
    expect((await from('203.0.113.3')).status).toBe(429);
  });
});

describe('GET /api/auth/me without a session', () => {
  it('responds 401 without touching the database', async () => {
    const response = await request(appWith()).get('/api/auth/me');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthenticated' });
  });

  it('clears a malformed session cookie without a lookup', async () => {
    const response = await request(appWith())
      .get('/api/auth/me')
      .set('Cookie', 'evidomo_session=not-a-token');

    expect(response.status).toBe(401);
    expect(response.headers['set-cookie']?.[0]).toMatch(/^evidomo_session=;/);
  });
});
