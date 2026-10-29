import type { RunStatus } from '@evidomo/shared';

/**
 * Whether a project's inputs (materials, fact form, office profile) are fixed. A queued, running,
 * gated, or completed run reads them and its evidence points at them, so they stay fixed; a run
 * that failed produced nothing to publish, so once every run has failed the operator may correct
 * the inputs and start a new run (docs/architecture.md §8 "Project and input API"). Callers check
 * this under the project lock, which run starts also take.
 */
export function inputsLocked(runs: readonly { readonly status: RunStatus }[]): boolean {
  return runs.some((run) => run.status !== 'failed');
}
