import {
  type ClaimAuditGateImage,
  type IntegrityAttemptSummary,
  type IntegrityFallback,
} from '@evidomo/shared';
import { useRef } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { describeAuditFailure, type ClaimAuditActions } from '../../lib/claim-audit';
import type { Translator } from '../../lib/i18n';
import { humanize } from '../../lib/project-view';
import { useEvidenceUrls } from '../evidence/EvidenceProvider';

// The scaffolding is translated; reasons, targets, and class labels come from the pipeline.
const attemptText = (t: Translator<'claimAudit'>, attempt: IntegrityAttemptSummary): string => {
  if (attempt.status === 'edit_failed') {
    return attempt.reason === null
      ? t('staged.attemptEditFailed', { n: attempt.attempt })
      : t('staged.attemptEditFailedWhy', { n: attempt.attempt, reason: humanize(attempt.reason) });
  }
  if (attempt.status === 'unchecked') {
    return attempt.target === null
      ? t('staged.attemptUnchecked', { n: attempt.attempt })
      : t('staged.attemptUncheckedTarget', { n: attempt.attempt, target: attempt.target });
  }
  const result = attempt.passed ? t('staged.passed') : t('staged.failed');
  const failed =
    attempt.failedClasses.length === 0
      ? ''
      : t('staged.changedClasses', { classes: attempt.failedClasses.join(', ') });
  const privacy = attempt.privacyPassed === false ? t('staged.personDrawn') : '';
  return t('staged.attemptResult', { n: attempt.attempt, result, failed, privacy });
};

function Photos({
  original,
  staged,
  stagedLabel,
  operation,
}: {
  original: string;
  staged: string | null;
  /** The disclosure label the staged image must be shown with. */
  stagedLabel: string;
  operation: string;
}) {
  const t = useTranslations('claimAudit');
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <figure className="flex flex-col gap-1">
        {/* eslint-disable-next-line @next/next/no-img-element -- an owner-only API file; next/image cannot optimise it */}
        <img
          src={original}
          alt={t('staged.originalAlt', { operation })}
          loading="lazy"
          className="w-full rounded-box bg-base-200 object-contain"
        />
        <figcaption className="badge badge-outline h-auto w-fit whitespace-normal py-1">
          {t('staged.original')}
        </figcaption>
      </figure>
      {staged !== null && (
        <figure className="flex flex-col gap-1">
          {/* eslint-disable-next-line @next/next/no-img-element -- an owner-only API file; next/image cannot optimise it */}
          <img
            src={staged}
            alt={t('staged.stagedAlt', { operation })}
            loading="lazy"
            className="w-full rounded-box bg-base-200 object-contain"
          />
          <figcaption className="badge badge-secondary h-auto w-fit whitespace-normal py-1 text-left">
            {stagedLabel}
          </figcaption>
        </figure>
      )}
    </div>
  );
}

