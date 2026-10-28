import { PgBoss } from 'pg-boss';
import { loadEnv } from './env.ts';
import { createLogger } from './logger.ts';

const env = loadEnv();
const logger = createLogger(env);

const boss = new PgBoss(env.DATABASE_URL);
boss.on('error', (error) => {
  logger.error({ err: error }, 'pg-boss error');
});

await boss.start();
// Run-step queues and handlers are registered by the run engine (P2-03).
logger.info('worker started');

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'worker shutting down');
  try {
    await boss.stop({ graceful: true });
  } catch (error) {
    logger.error({ err: error }, 'error while stopping pg-boss');
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, (received) => {
    void shutdown(received);
  });
}
