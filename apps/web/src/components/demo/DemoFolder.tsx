import Link from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'use-intl';
import { formatDemoDate, languageLabel, marketLabel, useDemoRuns } from '../../lib/demo';
import { useClaimAudit } from '../../lib/claim-audit';
import { useFactConflicts, useRunSnapshotRef } from '../../lib/fact-conflicts';
import { useExportManifest } from '../../lib/pack';
import { demoRunSource } from '../../lib/run-source';

export type DemoTab = 'monitor' | 'conflicts' | 'review' | 'pack';
const TABS: readonly DemoTab[] = ['monitor', 'conflicts', 'review', 'pack'];

/** One line per tab on what happened there in this run, once the screen's data has arrived. */
function useTabLines(runId: string): Partial<Record<DemoTab, string>> {
  const t = useTranslations('demo.tabLines');
  const snapshot = useRunSnapshotRef(runId).data;
  const conflicts = useFactConflicts(runId).data;
  const review = useClaimAudit(runId).data;
  const pack = useExportManifest(runId).data;
  const lines: Partial<Record<DemoTab, string>> = {};
  if (snapshot !== undefined) {
    lines.monitor = t('monitor', {
      done: snapshot.steps.filter((step) => step.status === 'completed').length,
      total: snapshot.steps.length,
    });
  }
  if (conflicts !== undefined) {
    lines.conflicts = t('conflicts', { count: conflicts.conflictCount, open: conflicts.openCount });
  }
  if (review !== undefined) {
    lines.review = t('review', {
      flagged: review.counts.flaggedClaims,
      images: review.counts.offeredImages,
    });
  }
  if (pack !== undefined) {
    lines.pack = t('pack', { files: pack.files.length, ready: pack.readyToPublish ? 'yes' : 'no' });
  }
  return lines;
}

/**
 * The cover and the folder tabs of the sample file. The cover says which property this is (title,
 * market, language, finished date); the tabs persist on every demo screen, each with one line on
 * what happened there in this run.
 */
export function DemoFolder({ runId, page }: { runId: string; page: DemoTab }) {
  const t = useTranslations('demo');
  const locale = useLocale();
  const format = useFormatter();
  const runs = useDemoRuns();
  const run = runs.data?.runs.find((candidate) => candidate.id === runId);
  const lines = useTabLines(runId);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-base-content/70">{t('coverLabel')}</p>
        {run !== undefined && (
          <>
            <p className="font-display text-2xl leading-tight font-medium">{run.title}</p>
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
          </>
        )}
      </header>
      <nav aria-label={t('tabsLabel')}>
        <ul className="grid grid-cols-2 items-stretch gap-1 sm:grid-cols-4">
          {TABS.map((tab) => {
            const current = tab === page;
            return (
              <li key={tab} className="flex">
                <Link
                  href={demoRunSource.hrefs[tab](runId)}
                  aria-current={current ? 'page' : undefined}
                  className={`relative flex min-h-11 w-full flex-col gap-0.5 border border-b-0 px-3 py-2 ${
                    current
                      ? 'z-10 -mb-px border-base-content/40 bg-base-100 pb-3'
                      : 'border-base-content/20 bg-base-300 hover:bg-base-100'
                  }`}
                >
                  <span className={current ? 'font-semibold' : 'font-medium'}>
                    {t(`tabs.${tab}`)}
                  </span>
                  <span className="min-h-4 text-xs leading-snug text-base-content/70">
                    {lines[tab]}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
