import type { ProjectReadiness } from '@evidomo/shared';

/** Read-only counts. The capture flow (photos, voice walkthrough) arrives with P4-03. */
export function MaterialsSummary({ readiness }: { readiness: ProjectReadiness }) {
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
          {/* Text and a badge, not a disabled button: the capture screen does not exist yet. */}
          <p className="flex items-center gap-2 font-medium">
            Capture
            <span className="badge badge-outline">Coming soon</span>
          </p>
          <p className="mt-1 text-sm text-base-content/70">
            Taking photos and recording the walkthrough will be available here.
          </p>
        </div>
      </div>
    </section>
  );
}
