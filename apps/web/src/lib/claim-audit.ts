import {
  claimAuditGateResponseSchema,
  runUrl,
  type ClaimAuditCategory,
  type ClaimAuditGateResponse,
  type ClaimAuditGateSegment,
  type ClaimAuditStopReason,
  type ClaimAuditWarning,
  type ClaimDecisionRequest,
  type ClaimGateDecision,
  type DemoClaimAuditGateResponse,
  type StagedImageDecisionRequest,
} from '@evidomo/shared';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { ApiRequestError, apiJson } from './api';
import { keyLabel } from './evidence';
import { humanize } from './project-view';
import { describeRequestFailure } from './request-failure';
import { runQueryKey } from './run-monitor';
import { runScopedKey, useRunSource } from './run-source';

export const claimAuditPath = (runId: string): string => `${runUrl(runId)}/gates/claim-audit`;
export const claimDecisionPath = (runId: string, claimId: string): string =>
  `${claimAuditPath(runId)}/claims/${encodeURIComponent(claimId)}/decision`;
export const imageDecisionPath = (runId: string, artifactId: string): string =>
  `${claimAuditPath(runId)}/images/${encodeURIComponent(artifactId)}/decision`;
export const claimAuditApprovePath = (runId: string): string => `${claimAuditPath(runId)}/approve`;
export const claimAuditKey = (runId: string) => ['runs', runId, 'claim-audit'] as const;
export const reviewPageHref = (runId: string): string => `/runs/${runId}/review`;

/**
 * Gate 2 as the screen reads it. The demo's response has no `decidedBy`, and the owner's is
 * assignable to this, so one view serves both.
 */
export type ClaimAuditGateData = DemoClaimAuditGateResponse;

export function useClaimAudit(runId: string): UseQueryResult<ClaimAuditGateData> {
  const source = useRunSource();
  return useQuery({
    queryKey: runScopedKey(source, runId, 'claim-audit'),
    queryFn: ({ signal }) =>
      apiJson(source.claimAuditUrl(runId), source.claimAuditSchema, { signal }),
  });
}

export interface DecideClaimVariables {
  claimId: string;
  body: ClaimDecisionRequest;
}

export interface DecideImageVariables {
  artifactId: string;
  body: StagedImageDecisionRequest;
}

export interface ClaimAuditActions {
  claim: UseMutationResult<ClaimAuditGateResponse, Error, DecideClaimVariables>;
  image: UseMutationResult<ClaimAuditGateResponse, Error, DecideImageVariables>;
  approve: UseMutationResult<ClaimAuditGateResponse, Error, void>;
  /** One decision at a time: the response of each replaces the whole gate. */
  busy: boolean;
}

/** Gate states that mean the page showed something the server no longer has. */
const STALE_CODES = new Set(['gate_not_open', 'gate_decisions_pending', 'not_found']);

/**
 * The three writes of Gate 2. Every response is the whole gate, so it replaces the cached copy
 * at once (after cancelling a refetch that started earlier and would land after it). Approval
 * also invalidates the monitor's snapshot, which would otherwise keep showing the pause.
 */
export function useClaimAuditActions(runId: string): ClaimAuditActions {
  const queryClient = useQueryClient();
  const key = claimAuditKey(runId);

  const store = async (gate: ClaimAuditGateResponse): Promise<void> => {
    await queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData(key, gate);
  };
  const refetchWhenStale = (error: Error | null): void => {
    if (error instanceof ApiRequestError && error.code !== null && STALE_CODES.has(error.code)) {
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    }
  };

  const claim = useMutation({
    mutationFn: ({ claimId, body }: DecideClaimVariables) =>
      apiJson(claimDecisionPath(runId, claimId), claimAuditGateResponseSchema, {
        method: 'PUT',
        body,
      }),
    onSuccess: store,
    onSettled: (_data, error) => refetchWhenStale(error),
  });
  const image = useMutation({
    mutationFn: ({ artifactId, body }: DecideImageVariables) =>
      apiJson(imageDecisionPath(runId, artifactId), claimAuditGateResponseSchema, {
        method: 'PUT',
        body,
      }),
    onSuccess: store,
    onSettled: (_data, error) => refetchWhenStale(error),
  });
  const approve = useMutation({
    mutationFn: () =>
      apiJson(claimAuditApprovePath(runId), claimAuditGateResponseSchema, { method: 'POST' }),
    onSuccess: async (gate) => {
      await store(gate);
      void queryClient.invalidateQueries({ queryKey: runQueryKey(runId), exact: true });
    },
    onSettled: (_data, error) => refetchWhenStale(error),
  });

  return { claim, image, approve, busy: claim.isPending || image.isPending || approve.isPending };
}

