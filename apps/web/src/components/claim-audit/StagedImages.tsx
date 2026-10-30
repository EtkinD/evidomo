import {
  runArtifactFileUrl,
  runMaterialFileUrl,
  type ClaimAuditGateImage,
  type IntegrityAttemptSummary,
  type IntegrityFallback,
} from '@evidomo/shared';
import { useRef } from 'react';
import { describeAuditFailure, type ClaimAuditActions } from '../../lib/claim-audit';
import { humanize } from '../../lib/project-view';

const attemptText = (attempt: IntegrityAttemptSummary): string => {
  if (attempt.status === 'edit_failed') {
    return `Attempt ${attempt.attempt}: the edit failed${attempt.reason === null ? '' : ` (${humanize(attempt.reason)})`}.`;
  }
  if (attempt.status === 'unchecked') {
    return `Attempt ${attempt.attempt}: could not be checked${attempt.target === null ? '' : ` (${attempt.target} image not segmented)`}.`;
  }
  const failed =
    attempt.failedClasses.length === 0 ? '' : `, changed: ${attempt.failedClasses.join(', ')}`;
  const privacy = attempt.privacyPassed === false ? ', a person was drawn in' : '';
  return `Attempt ${attempt.attempt}: ${attempt.passed ? 'passed' : 'failed'}${failed}${privacy}.`;
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
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <figure className="flex flex-col gap-1">
        {/* eslint-disable-next-line @next/next/no-img-element -- an owner-only API file; next/image cannot optimise it */}
        <img
          src={original}
          alt={`Original photo for ${operation}`}
          loading="lazy"
          className="w-full rounded-box bg-base-200 object-contain"
        />
        <figcaption className="badge badge-outline h-auto w-fit whitespace-normal py-1">
          Original
        </figcaption>
      </figure>
      {staged !== null && (
        <figure className="flex flex-col gap-1">
          {/* eslint-disable-next-line @next/next/no-img-element -- an owner-only API file; next/image cannot optimise it */}
          <img
            src={staged}
            alt={`Staged version for ${operation}`}
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
  runId,
  image,
  index,
  readOnly,
  actions,
}: {
  runId: string;
  image: ClaimAuditGateImage;
  index: number;
  readOnly: boolean;
  actions: ClaimAuditActions;
}) {
  const statusRef = useRef<HTMLParagraphElement>(null);
  const operation = `${humanize(image.operation.id)} (photo ${index + 1})`;
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
        aria-label={`Staged image: ${operation}`}
        className={`flex flex-col gap-3 rounded-box border bg-base-100 p-4 ${
          decision === null ? 'border-warning' : 'border-base-300'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">{operation}</h3>
          <span className={`badge gap-1 ${decision === null ? 'badge-warning' : 'badge-success'}`}>
            <span aria-hidden>{decision === null ? '!' : '✓'}</span>
            {decision === null ? 'Open' : 'Decided'}
          </span>
        </div>
        <Photos
          original={runMaterialFileUrl(runId, image.materialId)}
          staged={runArtifactFileUrl(runId, image.artifactId)}
          stagedLabel={image.disclosureLabel}
          operation={operation}
        />
        <p className="text-sm font-medium">
          <span aria-hidden>✓ </span>
          {integrity.outcome === 'passed'
            ? 'Integrity check passed: windows, doors and other fixed elements are unchanged.'
            : 'Integrity check passed on the second attempt: windows, doors and other fixed elements are unchanged.'}
        </p>
        <details className="rounded-box bg-base-200 px-3">
          <summary className="flex min-h-11 cursor-pointer items-center font-medium">
            {`Integrity check for ${operation}`}
          </summary>
          <div className="flex flex-col gap-2 pb-3 text-sm">
            <p>
              Outcome: {integrity.outcome === 'passed' ? 'passed' : 'passed on the second attempt'}.
              Largest aspect change: {(integrity.aspectRatioChange * 100).toFixed(1)}%.
            </p>
            <ul aria-label="Fixed elements" className="list-disc pl-5">
              {integrity.classes.map((entry) => (
                <li key={entry.label}>
                  {humanize(entry.label)}: {entry.originalCount} in the original, {entry.editCount}{' '}
                  in the staged image
                </li>
              ))}
            </ul>
            <ul aria-label="Attempts" className="list-disc pl-5">
              {integrity.attempts.map((attempt) => (
                <li key={attempt.attempt}>{attemptText(attempt)}</li>
              ))}
            </ul>
          </div>
        </details>
        <p ref={statusRef} tabIndex={-1} className="text-sm font-semibold">
          {decision === null
            ? 'Needs your decision.'
            : decision.choice === 'accept'
              ? 'Accepted: the staged image is published next to the original.'
              : 'Rejected: only the original is published.'}
        </p>
        {pending && (
          <p role="status" className="flex items-center gap-2 text-sm text-base-content/70">
            <span className="loading loading-spinner loading-xs" aria-hidden />
            Saving your decision…
          </p>
        )}
        {failure !== null && (
          <p role="alert" className="text-sm text-error">
            {describeAuditFailure(failure)}
          </p>
        )}
        {!readOnly && (
          <p className="text-sm text-base-content/70">
            Accept publishes the staged image next to the original, labelled “
            {image.disclosureLabel}”. Reject publishes only the original.
          </p>
        )}
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            {decision?.choice !== 'accept' && (
              <button
                type="button"
                className="btn btn-outline btn-success min-h-11"
                aria-label={`Accept staged image: ${operation}`}
                disabled={actions.busy}
                onClick={() => send('accept')}
              >
                Accept and publish
              </button>
            )}
            {decision?.choice !== 'reject' && (
              <button
                type="button"
                className="btn btn-outline btn-error min-h-11"
                aria-label={`Reject staged image: ${operation}`}
                disabled={actions.busy}
                onClick={() => send('reject')}
              >
                Reject, keep the original
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function StagedImages({
  runId,
  images,
  fallbacks,
  readOnly,
  actions,
}: {
  runId: string;
  images: readonly ClaimAuditGateImage[];
  fallbacks: readonly IntegrityFallback[];
  readOnly: boolean;
  actions: ClaimAuditActions;
}) {
  if (images.length === 0 && fallbacks.length === 0) return null;
  return (
    <section aria-labelledby="images-heading" className="flex flex-col gap-4">
      <h2 id="images-heading" className="text-xl font-semibold">
        Staged images
      </h2>
      {images.length > 0 && (
        <ul className="flex flex-col gap-4">
          {images.map((image, index) => (
            <ImageCard
              key={image.artifactId}
              runId={runId}
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
          <h3 className="font-semibold">Staging rejected by the integrity check</h3>
          <p className="text-sm text-base-content/70">
            Only the original photo is published for these.
          </p>
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
                    original={runMaterialFileUrl(runId, fallback.materialId)}
                    staged={null}
                    stagedLabel=""
                    operation={`${name} (rejected)`}
                  />
                  <ul className="list-disc pl-5 text-sm">
                    {fallback.attempts.map((attempt) => (
                      <li key={attempt.attempt}>{attemptText(attempt)}</li>
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
