// Test support for HTTP tests that do not exercise the run routes. Imported only by tests.
import type { AppRunDeps } from '../app.ts';

/** Run dependencies that fail loudly if a test reaches them by accident. */
export function unusedRunDeps(): AppRunDeps {
  return {
    engine: { resumeAfterGate: () => Promise.reject(new Error('The run engine is not used here')) },
    markets: {
      getMarket: () => {
        throw new Error('The definition registry is not used here');
      },
    },
  };
}
