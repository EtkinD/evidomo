import type { NextPage } from 'next';
import Head from 'next/head';
import { useTranslations } from 'use-intl';
import { DemoBanner } from '../../components/demo/DemoBanner';
import { DossierPage, PAGE_TITLE_CLASS } from '../../components/DossierPage';
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
      <DossierPage widthClass="max-w-3xl" banner={<DemoBanner />}>
        <div className="flex flex-col gap-2">
          <h1 className={PAGE_TITLE_CLASS}>{t('title')}</h1>
          <p className="text-base-content/70">{t('intro')}</p>
        </div>
        <DemoRunList />
      </DossierPage>
    </>
  );
}

const DemoPage: NextPage = () => <DemoPageContent />;

export default DemoPage;
