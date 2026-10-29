import type { DefinitionRegistry } from '../definitions/loader.ts';
import { createExportHandler } from '../export/handler.ts';
import type { StepHandlers } from '../runs/steps.ts';
import type { Storage } from '../storage/storage.ts';
import { createCreativeHandler } from './creative/handler.ts';
import { createFactExtractionHandler } from './extraction/handler.ts';
import { createIntakeHandler } from './intake/handler.ts';
import { createIntegrityHandler } from './integrity/handler.ts';
import { createQaHandler } from './qa/handler.ts';
import { createReconciliationHandler } from './reconciliation/handler.ts';
import { createStagingHandler } from './staging/handler.ts';
import { createVerificationHandler } from './verification/handler.ts';
import { createVisionInventoryHandler } from './vision/handler.ts';

export interface StepHandlerDeps {
  readonly storage: Storage;
  readonly markets: Pick<DefinitionRegistry, 'getMarket'>;
}

/**
 * Every pipeline step implementation, by agent. The worker and the headless pipeline CLI both
 * register exactly this map, so the CLI runs the same steps as production.
 */
export function createStepHandlers(deps: StepHandlerDeps): StepHandlers {
  const { storage, markets } = deps;
  return {
    intake: createIntakeHandler({ storage, markets }),
    extractor: createFactExtractionHandler({ markets }),
    vision: createVisionInventoryHandler({ storage, markets }),
    reconciler: createReconciliationHandler({ markets }),
    creative: createCreativeHandler({ markets }),
    qa_writer: createQaHandler({ markets }),
    stager: createStagingHandler({ storage }),
    integrity_checker: createIntegrityHandler({ storage }),
    verifier: createVerificationHandler({ markets }),
    exporter: createExportHandler({ storage, markets }),
  };
}
