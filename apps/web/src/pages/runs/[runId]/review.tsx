import { runParamsSchema } from '@evidomo/shared';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useTranslations } from 'use-intl';
import { ClaimAuditView } from '../../../components/ClaimAudit';
import { LoadingState, RunNotFound } from '../../../components/RunMonitor';
import { getServerSideProps } from '../../../lib/i18n-server';
import type { NextPageWithAuth } from '../../../lib/page-auth';
import { DossierPage } from '../../../components/DossierPage';

export { getServerSideProps };

const ReviewPage: NextPageWithAuth = () => {
  const t = useTranslations('claimAudit');
  const router = useRouter();
  const params = runParamsSchema.safeParse({ runId: router.query['runId'] });

  return (
    <>
      <Head>
        <title>{t('pageTitle')}</title>
      </Head>
      <DossierPage widthClass="max-w-6xl">
        {!router.isReady ? (
          <LoadingState label={t('loading')} />
        ) : params.success ? (
          <ClaimAuditView key={params.data.runId} runId={params.data.runId} />
        ) : (
          <RunNotFound />
        )}
      </DossierPage>
    </>
  );
};

ReviewPage.auth = 'required';

export default ReviewPage;
