import Head from 'next/head';
import { useTranslations } from 'use-intl';
import { LandingPage } from '../components/landing/LandingPage';
import { getStaticProps } from '../lib/i18n-server';

export { getStaticProps };

export default function Home() {
  const t = useTranslations('meta');
  const title = t('landingTitle');
  const description = t('landingDescription');
  return (
    <>
      <Head>
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta key="og:title" property="og:title" content={title} />
        <meta key="og:description" property="og:description" content={description} />
      </Head>
      <LandingPage />
    </>
  );
}
