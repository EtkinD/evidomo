import {
  resumeRunResponseSchema,
  runResumeUrl,
  type ResumeRunRequest,
  type ResumeRunResponse,
  type RunSnapshot,
} from '@evidomo/shared';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { ApiRequestError, apiJson } from './api';
import { projectKey, projectsKey } from './projects';
import { runQueryKey } from './run-monitor';
import type { Translator } from './i18n';
import { humanizeWait } from './access-code';
import { describeRequestFailure } from './request-failure';

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
      if (error instanceof ApiRequestError && error.code === 'run_not_resumable') {
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
    switch (error.code) {
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
