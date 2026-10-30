import { runParamsSchema } from '@evidomo/shared';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useTranslations } from 'use-intl';
import { RunMonitorView, LoadingState, RunNotFound } from '../../components/RunMonitor';
import { getServerSideProps } from '../../lib/i18n-server';
import type { NextPageWithAuth } from '../../lib/page-auth';
import { useRunMonitor } from '../../lib/use-run-monitor';

function RunMonitorPage({ runId }: { runId: string }) {
  const monitor = useRunMonitor(runId);
  return <RunMonitorView monitor={monitor} runId={runId} />;
}

export { getServerSideProps };

const RunPage: NextPageWithAuth = () => {
  const t = useTranslations('run');
  const router = useRouter();
  const params = runParamsSchema.safeParse({ runId: router.query['runId'] });

  return (
    <>
      <Head>
        <title>{t('pageTitle')}</title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <section className="card mx-auto max-w-5xl border border-base-300 bg-base-100">
          <div className="card-body gap-6">
            {!router.isReady ? (
              <LoadingState label={t('loading')} />
            ) : params.success ? (
              <RunMonitorPage key={params.data.runId} runId={params.data.runId} />
            ) : (
              <RunNotFound />
            )}
          </div>
        </section>
      </main>
    </>
  );
};

RunPage.auth = 'required';

export default RunPage;
