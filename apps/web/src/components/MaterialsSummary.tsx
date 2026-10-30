import {
  projectMaterialFileUrl,
  type ProjectMaterial,
  type ProjectReadiness,
} from '@evidomo/shared';
import Link from 'next/link';
import { useState } from 'react';

const PREVIEW_LIMIT = 6;

function PhotoThumb({ src, label }: { src: string; label: string }) {
  const [failed, setFailed] = useState(false);
  // The stored-file endpoint may be missing or the file gone: keep the tile, drop the image.
  if (failed) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-field bg-base-200 p-1 text-center text-xs text-base-content/70">
        Preview unavailable
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- an owner-only API file; next/image cannot optimise it
    <img
      src={src}
      alt={label}
      loading="lazy"
      className="aspect-square w-full rounded-field bg-base-200 object-cover"
      onError={() => setFailed(true)}
    />
  );
}

/** Counts, a photo preview, and the way into the capture screen (photos and the voice walkthrough). */
export function MaterialsSummary({
  projectId,
  readiness,
  materials = [],
}: {
  projectId: string;
  readiness: ProjectReadiness;
  materials?: readonly ProjectMaterial[];
}) {
  const { photos, voiceMemo } = readiness;
  const previews = materials
    .filter((material) => material.kind === 'photo')
    .slice(0, PREVIEW_LIMIT);
  return (
    <section
      aria-labelledby="materials-heading"
      className="card border border-base-300 bg-base-100"
    >
      <div className="card-body gap-5">
        <h2 id="materials-heading" className="card-title text-2xl">
          Materials
        </h2>
        <div className="flex flex-col gap-2">
          <h3 className="text-lg font-semibold">Photos</h3>
          <p className="text-sm text-base-content/70">
            {photos.count} added
            {photos.required && ` (${photos.min} to ${photos.max} needed)`}
          </p>
          {previews.length > 0 && (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Photo previews">
              {previews.map((material) => (
                <li key={material.id}>
                  <PhotoThumb
                    src={projectMaterialFileUrl(projectId, material.id)}
                    label={`Photo ${material.position}`}
                  />
                </li>
              ))}
            </ul>
          )}
          {photos.count > previews.length && previews.length > 0 && (
            <p className="text-sm text-base-content/70">
              Showing {previews.length} of {photos.count}.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 border-t border-base-300 pt-4">
          <h3 className="text-lg font-semibold">Voice walkthrough</h3>
          <div>
            {voiceMemo.present ? (
              <span className="badge badge-success gap-1">
                <span aria-hidden>✓</span>Recorded
              </span>
            ) : (
              <span className="badge badge-outline">Not recorded yet</span>
            )}
          </div>
        </div>
        <div>
          <Link href={`/projects/${projectId}/capture`} className="btn btn-outline min-h-11">
            {readiness.inputsLocked ? 'View photos and walkthrough' : 'Add photos and walkthrough'}
          </Link>
        </div>
      </div>
    </section>
  );
}
