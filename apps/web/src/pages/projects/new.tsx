import Head from 'next/head';
import Link from 'next/link';
import { useTranslations } from 'use-intl';
import { CreateProjectForm } from '../../components/CreateProjectForm';
import { LoadError, LoadingBlock } from '../../components/PageStates';
import { getStaticProps } from '../../lib/i18n-server';
import type { NextPageWithAuth } from '../../lib/page-auth';
import { useMarkets } from '../../lib/projects';

export { getStaticProps };

const NewProjectPage: NextPageWithAuth = () => {
  const t = useTranslations('newProject');
  const markets = useMarkets();

  return (
    <>
      <Head>
        <title>{t('pageTitle')}</title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <Link href="/projects" className="link inline-flex min-h-11 w-fit items-center text-sm">
            {t('back')}
          </Link>
          <section className="card border border-base-300 bg-base-100">
            <div className="card-body gap-6">
              <h1 className="card-title text-2xl">{t('title')}</h1>
              {markets.isPending && <LoadingBlock label={t('loadingMarkets')} cards={1} />}
              {markets.isError && (
                <LoadError
                  error={markets.error}
                  message={t('marketsError')}
                  onRetry={() => void markets.refetch()}
                />
              )}
              {markets.isSuccess && markets.data.markets.length === 0 && (
                <div role="alert" className="alert alert-warning">
                  <span>{t('noMarkets')}</span>
                </div>
              )}
              {markets.isSuccess && markets.data.markets.length > 0 && (
                <CreateProjectForm markets={markets.data.markets} />
              )}
            </div>
          </section>
        </div>
      </main>
    </>
  );
};

NewProjectPage.auth = 'required';

export default NewProjectPage;
