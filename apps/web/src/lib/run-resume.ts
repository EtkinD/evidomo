import { runSnapshotSchema, runUrl, type RunSnapshot } from '@evidomo/shared';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { ApiRequestError, apiJson, type ResponseSchema } from './api';
import { projectKey, projectsKey } from './projects';
import { runQueryKey } from './run-monitor';
import type { Translator } from './i18n';
import { humanizeWait } from './access-code';
import { describeRequestFailure } from './request-failure';

// --- Contract (local until the backend branch lands it in `packages/shared`) -----------------
// `POST /api/runs/:runId/resume`, body `{ accessCode?: string }`, 200 `{ run: RunSnapshot }`.
// Errors: 404 `not_found`, 409 `run_not_resumable` (the run is not failed), 409
// `run_budget_exhausted` (failed on its own run cap), 409 `daily_budget_reached`, 403
// `access_code_invalid`, 429 `run_limit_reached` / `rate_limited` with `Retry-After`.
// When the shared package exports these, replace this block with one import.

export interface ResumeRunRequest {
  accessCode?: string;
}
export interface ResumeRunResponse {
  run: RunSnapshot;
}

/**
 * PLACEHOLDER until the backend merge: these names and values are the final contract and are
 * exported by `@evidomo/shared` as `RUN_RESUMABILITY_VALUES`, `RunResumability` (via
 * `runResumabilitySchema`), `RESUME_REFUSAL_CODES`, and `runResumeUrl`. Replace this block with
 * one import. `RunSnapshot.resume` is optional in the schema for now.
 */
export const RUN_RESUMABILITY_VALUES = [
  'not_failed',
  'definition_unavailable',
  'other_run_active',
  'budget_exhausted',
  'inputs_changed',
  'daily_budget_reached',
  'available',
] as const;
export type RunResumability = (typeof RUN_RESUMABILITY_VALUES)[number];

/** The snapshot's `resume` field when the server sends a value this client knows, else undefined. */
export function resumeAvailability(run: RunSnapshot): RunResumability | undefined {
  if (!('resume' in run)) return undefined;
  const value: unknown = run.resume;
  return RUN_RESUMABILITY_VALUES.find((known) => known === value);
}

export const runResumeUrl = (runId: string): string => `${runUrl(runId)}/resume`;

export const resumeRunResponseSchema: ResponseSchema<ResumeRunResponse> = {
  safeParse(data) {
    if (typeof data !== 'object' || data === null || !('run' in data)) return { success: false };
    const run = runSnapshotSchema.safeParse(data.run);
    return run.success ? { success: true, data: { run: run.data } } : { success: false };
  },
};

// --- Hook ------------------------------------------------------------------------------------

export function useResumeRun(
  runId: string,
): UseMutationResult<ResumeRunResponse, Error, ResumeRunRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request) =>
      apiJson(runResumeUrl(runId), resumeRunResponseSchema, { method: 'POST', body: request }),
    onSuccess: ({ run }) => {
      // The monitor's stream effect reopens by itself once the snapshot is no longer terminal.
      queryClient.setQueryData<RunSnapshot>(runQueryKey(runId), run);
      void queryClient.invalidateQueries({ queryKey: projectsKey, exact: true });
      void queryClient.invalidateQueries({ queryKey: projectKey(run.projectId) });
    },
    onError: (error) => {
      // Our copy of the run is stale when the server says it is not failed any more.
      if (error instanceof ApiRequestError && error.rawCode === 'run_not_resumable') {
        void queryClient.invalidateQueries({ queryKey: runQueryKey(runId) });
      }
    },
  });
}

// --- Failure model ---------------------------------------------------------------------------

export type ResumeFailure =
  | { kind: 'code_invalid' }
  | { kind: 'code_rate_limited'; retryAfterSeconds: number | null }
  | { kind: 'run_limit'; retryAfterSeconds: number | null }
  | { kind: 'daily_budget'; retryAfterSeconds: number | null }
  | { kind: 'run_budget_exhausted' }
  | { kind: 'not_resumable' }
  | { kind: 'run_active' }
  | { kind: 'not_found' }
  | { kind: 'message'; message: string };

export function describeResumeFailure(
  tApi: Translator<'apiErrors'>,
  error: unknown,
): ResumeFailure {
  if (error instanceof ApiRequestError) {
    const wait = error.retryAfterSeconds;
    switch (error.rawCode) {
      case 'access_code_invalid':
        return { kind: 'code_invalid' };
      case 'rate_limited':
        return { kind: 'code_rate_limited', retryAfterSeconds: wait };
      case 'run_limit_reached':
        return { kind: 'run_limit', retryAfterSeconds: wait };
      case 'daily_budget_reached':
        return { kind: 'daily_budget', retryAfterSeconds: wait };
      case 'run_budget_exhausted':
        return { kind: 'run_budget_exhausted' };
      case 'run_active':
        return { kind: 'run_active' };
      case 'run_not_resumable':
        return { kind: 'not_resumable' };
      case 'not_found':
        return { kind: 'not_found' };
    }
  }
  return { kind: 'message', message: describeRequestFailure(tApi, error) };
}

/** "in about 3 hours" for a wait the server named, or the generic phrase when it did not. */
export function waitPhrase(
  tReadiness: Translator<'readiness'>,
  seconds: number | null,
): string | null {
  return seconds === null || seconds <= 0 ? null : humanizeWait(tReadiness, seconds);
}

/** The step the run stopped at: the one marked failed, else the one it was working on. */
export function failedStepOf(run: RunSnapshot): RunSnapshot['steps'][number] | undefined {
  return (
    run.steps.find((step) => step.status === 'failed') ??
    run.steps.find((step) => step.stepId === run.currentStepId)
  );
}