function ImageCard({
  image,
  index,
  readOnly,
  actions,
}: {
  image: ClaimAuditGateImage;
  index: number;
  readOnly: boolean;
  actions: ClaimAuditActions;
}) {
  const t = useTranslations('claimAudit');
  const tApi = useTranslations('apiErrors');
  const format = useFormatter();
  const urls = useEvidenceUrls();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const operation = t('staged.operation', { name: humanize(image.operation.id), n: index + 1 });
  const decision = image.decision;
  const thisImage = actions.image.variables?.artifactId === image.artifactId;
  const failure = actions.image.isError && thisImage ? actions.image.error : null;
  const pending = actions.image.isPending && thisImage;
  const { integrity } = image;

  function send(choice: 'accept' | 'reject') {
    actions.image.mutate(
      { artifactId: image.artifactId, body: { choice } },
      { onSuccess: () => statusRef.current?.focus() },
    );
  }

  return (
    <li>
      <div
        role="group"
        aria-label={t('staged.imageLabel', { operation })}
        className={`flex flex-col gap-3 rounded-box border bg-base-100 p-4 ${
          decision === null ? 'border-warning' : 'border-base-300'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">{operation}</h3>
          <span className={`badge gap-1 ${decision === null ? 'badge-warning' : 'badge-success'}`}>
            <span aria-hidden>{decision === null ? '!' : '✓'}</span>
            {decision === null ? t('open') : t('decided')}
          </span>
        </div>
        <Photos
          original={urls.materialFile(image.materialId)}
          staged={urls.artifactFile(image.artifactId)}
          stagedLabel={image.disclosureLabel}
          operation={operation}
        />
        <p className="text-sm font-medium">
          <span aria-hidden>✓ </span>
          {integrity.outcome === 'passed'
            ? t('staged.integrityPassed')
            : t('staged.integritySecond')}
        </p>
        <details className="rounded-box bg-base-200 px-3">
          <summary className="flex min-h-11 cursor-pointer items-center font-medium">
            {t('staged.integrityFor', { operation })}
          </summary>
          <div className="flex flex-col gap-2 pb-3 text-sm">
            <p>
              {integrity.outcome === 'passed'
                ? t('staged.outcomePassed')
                : t('staged.outcomeSecond')}{' '}
              {t('staged.aspectChange', {
                change: format.number(integrity.aspectRatioChange, {
                  style: 'percent',
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                }),
              })}
            </p>
            <ul aria-label={t('staged.fixedElements')} className="list-disc pl-5">
              {integrity.classes.map((entry) => (
                <li key={entry.label}>
                  {t('staged.classCount', {
                    label: humanize(entry.label),
                    original: entry.originalCount,
                    edit: entry.editCount,
                  })}
                </li>
              ))}
            </ul>
            <ul aria-label={t('staged.attempts')} className="list-disc pl-5">
              {integrity.attempts.map((attempt) => (
                <li key={attempt.attempt}>{attemptText(t, attempt)}</li>
              ))}
            </ul>
          </div>
        </details>
        <p ref={statusRef} tabIndex={-1} className="text-sm font-semibold">
          {decision === null
            ? t('status.needsDecision')
            : decision.choice === 'accept'
              ? t('staged.accepted')
              : t('staged.rejected')}
        </p>
        {pending && (
          <p role="status" className="flex items-center gap-2 text-sm text-base-content/70">
            <span className="loading loading-spinner loading-xs" aria-hidden />
            {t('saving')}
          </p>
        )}
        {failure !== null && (
          <p role="alert" className="text-sm text-error">
            {describeAuditFailure(t, tApi, failure)}
          </p>
        )}
        {!readOnly && (
          <p className="text-sm text-base-content/70">
            {t('staged.explain', { label: image.disclosureLabel })}
          </p>
        )}
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            {decision?.choice !== 'accept' && (
              <button
                type="button"
                className="btn btn-outline btn-success min-h-11"
                aria-label={t('staged.acceptLabel', { operation })}
                disabled={actions.busy}
                onClick={() => send('accept')}
              >
                {t('staged.accept')}
              </button>
            )}
            {decision?.choice !== 'reject' && (
              <button
                type="button"
                className="btn btn-outline btn-error min-h-11"
                aria-label={t('staged.rejectLabel', { operation })}
                disabled={actions.busy}
                onClick={() => send('reject')}
              >
                {t('staged.reject')}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function StagedImages({
  images,
  fallbacks,
  readOnly,
  actions,
}: {
  images: readonly ClaimAuditGateImage[];
  fallbacks: readonly IntegrityFallback[];
  readOnly: boolean;
  actions: ClaimAuditActions;
}) {
  const t = useTranslations('claimAudit');
  const urls = useEvidenceUrls();
  if (images.length === 0 && fallbacks.length === 0) return null;
  return (
    <section aria-labelledby="images-heading" className="flex flex-col gap-4">
      <h2 id="images-heading" className="text-xl font-semibold">
        {t('staged.title')}
      </h2>
      {images.length > 0 && (
        <ul className="flex flex-col gap-4">
          {images.map((image, index) => (
            <ImageCard
              key={image.artifactId}
              image={image}
              index={index}
              readOnly={readOnly}
              actions={actions}
            />
          ))}
        </ul>
      )}
      {fallbacks.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="font-semibold">{t('staged.fallbackTitle')}</h3>
          <p className="text-sm text-base-content/70">{t('staged.fallbackText')}</p>
          <ul className="flex flex-col gap-3">
            {fallbacks.map((fallback) => {
              const name = humanize(fallback.operationId);
              return (
                <li
                  key={fallback.materialId}
                  className="flex flex-col gap-2 rounded-box border border-base-300 p-3"
                >
                  <p className="font-medium">{name}</p>
                  <Photos
                    original={urls.materialFile(fallback.materialId)}
                    staged={null}
                    stagedLabel=""
                    operation={t('staged.rejectedName', { name })}
                  />
                  <ul className="list-disc pl-5 text-sm">
                    {fallback.attempts.map((attempt) => (
                      <li key={attempt.attempt}>{attemptText(t, attempt)}</li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
