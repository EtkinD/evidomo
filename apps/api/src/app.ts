import express, { type ErrorRequestHandler, type Express } from 'express';
import type { HealthStatus } from '@evidomo/shared';
import type { DbClient } from './db/client.ts';
import type { Logger } from './logger.ts';

export interface AppDeps {
  db: Pick<DbClient, 'ping'>;
  logger: Logger;
}

export function createApp({ db, logger }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/healthz', async (_req, res) => {
    let database: HealthStatus['checks']['database'] = 'ok';
    try {
      await db.ping();
    } catch (error) {
      logger.error({ err: error }, 'health check: database ping failed');
      database = 'unavailable';
    }

    const body: HealthStatus = {
      status: database === 'ok' ? 'ok' : 'degraded',
      checks: { database },
    };
    res.status(database === 'ok' ? 200 : 503).json(body);
  });

  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    logger.error({ err: error }, 'unhandled request error');
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(handleError);

  return app;
}
