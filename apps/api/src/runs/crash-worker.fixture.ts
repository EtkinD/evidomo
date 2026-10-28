// Child-process worker for crash.integration.test.ts: the real worker runtime (pool, pg-boss,
// run engine, signal handling) with the crash test's service definition and fake handlers.
// Run with `node`; configured through the environment the test passes.
import { z } from 'zod';
import { loadEnv } from '../env.ts';
import { createLogger } from '../logger.ts';
import {
  CRASH_SERVICE,
  CRASH_TEST_TIMING,
  crashTestHandlers,
  placeholderMetaClients,
  testRegistry,
} from './testing.ts';
import { shutdownOnSignals, startWorkerRuntime } from './worker-runtime.ts';

const env = loadEnv();
const logger = createLogger(env);
const shutdownTimeoutMs = z.coerce
  .number()
  .int()
  .positive()
  .default(5000)
  .parse(process.env['SHUTDOWN_TIMEOUT_MS']);

const runtime = await startWorkerRuntime({
  env,
  logger,
  engine: {
    registry: testRegistry(CRASH_SERVICE),
    handlers: crashTestHandlers(),
    createMetaClients: placeholderMetaClients,
    ...CRASH_TEST_TIMING,
  },
  // Crash recovery runs in the supervisor's monitor pass; 1 s keeps the test fast.
  boss: { superviseIntervalSeconds: 1, monitorIntervalSeconds: 1 },
  work: { pollingIntervalSeconds: 0.5 },
  shutdownTimeoutMs,
});
shutdownOnSignals(runtime, logger);
// The test process went away: shut down instead of lingering as an orphan.
process.once('disconnect', () => {
  process.kill(process.pid, 'SIGTERM');
});
process.send?.({ type: 'ready', pid: process.pid });
// An open IPC channel keeps the event loop alive; the worker must exit on its own after a
// graceful shutdown, exactly as it does in production.
process.channel?.unref();