/** The message under an item after a failed decision or approval. */
export function describeAuditFailure(error: unknown): string {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case 'gate_not_open':
        return 'This review is no longer open, so the decision was not saved. The page now shows its current state.';
      case 'gate_decisions_pending':
        return 'Something still needs a decision, so the pack was not approved. The page now shows what is open.';
      case 'not_found':
        return 'This item was not found. The page now shows its current state.';
      case 'claim_edit_rejected':
        return 'That text did not pass the check against its facts, so it was not saved.';
      case 'validation_failed':
        return 'That decision was not accepted. Check it and try again.';
    }
  }
  return describeRequestFailure(error);
}

export const FLAG_CATEGORY_LABELS: Record<ClaimAuditCategory, string> = {
  claim_support: 'Claim not supported',
  unverifiable_superlative: 'Unverifiable superlative',
  investment_promise: 'Investment promise',
  exclusionary: 'Exclusionary wording',
  area_basis: 'Area basis',
};

export function stopReasonText(reason: ClaimAuditStopReason): string {
  switch (reason) {
    case 'clean':
      return 'The check found no remaining problems in the copy.';
    case 'loop_limit':
      return 'The check reached its limit for rewrites, and some sentences are still flagged. Decide each flagged sentence below.';
    case 'budget':
      return 'The check stopped early to stay within the run’s cost cap, so some sentences may still have problems.';
    case 'revision_failed':
      return 'A rewrite did not work, so the last checked draft is shown with its flags.';
  }
}

/** A short form of a segment for accessible names. */
export function segmentLabel(text: string, max = 48): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export const hasExclusionaryFlag = (segment: ClaimAuditGateSegment): boolean =>
  segment.flags.some((flag) => flag.category === 'exclusionary');

export function decisionStatus(
  segment: ClaimAuditGateSegment,
  decision: ClaimGateDecision | null,
  kind: 'copy' | 'qa',
): string {
  if (decision === null) return 'Needs your decision.';
  switch (decision.choice) {
    case 'accept':
      return 'Approved as written.';
    case 'edit':
      return 'Edited by you.';
    case 'remove':
      return kind === 'qa'
        ? 'Removed. The whole card is dropped from the pack.'
        : segment.flags.length > 0
          ? 'Removed from the pack.'
          : 'Removed.';
  }
}

export function variantTitle(kind: string): string {
  return kind === 'portal' ? 'Portal text' : kind === 'social' ? 'Social caption' : humanize(kind);
}

/** One sentence per warning; `factLabel` is the market's label for a fact key, if it has one. */
export function warningText(
  warning: ClaimAuditWarning,
  factLabel: (key: string) => string | undefined,
): string {
  const where = variantTitle(warning.variant);
  if (warning.kind === 'variant_empty') {
    return `${where}: every segment is removed, so the pack publishes no text for it.`;
  }
  const label = factLabel(warning.factKey) ?? keyLabel(warning.factKey);
  return warning.required
    ? `${where}: the required fact “${label}” is no longer mentioned.`
    : `${where}: the fact “${label}” is no longer mentioned.`;
}

export function warningsFor(
  warnings: readonly ClaimAuditWarning[],
  claimId: string,
): ClaimAuditWarning[] {
  return warnings.filter(
    (warning) =>
      warning.kind === 'market_fact_unmentioned' && warning.removedClaimIds.includes(claimId),
  );
}
