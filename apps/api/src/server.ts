import { PgBoss } from 'pg-boss';
import { appConfigFromEnv, createApp } from './app.ts';
import { createDbClient } from './db/client.ts';
import { bootDefinitions } from './definitions/boot.ts';
import { loadEnv } from './env.ts';
import { createLogger } from './logger.ts';
import { createRunEngine } from './runs/engine.ts';
import { createLocalStorage } from './storage/local.ts';

const env = loadEnv();
const logger = createLogger(env);
// Before the pool and the port: an invalid definition must stop the process, not a later run.
const registry = await bootDefinitions({ dir: env.DEFINITIONS_DIR, logger });
const dbClient = createDbClient(env.DATABASE_URL, { logger });
const storage = createLocalStorage({ rootDir: env.STORAGE_DIR });

// The API only enqueues (a gate decision resumes its run in the same transaction); the worker
// works jobs and runs pg-boss maintenance, so supervision and cron stay off here.
const boss = new PgBoss({ connectionString: env.DATABASE_URL, supervise: false, schedule: false });
boss.on('error', (error) => {
  logger.error({ err: error }, 'pg-boss error');
});
const engine = createRunEngine({
  db: dbClient.db,
  boss,
  registry,
  logger,
  dailyCapUsd: env.DAILY_BUDGET_USD,
});
try {
  await boss.start();
  await engine.ensureQueues();
} catch (error) {
  logger.fatal({ err: error }, 'api failed to start pg-boss');
  await boss.stop({ graceful: false }).catch((stopError: unknown) => {
    logger.error({ err: stopError }, 'error while stopping pg-boss after a failed start');
  });
  await dbClient.close().catch((closeError: unknown) => {
    logger.error({ err: closeError }, 'error while closing the database pool');
  });
  process.exit(1);
}

// Ends open run event streams on shutdown; otherwise `server.close()` waits for them forever.
const streamShutdown = new AbortController();
let app: ReturnType<typeof createApp>;
try {
  app = createApp({
    db: dbClient,
    logger,
    config: appConfigFromEnv(env),
    runs: {
      engine,
      markets: registry,
      services: registry,
      shutdownSignal: streamShutdown.signal,
    },
    storage,
    projects: { definitions: registry, dailyCapUsd: env.DAILY_BUDGET_USD },
  });
} catch (error) {
  // E.g. the pinned service (listing-launch v1) is missing or cannot be captured.
  logger.fatal({ err: error }, 'api failed to build the app');
  await boss.stop({ graceful: false }).catch((stopError: unknown) => {
    logger.error({ err: stopError }, 'error while stopping pg-boss after a failed start');
  });
  await dbClient.close().catch((closeError: unknown) => {
    logger.error({ err: closeError }, 'error while closing the database pool');
  });
  process.exit(1);
}

const server = app.listen(env.PORT, (error) => {
  if (error) {
    logger.fatal({ err: error }, 'api failed to start');
    process.exit(1);
  }
  logger.info({ port: env.PORT }, 'api listening');
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'api shutting down');
  // In-flight requests finish (and commit their enqueues) before pg-boss and the pool close.
  // Event streams never finish on their own: end them (browsers reconnect with Last-Event-ID).
  const closed = new Promise<void>((resolve) => {
    server.close((error) => {
      if (error) {
        logger.error({ err: error }, 'error while closing http server');
      }
      resolve();
    });
  });
  streamShutdown.abort();
  await closed;
  try {
    await boss.stop({ graceful: true, timeout: 5000 });
  } catch (error) {
    logger.error({ err: error }, 'error while stopping pg-boss');
    process.exitCode = 1;
  }
  try {
    await dbClient.close();
  } catch (error) {
    logger.error({ err: error }, 'error while closing database pool');
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, (received) => {
    void shutdown(received);
  });
}
