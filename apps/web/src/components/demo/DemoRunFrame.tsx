import { runParamsSchema } from '@evidomo/shared';
import Head from 'next/head';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { demoRunSource, RunSourceProvider } from '../../lib/run-source';
import { LoadingState, RunNotFound } from '../RunMonitor';
import { DossierPage } from '../DossierPage';
import { DemoFolder } from './DemoFolder';
import { DemoRunningHead } from './DemoRunningHead';

/**
 * The page around one demo run screen: the folder (cover and tabs), the sheet with its running head, the run ID from the route, and the
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
      <DossierPage
        widthClass={widthClass}
        banner={params.success ? <DemoFolder runId={params.data.runId} page={page} /> : undefined}
        head={<DemoRunningHead />}
        bare={page === 'pack'}
      >
        {!router.isReady ? (
          <LoadingState label={t(`pages.${page}.loading`)} />
        ) : params.success ? (
          children(params.data.runId)
        ) : (
          <RunNotFound />
        )}
      </DossierPage>
    </RunSourceProvider>
  );
}
