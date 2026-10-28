import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { healthStatusSchema } from '@evidomo/shared';
import { createApp } from './app.ts';

const silentLogger = pino({ enabled: false });

describe('GET /api/healthz', () => {
  it('returns 200 and ok when the database responds', async () => {
    const app = createApp({ db: { ping: () => Promise.resolve() }, logger: silentLogger });

    const response = await request(app).get('/api/healthz');

    expect(response.status).toBe(200);
    expect(healthStatusSchema.parse(response.body)).toEqual({
      status: 'ok',
      checks: { database: 'ok' },
    });
  });

  it('returns 503 and degraded when the database ping fails', async () => {
    const app = createApp({
      db: { ping: () => Promise.reject(new Error('connection refused')) },
      logger: silentLogger,
    });

    const response = await request(app).get('/api/healthz');

    expect(response.status).toBe(503);
    expect(healthStatusSchema.parse(response.body)).toEqual({
      status: 'degraded',
      checks: { database: 'unavailable' },
    });
  });
});
