import { bootDefinitions } from './definitions/boot.ts';
import { loadEnv } from './env.ts';
import { createLogger } from './logger.ts';
import { createMetaClients } from './meta/clients.ts';
import { shutdownOnSignals, startWorkerRuntime } from './runs/worker-runtime.ts';
import { createPriceTableCostEstimator } from './usage/ledger.ts';

const env = loadEnv();
const logger = createLogger(env);
// Before pg-boss starts: an invalid definition must stop the process, not a later run.
const registry = await bootDefinitions({ dir: env.DEFINITIONS_DIR, logger });
const estimateCost = createPriceTableCostEstimator();

let runtime;
try {
  runtime = await startWorkerRuntime({
    env,
    logger,
    engine: {
      registry,
      // Step implementations register here by agent as they land (P2-06 and later). Until then
      // a run fails at its first step with "No step handler is registered for agent ...".
      handlers: {},
      createMetaClients: (usage) =>
        createMetaClients({ apiKey: env.MODEL_API_KEY, usage, estimateCost, logger }),
    },
  });
} catch (error) {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
}
shutdownOnSignals(runtime, logger);
logger.info('worker started');
