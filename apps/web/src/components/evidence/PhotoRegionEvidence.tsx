import type { FactSource } from '@evidomo/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { regionInFrame } from '../../lib/evidence';
import { useEvidenceUrls } from './EvidenceProvider';

type PhotoSource = Extract<FactSource, { kind: 'photo_region' }>;

type MaskState = 'pending' | 'ready' | 'failed';

interface PhotoFrameProps {
  factId: string;
  source: PhotoSource;
  subject: string;
}

/**
 * The photo in a fixed 4:3 frame (`object-contain`), so nothing moves when it loads: the API
 * does not send photo dimensions. The mask PNG has the photo's own size, so `mask-size:
 * contain` centred in the same frame lines it up with the photo without any coordinate math.
 */
function PhotoFrame({ factId, source, subject }: PhotoFrameProps) {
  const t = useTranslations('evidence');
  const urls = useEvidenceUrls();
  const photoUrl = urls.materialFile(source.materialId);
  const maskUrl = source.maskArtifactId === undefined ? null : urls.factMask(factId);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [mask, setMask] = useState<MaskState>(maskUrl === null ? 'failed' : 'pending');

  // A CSS mask that fails to load is ignored, which would paint the whole photo. Probe the
  // image first and draw the overlay only once it is known to be there.
  useEffect(() => {
    if (maskUrl === null || natural === null) return;
    const probe = new Image();
    probe.onload = () => setMask('ready');
    probe.onerror = () => setMask('failed');
    probe.src = maskUrl;
    return () => {
      probe.onload = null;
      probe.onerror = null;
    };
  }, [maskUrl, natural]);

  const box =
    natural !== null && mask === 'failed'
      ? regionInFrame(source.region, natural.width / natural.height)
      : null;

  return (
    <div className="relative aspect-4/3 w-full overflow-hidden rounded-box bg-base-200">
      {photoFailed ? (
        <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-base-content/70">
          {t('photoFailed')}
        </p>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- an owner-only API file (or the demo's); next/image cannot optimise it
        <img
          src={photoUrl}
          alt={t('photoEvidenceFor', { subject })}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-contain"
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (naturalWidth > 0 && naturalHeight > 0) {
              setNatural({ width: naturalWidth, height: naturalHeight });
            }
          }}
          onError={() => setPhotoFailed(true)}
        />
      )}
      {mask === 'ready' && maskUrl !== null && (
        <div
          data-testid="mask-overlay"
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-accent/60 mask-contain mask-center mask-no-repeat"
          style={{ maskImage: `url("${maskUrl}")`, WebkitMaskImage: `url("${maskUrl}")` }}
        />
      )}
      {box !== null && (
        <div
          data-testid="region-box"
          aria-hidden
          className="pointer-events-none absolute border-4 border-accent"
          style={{
            left: `${box.left}%`,
            top: `${box.top}%`,
            width: `${box.width}%`,
            height: `${box.height}%`,
          }}
        />
      )}
    </div>
  );
}

/** A photo with the evidence region highlighted; tapping it opens a larger view. */
export function PhotoRegionEvidence({
  factId,
  source,
  subject,
}: PhotoFrameProps & { source: PhotoSource }) {
  const t = useTranslations('evidence');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const caption =
    source.maskArtifactId === undefined ? t('regionOutlined') : t('regionHighlighted');

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{t('photo')}</p>
      <button
        type="button"
        className="block w-full cursor-zoom-in text-left"
        aria-label={t('openLarger', { subject })}
        onClick={() => setOpen(true)}
      >
        <PhotoFrame factId={factId} source={source} subject={subject} />
      </button>
      <p className="text-sm text-base-content/70">{caption}</p>
      <dialog
        ref={dialogRef}
        className="modal"
        aria-labelledby={titleId}
        onClose={() => setOpen(false)}
      >
        {open && (
          <>
            <div className="modal-box flex max-w-4xl flex-col gap-4">
              <h2 id={titleId} className="text-lg font-semibold">
                {t('photoEvidenceFor', { subject })}
              </h2>
              <PhotoFrame factId={factId} source={source} subject={subject} />
              <p className="text-sm text-base-content/70">{caption}</p>
              <form method="dialog" className="modal-action">
                <button className="btn min-h-11">{t('close')}</button>
              </form>
            </div>
            <form method="dialog" className="modal-backdrop">
              <button tabIndex={-1} aria-hidden>
                {t('close')}
              </button>
            </form>
          </>
        )}
      </dialog>
    </div>
  );
}
