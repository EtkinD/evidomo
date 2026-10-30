import type { NextPage } from 'next';
import Head from 'next/head';
import { useTranslations } from 'use-intl';
import { DemoBanner } from '../../components/demo/DemoBanner';
import { DemoRunList } from '../../components/demo/DemoRunList';
import { getStaticProps } from '../../lib/i18n-server';

export { getStaticProps };

function DemoPageContent() {
  const t = useTranslations('demo');
  return (
    <>
      <Head>
        <title>{t('pageTitle')}</title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <DemoBanner />
          <section className="card border border-base-300 bg-base-100">
            <div className="card-body gap-6">
              <div className="flex flex-col gap-2">
                <h1 className="card-title text-2xl">{t('title')}</h1>
                <p className="text-base-content/70">{t('intro')}</p>
              </div>
              <DemoRunList />
            </div>
          </section>
        </div>
      </main>
    </>
  );
}

const DemoPage: NextPage = () => <DemoPageContent />;

export default DemoPage;
