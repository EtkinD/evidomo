import type { DemoRun } from '@evidomo/shared';
import Link from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'use-intl';
import { ApiRequestError } from '../../lib/api';
import { formatDemoDate, languageLabel, marketLabel, useDemoRuns } from '../../lib/demo';
import { LoadingBlock } from '../PageStates';

function DemoRunCard({ run }: { run: DemoRun }) {
  const t = useTranslations('demo');
  const locale = useLocale();
  const format = useFormatter();
  return (
    // The title is the link; `after:inset-0` stretches it over the whole card.
    <li className="lift relative bg-base-100 shadow-sheet">
      <div className="flex flex-col gap-2 p-5">
        <h2 className="text-2xl font-medium">
          <Link
            href={`/demo/runs/${run.id}`}
            className="inline-flex min-h-11 items-center after:absolute after:inset-0"
          >
            {run.title}
          </Link>
        </h2>
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-base-content/70">
          <div className="flex gap-1">
            <dt>{t('market')}</dt>
            <dd>{marketLabel(run.marketProfileId, locale)}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t('language')}</dt>
            <dd>{languageLabel(run.outputLanguage, locale)}</dd>
          </div>
          {run.finishedAt !== null && (
            <div className="flex gap-1">
              <dt>{t('finishedOn')}</dt>
              <dd>{formatDemoDate(format, run.finishedAt)}</dd>
            </div>
          )}
        </dl>
      </div>
    </li>
  );
}

export function DemoRunList() {
  const t = useTranslations('demo');
  const query = useDemoRuns();

  if (query.data === undefined) {
    if (!query.isError) return <LoadingBlock label={t('loadingRuns')} />;
    const limited = query.error instanceof ApiRequestError && query.error.status === 429;
    return (
      <div role="alert" className="alert alert-error alert-vertical sm:alert-horizontal">
        <span>{limited ? t('tooManyRequests') : t('loadError')}</span>
        <button type="button" className="btn min-h-11" onClick={() => void query.refetch()}>
          {t('tryAgain')}
        </button>
      </div>
    );
  }

  if (query.data.runs.length === 0) {
    return (
      <div role="status" className="alert alert-info alert-vertical sm:alert-horizontal">
        <span>{t('noneYet')}</span>
        <Link href="/" className="btn min-h-11">
          {t('home')}
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
