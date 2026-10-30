import type { ProjectDetailResponse, ProjectMaterial } from '@evidomo/shared';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { projectMaterialFileUrl } from '@evidomo/shared';
import { useTranslations } from 'use-intl';
import { useDeleteMaterial, useRefreshProject } from '../lib/materials';
import { usePhotoUploads, type PhotoItem } from '../lib/photo-upload-queue';
import { describeRequestFailure } from '../lib/request-failure';

function Thumbnail({ src, label }: { src: string; label: string }) {
  const t = useTranslations('capture');
  const [failed, setFailed] = useState(false);
  // The stored-file endpoint may be missing or the file gone: keep the tile, drop the image.
  if (failed) {
    return (
      <div className="flex aspect-4/3 items-center justify-center rounded-field bg-base-200 p-2 text-center text-sm text-base-content/70">
        {t('photos.previewUnavailable')}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- an owner-only API file or a blob: URL; next/image cannot optimise either
    <img
      src={src}
      alt={label}
      loading="lazy"
      className="aspect-4/3 w-full rounded-field bg-base-200 object-cover"
      onError={() => setFailed(true)}
    />
  );
}

interface StoredTileProps {
  projectId: string;
  material: ProjectMaterial;
  preview: string | undefined;
  locked: boolean;
  deleting: boolean;
  onDelete: (material: ProjectMaterial) => void;
}

function StoredTile({ projectId, material, preview, locked, deleting, onDelete }: StoredTileProps) {
  const t = useTranslations('capture');
  const label = t('photos.photoN', { position: material.position });
  return (
    <li className="flex flex-col gap-2">
      <Thumbnail src={preview ?? projectMaterialFileUrl(projectId, material.id)} label={label} />
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        {!locked && (
          <button
            type="button"
            id={`delete-photo-${material.id}`}
            className="btn btn-ghost min-h-11"
            aria-label={t('photos.deleteLabel', { position: material.position })}
            disabled={deleting}
            onClick={() => onDelete(material)}
          >
            {deleting && <span className="loading loading-spinner loading-xs" aria-hidden />}
            {t('photos.delete')}
          </button>
        )}
      </div>
    </li>
  );
}

interface QueueTileProps {
  item: PhotoItem;
  onRetry: (id: string) => void;
  onSkip: (id: string) => void;
  onDismiss: (id: string) => void;
}

function QueueTile({ item, onRetry, onSkip, onDismiss }: QueueTileProps) {
  const t = useTranslations('capture');
  let status;
  switch (item.status) {
    case 'queued':
      status = <span className="text-sm text-base-content/70">{t('photos.waiting')}</span>;
      break;
    case 'preparing':
      status = (
        <span className="flex items-center gap-2 text-sm text-base-content/70">
          <span className="loading loading-spinner loading-xs" aria-hidden />
          {t('photos.preparing')}
        </span>
      );
      break;
    case 'uploading':
      status = (
        <progress
          className="progress progress-primary w-full"
          aria-label={t('photos.uploadingLabel', { name: item.name })}
          value={Math.round(item.progress * 100)}
          max={100}
        />
      );
      break;
    case 'waiting':
      status = (
        <span className="flex items-center gap-2 text-sm text-base-content/70">
          <span className="loading loading-spinner loading-xs" aria-hidden />
          {t('photos.busy')}
        </span>
      );
      break;
    case 'paused':
      status = (
        <p className="text-sm text-error">{t('photos.paused', { error: item.error ?? '' })}</p>
      );
      break;
    case 'failed':
      status = (
        <p className="text-sm text-error">{t('photos.skippedWhy', { error: item.error ?? '' })}</p>
      );
      break;
    default: {
      const unreachable: never = item.status;
      return unreachable;
    }
  }

  return (
    <li className="flex flex-col gap-2">
      {item.previewUrl !== null ? (
        <Thumbnail src={item.previewUrl} label={item.name} />
      ) : (
        <div className="flex aspect-4/3 items-center justify-center rounded-field bg-base-200 p-2 text-center text-sm text-base-content/70">
          <span className="truncate">{item.name}</span>
        </div>
      )}
      <p className="truncate text-sm font-medium">{item.name}</p>
      {status}
      {item.status === 'paused' && (
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-outline min-h-11"
            aria-label={t('photos.retryLabel', { name: item.name })}
            onClick={() => onRetry(item.id)}
          >
            {t('photos.retry')}
          </button>
          <button
            type="button"
            className="btn btn-ghost min-h-11"
            aria-label={t('photos.skipLabel', { name: item.name })}
            onClick={() => onSkip(item.id)}
          >
            {t('photos.skip')}
          </button>
        </div>
      )}
      {item.status === 'waiting' && (
        <button
          type="button"
          className="btn btn-ghost min-h-11 w-fit"
          aria-label={t('photos.skipLabel', { name: item.name })}
          onClick={() => onSkip(item.id)}
        >
          {t('photos.skip')}
        </button>
      )}
      {item.status === 'failed' && (
        <button
          type="button"
          className="btn btn-ghost min-h-11 w-fit"
          aria-label={t('photos.removeLabel', { name: item.name })}
          onClick={() => onDismiss(item.id)}
        >
          {t('photos.remove')}
        </button>
      )}
    </li>
  );
}

/** Take or pick photos, downscale them on the device, upload them one at a time, and manage them. */
export function PhotoCapture({
  detail,
  onPendingChange,
}: {
  detail: ProjectDetailResponse;
  /** True while photos are being prepared, uploaded, or paused: leaving would lose them. */
  onPendingChange: (pending: boolean) => void;
}) {
  const t = useTranslations('capture');
  const tApi = useTranslations('apiErrors');
  const projectId = detail.project.id;
  const { photos } = detail.readiness;
  const locked = detail.readiness.inputsLocked;
  const stored = detail.materials.filter((material) => material.kind === 'photo');

  const refresh = useRefreshProject(projectId);
  const { queue, state } = usePhotoUploads({
    projectId,
    t,
    tApi,
    getCapacity: () => photos.max - photos.count,
    refresh,
  });
  const remove = useDeleteMaterial(projectId);
  const [deleteAnnouncement, setDeleteAnnouncement] = useState('');
  const pickRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const pending = state.items.filter((item) => item.status !== 'failed').length;
  useEffect(() => {
    onPendingChange(pending > 0);
  }, [pending, onPendingChange]);

  // Focus moves when the focused control disappears; the next render applies it.
  const focusTarget = useRef<string | null>(null);
  useEffect(() => {
    if (focusTarget.current === null) return;
    document.getElementById(focusTarget.current)?.focus();
    focusTarget.current = null;
  });
  const full = photos.count + pending >= photos.max;

  function onChosen(event: ChangeEvent<HTMLInputElement>): void {
    const chosen = Array.from(event.target.files ?? []);
    // Clearing lets the same photo be chosen again after a failure.
    event.target.value = '';
    queue.addFiles(chosen);
  }

  function onDelete(material: ProjectMaterial): void {
    const index = stored.findIndex((photo) => photo.id === material.id);
    const neighbour = stored[index + 1] ?? stored[index - 1];
    remove.mutate(material.id, {
      onSuccess: () => {
        queue.forgetPreview(material.id);
        // The next photo's Delete button takes over; with no photo left, the heading does.
        focusTarget.current =
          neighbour === undefined ? 'photos-heading' : `delete-photo-${neighbour.id}`;
        // The remaining count keeps repeated deletions distinct for a screen reader.
        setDeleteAnnouncement(
          t('photos.deleted', { position: material.position, left: stored.length - 1 }),
        );
      },
    });
  }

  function leaveTile(act: (id: string) => void): (id: string) => void {
    return (id) => {
      focusTarget.current = 'photos-heading';
      act(id);
    };
  }

  const deletingId = remove.isPending ? remove.variables : undefined;

  return (
    <section aria-labelledby="photos-heading" className="card border border-base-300 bg-base-100">
      <div className="card-body gap-4">
        <h2 id="photos-heading" tabIndex={-1} className="card-title text-2xl">
          {t('photos.title')}
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          <p>
            <span className="font-medium">
              {t('photos.countOf', { count: photos.count, max: photos.max })}
            </span>
            {photos.required && (
              <span className="text-base-content/70">
                {' '}
                · {t('photos.atLeast', { min: photos.min })}
              </span>
            )}
          </p>
          {photos.required && photos.count >= photos.min && (
            <span className="badge badge-success">{t('photos.enough')}</span>
          )}
        </div>

        {locked ? (
          <div role="note" className="alert alert-info">
            <span>{t('photos.locked')}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              aria-label={t('photos.camera')}
              onChange={onChosen}
            />
            <input
              ref={pickRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              aria-label={t('photos.files')}
              onChange={onChosen}
            />
            {/* The camera only exists as a separate action on touch devices; elsewhere the
                camera input would open the same file chooser. */}
            <button
              type="button"
              className="btn btn-secondary hidden h-14 w-full pointer-coarse:inline-flex sm:h-12 sm:w-56"
              disabled={full}
              onClick={() => cameraRef.current?.click()}
            >
              {t('photos.take')}
            </button>
            <button
              type="button"
              className="btn btn-outline h-14 w-full sm:h-12 sm:w-56"
              disabled={full}
              onClick={() => pickRef.current?.click()}
            >
              {t('photos.choose')}
            </button>
          </div>
        )}
        {!locked && full && (
          <p className="text-sm text-base-content/70">{t('photos.full', { max: photos.max })}</p>
        )}
        {state.notice !== null && (
          <div role="alert" className="alert alert-warning">
            <span>{state.notice}</span>
          </div>
        )}
        {remove.isError && (
          <div role="alert" className="alert alert-error">
            <span>
              {t('photos.deleteFailed', { reason: describeRequestFailure(tApi, remove.error) })}
            </span>
          </div>
        )}

        {stored.length === 0 && state.items.length === 0 ? (
          <p className="text-base-content/70">{t('photos.none')}</p>
        ) : (
          <ul
            aria-labelledby="photos-heading"
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
          >
            {stored.map((material) => (
              <StoredTile
                key={material.id}
                projectId={projectId}
                material={material}
                preview={state.previews[material.id]}
                locked={locked}
                deleting={deletingId === material.id}
                onDelete={onDelete}
              />
            ))}
            {state.items.map((item) => (
              <QueueTile
                key={item.id}
                item={item}
                onRetry={(id) => queue.retry(id)}
                onSkip={leaveTile((id) => queue.skip(id))}
                onDismiss={leaveTile((id) => queue.dismiss(id))}
              />
            ))}
          </ul>
        )}

        <div role="status" aria-live="polite" className="sr-only">
          <span>{state.announcement}</span> <span>{deleteAnnouncement}</span>
        </div>
      </div>
    </section>
  );
}
