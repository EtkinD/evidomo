import { runParamsSchema } from '@evidomo/shared';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useTranslations } from 'use-intl';
import { FactConflictsView } from '../../../components/FactConflicts';
import { LoadingState, RunNotFound } from '../../../components/RunMonitor';
import { getServerSideProps } from '../../../lib/i18n-server';
import type { NextPageWithAuth } from '../../../lib/page-auth';
import { DossierPage } from '../../../components/DossierPage';

export { getServerSideProps };

const ConflictsPage: NextPageWithAuth = () => {
  const t = useTranslations('conflicts');
  const router = useRouter();
  const params = runParamsSchema.safeParse({ runId: router.query['runId'] });

  return (
    <>
      <Head>
        <title>{t('pageTitle')}</title>
      </Head>
      <DossierPage widthClass="max-w-4xl">
        {!router.isReady ? (
          <LoadingState label={t('loading')} />
        ) : params.success ? (
          <FactConflictsView key={params.data.runId} runId={params.data.runId} />
        ) : (
          <RunNotFound />
        )}
      </DossierPage>
    </>
  );
};

ConflictsPage.auth = 'required';

export default ConflictsPage;
