import type { ClaimAuditGateSegment } from '@evidomo/shared';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { ApiRequestError } from '../lib/api';
import {
  describeAuditFailure,
  stopReasonText,
  useClaimAudit,
  useClaimAuditActions,
  variantTitle,
  warningText,
  type ClaimAuditGateData,
} from '../lib/claim-audit';
import type { EvidenceUrls } from '../lib/evidence-urls';
import { useRunSnapshotRef } from '../lib/fact-conflicts';
import { useMarketForm } from '../lib/projects';
import { useRunSource } from '../lib/run-source';
import { EvidencePanel } from './claim-audit/EvidencePanel';
import { SegmentItem, segmentButtonId, type ReviewContext } from './claim-audit/SegmentItem';
import { StagedImages } from './claim-audit/StagedImages';
import { PAGE_TITLE_CLASS } from './DossierPage';
import { EvidenceProvider } from './evidence/EvidenceProvider';
import { labelsFor } from './FactConflicts';
import { LoadErrorState, LoadingState, RunNotFound, SessionExpiredState } from './RunMonitor';

function Warnings({ lines }: { lines: string[] }) {
  const t = useTranslations('claimAudit');
  if (lines.length === 0) return null;
  return (
    <div role="region" aria-label={t('warningsLabel')} className="alert alert-warning">
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
  data: ClaimAuditGateData;
  warningLines: string[];
  open: boolean;
}) {
  const t = useTranslations('claimAudit');
  const { counts } = data;
  return (
    <section aria-labelledby="summary-heading" className="flex flex-col gap-3">
      <h2 id="summary-heading" className="text-2xl font-medium">
        {t('summary')}
      </h2>
      {data.stopReason !== null && <p>{stopReasonText(t, data.stopReason)}</p>}
      <ul className="grid gap-2 sm:grid-cols-2">
        <li className="border-l-4 border-accent bg-base-200 p-3">
          {t('flaggedClaims', { total: counts.flaggedClaims, open: counts.openClaims })}
        </li>
        <li className="border-l-4 border-accent bg-base-200 p-3">
          {t('stagedOffered', { total: counts.offeredImages, open: counts.openImages })}
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
  data: ClaimAuditGateData;
  runId: string;
  actions: ReviewContext['actions'];
  warningLines: string[];
  editingOpen: boolean;
}) {
  const t = useTranslations('claimAudit');
  const tApi = useTranslations('apiErrors');
  const router = useRouter();
  const { approve } = actions;
  const { counts } = data;
  const failure = approve.isError ? approve.error : null;

  return (
    <section
      aria-labelledby="approve-heading"
      className="flex flex-col gap-3 border-l-4 border-secondary bg-base-100 p-4 shadow-sheet"
    >
      <h2 id="approve-heading" className="text-2xl font-medium">
        {t('approveTitle')}
      </h2>
      {data.openCount > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="font-medium">{t('stillOpen')}</p>
          <ul className="list-disc pl-5">
            {counts.openClaims > 0 && <li>{t('openClaims', { count: counts.openClaims })}</li>}
            {counts.openImages > 0 && <li>{t('openImages', { count: counts.openImages })}</li>}
          </ul>
        </div>
      ) : (
        <p>{t('allDecided')}</p>
      )}
      <Warnings lines={warningLines} />
      {editingOpen && <p className="text-sm font-medium">{t('finishEditing')}</p>}
      {failure !== null && (
        <p role="alert" className="text-sm text-error">
          {describeAuditFailure(t, tApi, failure)}
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
          {t('approve')}
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
  const t = useTranslations('claimAudit');
  const headingId = `variant-${title.replaceAll(' ', '-').toLowerCase()}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-xl font-medium">
        {title}
      </h3>
      {segments.length === 0 ? (
        <p className="text-base-content/70">{t('noText')}</p>
      ) : (
        <ul className="flex flex-col gap-1 border-l-2 border-base-content/30 pl-3 font-display text-lg leading-relaxed sm:pl-5">
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
  const t = useTranslations('claimAudit');
  const tCommon = useTranslations('common');
  const source = useRunSource();
  const demo = source.kind === 'demo';
  const gate = useClaimAudit(runId);
  const snapshot = useRunSnapshotRef(runId);
  // The market form is a signed-in route; the demo falls back to plain fact labels.
  const marketQuery = useMarketForm(
    snapshot.data === undefined || demo
      ? undefined
      : { id: snapshot.data.marketProfileId, version: snapshot.data.marketProfileVersion },
  );
  const market = marketQuery.data?.market;
  const labels = useMemo(() => labelsFor(tCommon, market), [tCommon, market]);
  const urls = useMemo(
    () => urlsOverride ?? source.evidenceUrls(runId),
    [runId, source, urlsOverride],
  );
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
      return <LoadingState label={t('loading')} rows={4} />;
    }
    if (gate.error instanceof ApiRequestError && gate.error.status === 404) return <RunNotFound />;
    if (gate.error instanceof ApiRequestError && gate.error.status === 401) {
      return <SessionExpiredState next={`/runs/${runId}/review`} />;
    }
    return (
      <LoadErrorState
        message={t('loadError')}
        error={gate.error}
        onRetry={() => void gate.refetch()}
      />
    );
  }

  const data = gate.data;
  // A demo never writes, so it never shows the open (deciding) form of the review.
  const open = data.state === 'open' && !demo;
  const allSegments = [
    ...data.variants.flatMap((variant) => variant.segments),
    ...data.qaCards.flatMap((card) => card.segments),
  ];
  const selected = allSegments.find((segment) => segment.claimId === selectedId);
  const warningLines = data.warnings.map((warning) =>
    warningText(t, warning, (key) => labels.fact(key)),
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
            href={source.hrefs.monitor(runId)}
            className="link inline-flex min-h-11 w-fit items-center text-sm"
          >
            {t('backToRun')}
          </Link>
          <h1 className={PAGE_TITLE_CLASS}>{open ? t('titleOpen') : t('title')}</h1>
        </div>

        {data.state === 'not_reached' && (
          <div role="status" className="alert alert-info">
            <span>{t('notReached')}</span>
          </div>
        )}
        {data.state === 'suspended' && (
          <div role="alert" className="alert alert-warning">
            <span>{t('suspended')}</span>
          </div>
        )}
        {data.state === 'released' && (
          <div role="status" className="alert alert-info alert-vertical sm:alert-horizontal">
            <span>{demo ? t('releasedDemo') : t('released')}</span>
            <Link href={source.hrefs.pack(runId)} className="btn btn-primary min-h-11">
              {t('openPack')}
            </Link>
          </div>
        )}

        {data.state !== 'not_reached' && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="flex flex-col gap-8">
              <Summary data={data} warningLines={warningLines} open={open} />
              {open && <p className="text-base-content/70">{t('select')}</p>}
              <section aria-labelledby="copy-heading" className="flex flex-col gap-6">
                <h2 id="copy-heading" className="text-2xl font-medium">
                  {t('copy')}
                </h2>
                {data.variants.map((variant) => (
                  <VariantBlock
                    key={variant.kind}
                    title={variantTitle(t, variant.kind)}
                    segments={variant.segments}
                    context={context}
                  />
                ))}
              </section>
              {data.qaCards.length > 0 && (
                <section aria-labelledby="qa-heading" className="flex flex-col gap-4">
                  <h2 id="qa-heading" className="text-2xl font-medium">
                    {t('buyerQuestions')}
                  </h2>
                  <ul className="flex flex-col gap-4">
                    {data.qaCards.map((card) => (
                      <li key={card.card}>
                        <div
                          role="group"
                          aria-label={t('questionLabel', {
                            number: card.card + 1,
                            question: card.question,
                          })}
                          className="flex flex-col gap-2 border-l-4 border-base-content/30 bg-base-200 p-3 sm:p-4"
                        >
                          <p className="font-semibold">{card.question}</p>
                          {card.dropped && <p className="badge badge-neutral">{t('dropped')}</p>}
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
