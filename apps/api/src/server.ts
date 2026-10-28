import { appConfigFromEnv, createApp } from './app.ts';
import { createDbClient } from './db/client.ts';
import { bootDefinitions } from './definitions/boot.ts';
import { loadEnv } from './env.ts';
import { createLogger } from './logger.ts';

const env = loadEnv();
const logger = createLogger(env);
// Before the pool and the port: an invalid definition must stop the process, not a later run.
// The registry is handed to the run engine and routes once they exist (P2-03, P4).
await bootDefinitions({ dir: env.DEFINITIONS_DIR, logger });
const dbClient = createDbClient(env.DATABASE_URL);
const app = createApp({ db: dbClient, logger, config: appConfigFromEnv(env) });

const server = app.listen(env.PORT, (error) => {
  if (error) {
    logger.fatal({ err: error }, 'api failed to start');
    process.exit(1);
  }
  logger.info({ port: env.PORT }, 'api listening');
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'api shutting down');
  server.close((error) => {
    if (error) {
      logger.error({ err: error }, 'error while closing http server');
    }
  });
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
