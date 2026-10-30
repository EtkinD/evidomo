import type { DemoRun } from '@evidomo/shared';
import Link from 'next/link';
import { ApiRequestError } from '../../lib/api';
import { formatDemoDate, languageLabel, marketLabel, useDemoRuns } from '../../lib/demo';
import { LoadingBlock } from '../PageStates';

function DemoRunCard({ run }: { run: DemoRun }) {
  return (
    // The title is the link; `after:inset-0` stretches it over the whole card.
    <li className="card relative border border-base-300 bg-base-100">
      <div className="card-body gap-2">
        <h2 className="card-title">
          <Link
            href={`/demo/runs/${run.id}`}
            className="inline-flex min-h-11 items-center after:absolute after:inset-0"
          >
            {run.title}
          </Link>
        </h2>
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-base-content/70">
          <div className="flex gap-1">
            <dt>Market</dt>
            <dd>{marketLabel(run.marketProfileId)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>Language</dt>
            <dd>{languageLabel(run.outputLanguage)}</dd>
          </div>
          {run.finishedAt !== null && (
            <div className="flex gap-1">
              <dt>Finished</dt>
              <dd>{formatDemoDate(run.finishedAt)}</dd>
            </div>
          )}
        </dl>
      </div>
    </li>
  );
}

export function DemoRunList() {
  const query = useDemoRuns();

  if (query.data === undefined) {
    if (!query.isError) return <LoadingBlock label="Loading the demo runs…" />;
    const limited = query.error instanceof ApiRequestError && query.error.status === 429;
    return (
      <div role="alert" className="alert alert-error alert-vertical sm:alert-horizontal">
        <span>
          {limited
            ? 'Too many requests right now. Wait a few seconds and try again.'
            : 'We could not load the demo runs. Check your connection and try again.'}
        </span>
        <button type="button" className="btn min-h-11" onClick={() => void query.refetch()}>
          Try again
        </button>
      </div>
    );
  }

  if (query.data.runs.length === 0) {
    return (
      <div role="status" className="alert alert-info alert-vertical sm:alert-horizontal">
        <span>
          No demo is published yet. A demo run appears here once the operator has published a sample
          run; until then, there is nothing to replay.
        </span>
        <Link href="/" className="btn min-h-11">
          Back to the home page
        </Link>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-4">
      {query.data.runs.map((run) => (
        <DemoRunCard key={run.id} run={run} />
      ))}
    </ul>
  );
}
