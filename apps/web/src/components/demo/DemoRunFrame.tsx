import { runParamsSchema } from '@evidomo/shared';
import Head from 'next/head';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { demoRunSource, RunSourceProvider } from '../../lib/run-source';
import { LoadingState, RunNotFound } from '../RunMonitor';
import { DemoBanner } from './DemoBanner';

/**
 * The page around one demo run screen: the banner, the card, the run ID from the route, and the
 * demo source for everything inside. No `AuthGate` is involved (the pages set no `auth`), so
 * nothing here waits for or needs a session.
 */
export function DemoRunFrame({
  page,
  widthClass,
  children,
}: {
  page: 'monitor' | 'conflicts' | 'review' | 'pack';
  widthClass: string;
  children: (runId: string) => ReactNode;
}) {
  const t = useTranslations('demo');
  const router = useRouter();
  const params = runParamsSchema.safeParse({ runId: router.query['runId'] });

  return (
    <RunSourceProvider source={demoRunSource}>
      <Head>
        <title>{t(`pages.${page}.title`)}</title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <div className={`mx-auto flex flex-col gap-4 ${widthClass}`}>
          <DemoBanner />
          <section className="card border border-base-300 bg-base-100">
            <div className="card-body gap-6">
              {!router.isReady ? (
                <LoadingState label={t(`pages.${page}.loading`)} />
              ) : params.success ? (
                children(params.data.runId)
              ) : (
                <RunNotFound />
              )}
            </div>
          </section>
        </div>
      </main>
    </RunSourceProvider>
  );
}
