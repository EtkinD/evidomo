import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appConfigFromEnv, createApp } from './app.ts';
import { createDbClient, type DbClient } from './db/client.ts';
import { loadEnv } from './env.ts';
import { unusedRunDeps } from './http/testing.ts';

describe('GET /api/healthz against a real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let dbClient: DbClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    dbClient = createDbClient(container.getConnectionUri(), { logger: pino({ enabled: false }) });
  });

  afterAll(async () => {
    await dbClient.close();
    await container.stop();
  });

  it('reports the database as ok', async () => {
    const env = loadEnv({ DATABASE_URL: container.getConnectionUri(), NODE_ENV: 'test' });
    const app = createApp({
      db: dbClient,
      logger: pino({ enabled: false }),
      config: appConfigFromEnv(env),
      runs: unusedRunDeps(),
    });

    const response = await request(app).get('/api/healthz');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });
});
