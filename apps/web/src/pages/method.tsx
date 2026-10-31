import Head from 'next/head';
import { useTranslations } from 'use-intl';
import { MethodPage } from '../components/method/MethodPage';
import { getStaticProps } from '../lib/i18n-server';

export { getStaticProps };

export default function Method() {
  const t = useTranslations('meta');
  const title = t('methodTitle');
  const description = t('methodDescription');
  return (
    <>
      <Head>
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta key="og:title" property="og:title" content={title} />
        <meta key="og:description" property="og:description" content={description} />
      </Head>
      <MethodPage />
    </>
  );
}
