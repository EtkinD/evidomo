import { bootDefinitions } from './definitions/boot.ts';
import { loadEnv } from './env.ts';
import { createLogger } from './logger.ts';
import { createMetaClients } from './meta/clients.ts';
import { createFactExtractionHandler } from './pipeline/extraction/handler.ts';
import { createIntakeHandler } from './pipeline/intake/handler.ts';
import { createReconciliationHandler } from './pipeline/reconciliation/handler.ts';
import { createVisionInventoryHandler } from './pipeline/vision/handler.ts';
import { shutdownOnSignals, startWorkerRuntime } from './runs/worker-runtime.ts';
import { createLocalStorage } from './storage/local.ts';
import { createPriceTableCostEstimator } from './usage/ledger.ts';

const env = loadEnv();
const logger = createLogger(env);
// Before pg-boss starts: an invalid definition must stop the process, not a later run.
const registry = await bootDefinitions({ dir: env.DEFINITIONS_DIR, logger });
const estimateCost = createPriceTableCostEstimator();
const storage = createLocalStorage({ rootDir: env.STORAGE_DIR });

let runtime;
try {
  runtime = await startWorkerRuntime({
    env,
    logger,
    engine: {
      registry,
      // Step implementations register here by agent as they land. A step whose agent has no
      // handler yet fails the run with "No step handler is registered for agent ...".
      handlers: {
        intake: createIntakeHandler({ storage, markets: registry }),
        extractor: createFactExtractionHandler({ markets: registry }),
        vision: createVisionInventoryHandler({ storage, markets: registry }),
        reconciler: createReconciliationHandler({ markets: registry }),
      },
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
