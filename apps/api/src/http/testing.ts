// Test support for HTTP tests that do not exercise the run or project routes. Imported only by
// tests.
import { serviceDefinitionSchema } from '@evidomo/shared';
import type { AppRunDeps } from '../app.ts';
import type { AppProjectDeps } from '../projects/compose.ts';
import type { Storage } from '../storage/storage.ts';

const unusedEngine = (): Promise<never> =>
  Promise.reject(new Error('The run engine is not used here'));

/** Run dependencies that fail loudly if a test reaches them by accident. */
export function unusedRunDeps(): AppRunDeps {
  return {
    engine: { resumeAfterGate: unusedEngine, startRun: unusedEngine },
    markets: {
      getMarket: () => {
        throw new Error('The definition registry is not used here');
      },
    },
    services: {
      getService: () => {
        throw new Error('The definition registry is not used here');
      },
    },
  };
}

const unusedStorageCall = (): Promise<never> =>
  Promise.reject(new Error('Storage is not used here'));

/** Storage that fails loudly if a test reaches it by accident. */
export function unusedStorage(): Storage {
  return {
    put: unusedStorageCall,
    get: unusedStorageCall,
    stat: unusedStorageCall,
    delete: unusedStorageCall,
    exists: unusedStorageCall,
  };
}

/**
 * A capturable `listing-launch` v1 stand-in: the project routes resolve the pinned service when
 * the app is built, so even tests that never reach them need one.
 */
const PINNED_SERVICE_STAND_IN = serviceDefinitionSchema.parse({
  id: 'listing-launch',
  version: 1,
  name: 'Listing launch (test stand-in)',
  inputs: [
    { key: 'photos', type: 'images', min: 10, max: 30, required: true },
    { key: 'voice_memo', type: 'audio', max_seconds: 600, required: true },
    {
      key: 'facts',
      type: 'form',
      schema: 'from_market_profile',
      source_of_truth: true,
      required: true,
    },
  ],
  steps: [{ id: 'export', agent: 'exporter' }],
  budget: { max_cost_usd_per_run: '1.00' },
});

/** Project dependencies that fail loudly if a test reaches them by accident. */
export function unusedProjectDeps(): AppProjectDeps {
  const unused = (): never => {
    throw new Error('The definition registry is not used here');
  };
  return {
    definitions: { markets: [], getMarket: unused, getService: () => PINNED_SERVICE_STAND_IN },
    dailyCapUsd: '0.00',
  };
}
