import {
  factConflictDecisionResponseSchema,
  factConflictsGateResponseSchema,
  runSnapshotSchema,
  runUrl,
  type FactConflictDecision,
  type FactConflictDecisionRequest,
  type FactConflictDecisionResponse,
  type FactConflictsGateResponse,
  type RunSnapshot,
} from '@evidomo/shared';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { ApiRequestError, apiJson } from './api';
import type { Translator } from './i18n';
import { describeRequestFailure } from './request-failure';
import { runQueryKey } from './run-monitor';
import { runScopedKey, useRunSource } from './run-source';

export const factConflictsPath = (runId: string): string => `${runUrl(runId)}/gates/fact-conflicts`;
export const factConflictDecisionPath = (runId: string, conflictId: string): string =>
  `${factConflictsPath(runId)}/conflicts/${encodeURIComponent(conflictId)}/decision`;
export const factConflictsKey = (runId: string) => ['runs', runId, 'fact-conflicts'] as const;
export const conflictsPageHref = (runId: string): string => `/runs/${runId}/conflicts`;

export function useFactConflicts(runId: string): UseQueryResult<FactConflictsGateResponse> {
  const source = useRunSource();
  return useQuery({
    queryKey: runScopedKey(source, runId, 'fact-conflicts'),
    queryFn: ({ signal }) =>
      apiJson(source.factConflictsUrl(runId), factConflictsGateResponseSchema, { signal }),
  });
}

/**
 * The run snapshot, read only for its market profile (labels and the type of an edited value).
 * It shares the monitor's cache entry; the stream stays the monitor's business.
 */
export function useRunSnapshotRef(runId: string): UseQueryResult<RunSnapshot> {
  const source = useRunSource();
  return useQuery({
    queryKey: runScopedKey(source, runId),
    queryFn: ({ signal }) => apiJson(source.snapshotUrl(runId), runSnapshotSchema, { signal }),
  });
}

export interface DecideVariables {
  conflictId: string;
  body: FactConflictDecisionRequest;
}

/**
 * Saves one decision. The response is the whole gate, so it replaces the cached copy at once;
 * the response that resumed the run also invalidates the monitor's snapshot, which would
 * otherwise keep showing the pause (its cache never goes stale by itself while the run lives).
 */
export function useDecideConflict(
  runId: string,
): UseMutationResult<FactConflictDecisionResponse, Error, DecideVariables> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conflictId, body }: DecideVariables) =>
      apiJson(factConflictDecisionPath(runId, conflictId), factConflictDecisionResponseSchema, {
        method: 'PUT',
        body,
      }),
    onSuccess: async ({ resumed: _resumed, ...gate }) => {
      // A refetch started before the decision would otherwise land after it and show the old gate.
      await queryClient.cancelQueries({ queryKey: factConflictsKey(runId) });
      queryClient.setQueryData(factConflictsKey(runId), gate);
    },
    onSettled: (data, error) => {
      if (data?.resumed === true) {
        void queryClient.invalidateQueries({ queryKey: runQueryKey(runId), exact: true });
      }
      // The gate changed under us (released, reopened, or the conflict is not what we showed):
      // show what the server says now.
      if (
        error instanceof ApiRequestError &&
        (error.code === 'gate_not_open' || error.code === 'fact_not_in_conflict')
      ) {
        void queryClient.invalidateQueries({ queryKey: factConflictsKey(runId), exact: true });
      }
    },
  });
}

/** The message under a conflict after a failed decision. */
export function describeDecisionFailure(
  t: Translator<'conflicts'>,
  tApi: Translator<'apiErrors'>,
  error: unknown,
): string {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case 'gate_not_open':
        return t('failures.gateNotOpen');
      case 'fact_not_in_conflict':
        return t('failures.notInConflict');
      case 'validation_failed':
        // The reason comes from the server and is shown as it was sent.
        return error.issues[0]?.message === undefined
          ? t('failures.notAccepted')
          : t('failures.notAcceptedReason', { reason: error.issues[0].message });
      case 'not_found':
        return t('failures.notFound');
    }
  }
  return describeRequestFailure(tApi, error);
}

/** One line for a decided conflict; `describeValue` formats a stored value. */
export function decisionSummary(
  t: Translator<'conflicts'>,
  decision: FactConflictDecision,
  describeSide: (factIds: readonly string[]) => string | undefined,
  describeValue: (edit: Extract<FactConflictDecision, { choice: 'edit' }>) => string,
): string {
  switch (decision.choice) {
    case 'accept':
      return t('summary.kept', { value: describeSide(decision.factIds) ?? t('summary.oneValue') });
    case 'edit':
      return t('summary.entered', { value: describeValue(decision) });
    case 'reject':
      return t('summary.rejected');
  }
}
