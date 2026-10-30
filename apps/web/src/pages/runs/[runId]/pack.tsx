import { runParamsSchema } from '@evidomo/shared';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useTranslations } from 'use-intl';
import { PackViewer } from '../../../components/PackViewer';
import { LoadingState, RunNotFound } from '../../../components/RunMonitor';
import { useExportManifest } from '../../../lib/pack';
import { getServerSideProps } from '../../../lib/i18n-server';
import type { NextPageWithAuth } from '../../../lib/page-auth';
import { DossierPage } from '../../../components/DossierPage';

function PackPage({ runId }: { runId: string }) {
  const query = useExportManifest(runId);
  return <PackViewer query={query} runId={runId} />;
}

export { getServerSideProps };

const RunPackPage: NextPageWithAuth = () => {
  const t = useTranslations('pack');
  const router = useRouter();
  const params = runParamsSchema.safeParse({ runId: router.query['runId'] });

  return (
    <>
      <Head>
        <title>{t('pageTitle')}</title>
      </Head>
      <DossierPage widthClass="max-w-4xl" bare>
        {!router.isReady ? (
          <LoadingState label={t('loading')} />
        ) : params.success ? (
          <PackPage key={params.data.runId} runId={params.data.runId} />
        ) : (
          <RunNotFound />
        )}
      </DossierPage>
    </>
  );
};

RunPackPage.auth = 'required';

export default RunPackPage;
