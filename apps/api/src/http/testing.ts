// Test support for HTTP tests that do not exercise the run routes. Imported only by tests.
import type { AppRunDeps } from '../app.ts';
import type { Storage } from '../storage/storage.ts';

function unused(what: string): never {
  throw new Error(`${what} is not used here`);
}

/** Storage that fails loudly if a test reaches it by accident. */
export function unusedStorage(): Storage {
  const fail = (): Promise<never> => Promise.reject(new Error('Storage is not used here'));
  return { put: fail, get: fail, stat: fail, delete: fail, exists: fail };
}

/** Run dependencies that fail loudly if a test reaches them by accident. */
export function unusedRunDeps(): AppRunDeps {
  return {
    engine: { resumeAfterGate: () => Promise.reject(new Error('The run engine is not used here')) },
    markets: { getMarket: () => unused('The definition registry') },
    services: { getService: () => unused('The definition registry') },
    storage: unusedStorage(),
  };
}
