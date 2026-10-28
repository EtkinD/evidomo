import { PgBoss, type ConstructorOptions } from 'pg-boss';
import { createDbClient } from '../db/client.ts';
import type { Env } from '../env.ts';
import type { Logger } from '../logger.ts';
import {
  createRunEngine,
  type RunEngine,
  type RunEngineOptions,
  type StartWorkersOptions,
} from './engine.ts';

// The worker process: database pool, pg-boss, run engine, and graceful shutdown. `worker.ts`
// runs it with the real step handlers; the crash test runs it in a child process with fake ones.

/** pg-boss settings a test may tighten (supervise and monitor intervals drive crash recovery). */
export type WorkerBossOptions = Pick<
  ConstructorOptions,
  'superviseIntervalSeconds' | 'monitorIntervalSeconds' | 'useListenNotify'
>;

export interface WorkerRuntimeOptions {
  readonly env: Pick<Env, 'DATABASE_URL' | 'DAILY_BUDGET_USD'>;
  readonly logger: Logger;
  readonly engine: Omit<RunEngineOptions, 'db' | 'boss' | 'logger' | 'dailyCapUsd'>;
  readonly boss?: WorkerBossOptions;
  readonly work?: StartWorkersOptions;
  /**
   * How long in-flight steps get to finish after SIGTERM before pg-boss aborts them (their job
   * is then retried by the next worker). Keep it below the container's stop grace period.
   */
  readonly shutdownTimeoutMs?: number;
}

export interface WorkerRuntime {
  readonly engine: RunEngine;
  /** Stops fetching, lets in-flight steps finish or abort, then closes the pool. Idempotent. */
  shutdown(): Promise<void>;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

export async function startWorkerRuntime(options: WorkerRuntimeOptions): Promise<WorkerRuntime> {
  const { env, logger } = options;
  const dbClient = createDbClient(env.DATABASE_URL);
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    useListenNotify: true,
    ...options.boss,
  });
  boss.on('error', (error) => {
    logger.error({ err: error }, 'pg-boss error');
  });
  boss.on('warning', (warning) => {
    logger.warn({ warning }, 'pg-boss warning');
  });

  const engine = createRunEngine({
    ...options.engine,
    db: dbClient.db,
    boss,
    logger,
    dailyCapUsd: env.DAILY_BUDGET_USD,
  });

  try {
    await boss.start();
    await engine.startWorkers(options.work);
  } catch (error) {
    // Release what was opened, then let the caller decide how to exit.
    await boss.stop({ graceful: false }).catch((stopError: unknown) => {
      logger.error({ err: stopError }, 'error while stopping pg-boss after a failed start');
    });
    await dbClient.close().catch((closeError: unknown) => {
      logger.error({ err: closeError }, 'error while closing the database pool');
    });
    throw error;
  }

  let stopping: Promise<void> | undefined;
  async function stop(): Promise<void> {
    // pg-boss stops fetching, waits up to the timeout for in-flight handlers, then fails and
    // aborts the rest (the engine records them as interrupted; pg-boss retries them later).
    try {
      await boss.stop({
        graceful: true,
        timeout: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      });
    } finally {
      // After pg-boss: settling an in-flight step still needs the engine's pool.
      await dbClient.close();
    }
  }

  return {
    engine,
    shutdown() {
      stopping ??= stop();
      return stopping;
    },
  };
}

/**
 * Shuts the runtime down on the first SIGINT or SIGTERM; a second signal falls back to Node's
 * default and terminates at once. Exits with code 1 if the shutdown itself failed.
 */
export function shutdownOnSignals(runtime: WorkerRuntime, logger: Logger): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, (received) => {
      logger.info({ signal: received }, 'worker shutting down');
      runtime.shutdown().then(
        () => {
          logger.info('worker stopped');
        },
        (error: unknown) => {
          logger.error({ err: error }, 'error while shutting down the worker');
          process.exitCode = 1;
        },
      );
    });
  }
}
