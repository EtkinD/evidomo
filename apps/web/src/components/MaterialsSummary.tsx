import type { ProjectReadiness } from '@evidomo/shared';
import Link from 'next/link';

/** Counts, and the way into the capture screen (photos and the voice walkthrough). */
export function MaterialsSummary({
  projectId,
  readiness,
}: {
  projectId: string;
  readiness: ProjectReadiness;
}) {
  const { photos, voiceMemo } = readiness;
  return (
    <section aria-labelledby="materials-heading" className="card bg-base-100 shadow-sm">
      <div className="card-body gap-4">
        <h2 id="materials-heading" className="card-title">
          Materials
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-base-content/70">Photos</dt>
          <dd>
            {photos.count} added
            {photos.required && ` (${photos.min} to ${photos.max} needed)`}
          </dd>
          <dt className="text-base-content/70">Voice walkthrough</dt>
          <dd>{voiceMemo.present ? 'Recorded' : 'Not recorded yet'}</dd>
        </dl>
        <div>
          <Link href={`/projects/${projectId}/capture`} className="btn btn-outline h-12">
            {readiness.inputsLocked ? 'View photos and walkthrough' : 'Add photos and walkthrough'}
          </Link>
        </div>
      </div>
    </section>
  );
}
