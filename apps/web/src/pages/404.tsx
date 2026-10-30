import Head from 'next/head';
import Link from 'next/link';
import { useTranslations } from 'use-intl';
import { getStaticProps } from '../lib/i18n-server';

export { getStaticProps };

export default function NotFoundPage() {
  const t = useTranslations('notFound');
  return (
    <>
      <Head>
        <title>{t('pageTitle')}</title>
      </Head>
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <div className="flex max-w-md flex-col items-start gap-4">
          <h1 className="text-5xl leading-none font-medium tracking-tight">{t('title')}</h1>
          <p className="text-base-content/70">{t('text')}</p>
          <Link href="/" className="btn btn-primary min-h-11">
            {t('home')}
          </Link>
        </div>
      </main>
    </>
  );
}
