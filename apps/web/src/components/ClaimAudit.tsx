import type { ClaimAuditGateResponse, ClaimAuditGateSegment } from '@evidomo/shared';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useMemo, useState } from 'react';
import { ApiRequestError } from '../lib/api';
import {
  describeAuditFailure,
  stopReasonText,
  useClaimAudit,
  useClaimAuditActions,
  variantTitle,
  warningText,
} from '../lib/claim-audit';
import { runEvidenceUrls, type EvidenceUrls } from '../lib/evidence-urls';
import { useRunSnapshotRef } from '../lib/fact-conflicts';
import { useMarketForm } from '../lib/projects';
import { EvidencePanel } from './claim-audit/EvidencePanel';
import { SegmentItem, segmentButtonId, type ReviewContext } from './claim-audit/SegmentItem';
import { StagedImages } from './claim-audit/StagedImages';
import { EvidenceProvider } from './evidence/EvidenceProvider';
import { labelsFor } from './FactConflicts';
import { LoadErrorState, LoadingState, RunNotFound, SessionExpiredState } from './RunMonitor';

function Warnings({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div role="region" aria-label="Warnings" className="alert alert-warning">
      <ul className="flex flex-col gap-1">
        {lines.map((line) => (
          <li key={line}>
            <span aria-hidden>⚠ </span>
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Summary({
  data,
  warningLines,
  open,
}: {
  data: ClaimAuditGateResponse;
  warningLines: string[];
  open: boolean;
}) {
  const { counts } = data;
  return (
    <section aria-labelledby="summary-heading" className="flex flex-col gap-3">
      <h2 id="summary-heading" className="text-xl font-semibold">
        Summary
      </h2>
      {data.stopReason !== null && <p>{stopReasonText(data.stopReason)}</p>}
      <ul className="grid gap-2 sm:grid-cols-2">
        <li className="rounded-box border border-base-300 bg-base-100 p-3">
          Flagged claims: {counts.flaggedClaims} ({counts.openClaims} open)
        </li>
        <li className="rounded-box border border-base-300 bg-base-100 p-3">
          Staged images offered: {counts.offeredImages} ({counts.openImages} open)
        </li>
      </ul>
      {!open && <Warnings lines={warningLines} />}
    </section>
  );
}

function ApproveSection({
  data,
  runId,
  actions,
  warningLines,
  editingOpen,
}: {
  data: ClaimAuditGateResponse;
  runId: string;
  actions: ReviewContext['actions'];
  warningLines: string[];
  editingOpen: boolean;
}) {
  const router = useRouter();
  const { approve } = actions;
  const { counts } = data;
  const failure = approve.isError ? approve.error : null;

  return (
    <section
      aria-labelledby="approve-heading"
      className="flex flex-col gap-3 rounded-box border-2 border-secondary bg-base-100 p-4"
    >
      <h2 id="approve-heading" className="text-xl font-semibold">
        Approve the pack
      </h2>
      {data.openCount > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="font-medium">Still open before you can approve:</p>
          <ul className="list-disc pl-5">
            {counts.openClaims > 0 && (
              <li>
                {counts.openClaims} flagged {counts.openClaims === 1 ? 'claim' : 'claims'}
              </li>
            )}
            {counts.openImages > 0 && (
              <li>
                {counts.openImages} staged {counts.openImages === 1 ? 'image' : 'images'}
              </li>
            )}
          </ul>
        </div>
      ) : (
        <p>Everything is decided. Approving starts the export of the pack.</p>
      )}
      <Warnings lines={warningLines} />
      {editingOpen && (
        <p className="text-sm font-medium">Save or cancel the text you are editing first.</p>
      )}
      {failure !== null && (
        <p role="alert" className="text-sm text-error">
          {describeAuditFailure(failure)}
        </p>
      )}
      <div>
        <button
          type="button"
          className="btn btn-primary min-h-11"
          disabled={data.openCount > 0 || actions.busy || editingOpen}
          onClick={() =>
            approve.mutate(undefined, { onSuccess: () => void router.push(`/runs/${runId}`) })
          }
        >
          {approve.isPending && <span className="loading loading-spinner loading-xs" aria-hidden />}
          Approve pack
        </button>
      </div>
    </section>
  );
}

function VariantBlock({
  title,
  segments,
  context,
}: {
  title: string;
  segments: readonly ClaimAuditGateSegment[];
  context: ReviewContext;
}) {
  const headingId = `variant-${title.replaceAll(' ', '-').toLowerCase()}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-lg font-semibold">
        {title}
      </h3>
      {segments.length === 0 ? (
        <p className="text-base-content/70">No text.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {segments.map((segment, index) => {
            const startsParagraph =
              index > 0 && segments[index - 1]?.paragraph !== segment.paragraph;
            return (
              <SegmentItem
                key={segment.claimId}
                segment={segment}
                kind="copy"
                cardDropped={false}
                context={context}
                paragraphBreak={startsParagraph}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** `urls` overrides where the evidence files are served from (default: the owner's run routes). */
export function ClaimAuditView({
  runId,
  urls: urlsOverride,
}: {
  runId: string;
  urls?: EvidenceUrls;
}) {
  const gate = useClaimAudit(runId);
  const snapshot = useRunSnapshotRef(runId);
  const marketQuery = useMarketForm(
    snapshot.data === undefined
      ? undefined
      : { id: snapshot.data.marketProfileId, version: snapshot.data.marketProfileVersion },
  );
  const market = marketQuery.data?.market;
  const labels = useMemo(() => labelsFor(market), [market]);
  const urls = useMemo(() => urlsOverride ?? runEvidenceUrls(runId), [runId, urlsOverride]);
  const actions = useClaimAuditActions(runId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingIds, setEditingIds] = useState<ReadonlySet<string>>(new Set());
  const onEditing = useCallback((claimId: string, editing: boolean) => {
    setEditingIds((current) => {
      if (current.has(claimId) === editing) return current;
      const next = new Set(current);
      if (editing) next.add(claimId);
      else next.delete(claimId);
      return next;
    });
  }, []);

  if (gate.data === undefined) {
    if (!gate.isError) {
      return <LoadingState label="Loading the review…" rows={4} />;
    }
    if (gate.error instanceof ApiRequestError && gate.error.status === 404) return <RunNotFound />;
    if (gate.error instanceof ApiRequestError && gate.error.status === 401) {
      return <SessionExpiredState next={`/runs/${runId}/review`} />;
    }
    return (
      <LoadErrorState
        message="We could not load the review. Check your connection and try again."
        onRetry={() => void gate.refetch()}
      />
    );
  }

  const data = gate.data;
  const open = data.state === 'open';
  const allSegments = [
    ...data.variants.flatMap((variant) => variant.segments),
    ...data.qaCards.flatMap((card) => card.segments),
  ];
  const selected = allSegments.find((segment) => segment.claimId === selectedId);
  const warningLines = data.warnings.map((warning) =>
    warningText(warning, (key) => labels.fact(key)),
  );

  const closeEvidence = () => {
    const id = selectedId;
    setSelectedId(null);
    if (id !== null) document.getElementById(segmentButtonId(id))?.focus();
  };
  const context: ReviewContext = {
    readOnly: !open,
    actions,
    selectedId,
    onSelect: (claimId) => {
      if (claimId === selectedId) closeEvidence();
      else setSelectedId(claimId);
    },
    warnings: data.warnings,
    factLabel: (key) => labels.fact(key),
    onEditing,
  };

  return (
    <EvidenceProvider urls={urls}>
      <div className={`flex flex-col gap-6 ${selected === undefined ? '' : 'pb-[70vh] lg:pb-0'}`}>
        <div className="flex flex-col gap-2">
          <Link
            href={`/runs/${runId}`}
            className="link inline-flex min-h-11 w-fit items-center text-sm"
          >
            Back to run
          </Link>
          <h1 className="card-title text-2xl">{open ? 'Review the pack' : 'Pack review'}</h1>
        </div>

        {data.state === 'not_reached' && (
          <div role="status" className="alert alert-info">
            <span>
              The run has not reached this review yet. The copy and staged images appear here once
              the audit is done.
            </span>
          </div>
        )}
        {data.state === 'suspended' && (
          <div role="alert" className="alert alert-warning">
            <span>
              The run stopped while waiting for this review, so decisions are paused. Resume the run
              from its page to reopen the review; the decisions you made are kept.
            </span>
          </div>
        )}
        {data.state === 'released' && (
          <div role="status" className="alert alert-info alert-vertical sm:alert-horizontal">
            <span>This review is finished. Your decisions are shown below.</span>
            <Link href={`/runs/${runId}/pack`} className="btn btn-primary min-h-11">
              Open the pack
            </Link>
          </div>
        )}

        {data.state !== 'not_reached' && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="flex flex-col gap-8">
              <Summary data={data} warningLines={warningLines} open={open} />
              {open && (
                <p className="text-base-content/70">
                  Select any sentence to see the facts and sources behind it. Flagged sentences need
                  a decision.
                </p>
              )}
              <section aria-labelledby="copy-heading" className="flex flex-col gap-6">
                <h2 id="copy-heading" className="text-xl font-semibold">
                  Copy
                </h2>
                {data.variants.map((variant) => (
                  <VariantBlock
                    key={variant.kind}
                    title={variantTitle(variant.kind)}
                    segments={variant.segments}
                    context={context}
                  />
                ))}
              </section>
              {data.qaCards.length > 0 && (
                <section aria-labelledby="qa-heading" className="flex flex-col gap-4">
                  <h2 id="qa-heading" className="text-xl font-semibold">
                    Buyer questions
                  </h2>
                  <ul className="flex flex-col gap-4">
                    {data.qaCards.map((card) => (
                      <li key={card.card}>
                        <div
                          role="group"
                          aria-label={`Question ${card.card + 1}: ${card.question}`}
                          className="flex flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-3"
                        >
                          <p className="font-semibold">{card.question}</p>
                          {card.dropped && (
                            <p className="badge badge-neutral">
                              Dropped: this card is not published.
                            </p>
                          )}
                          <ul className="flex flex-col gap-2">
                            {card.segments.map((segment) => (
                              <SegmentItem
                                key={segment.claimId}
                                segment={segment}
                                kind="qa"
                                cardDropped={card.dropped}
                                context={context}
                              />
                            ))}
                          </ul>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <StagedImages
                runId={runId}
                images={data.images}
                fallbacks={data.integrityFallbacks}
                readOnly={!open}
                actions={actions}
              />
              {open && (
                <ApproveSection
                  data={data}
                  runId={runId}
                  actions={actions}
                  warningLines={warningLines}
                  editingOpen={editingIds.size > 0}
                />
              )}
            </div>
            {selected !== undefined && (
              <EvidencePanel
                segment={selected}
                facts={data.facts}
                labels={labels}
                onClose={closeEvidence}
              />
            )}
          </div>
        )}
      </div>
    </EvidenceProvider>
  );
}
