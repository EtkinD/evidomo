import type { NextPage } from 'next';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { DemoRunList } from '../../components/demo/DemoRunList';
import { DemoRunningHead } from '../../components/demo/DemoRunningHead';
import { DossierPage, PAGE_TITLE_CLASS } from '../../components/DossierPage';
import { LoadingBlock } from '../../components/PageStates';
import { useDemoRuns } from '../../lib/demo';
import { getStaticProps } from '../../lib/i18n-server';
import { demoRunSource } from '../../lib/run-source';

export { getStaticProps };

const TABS = ['conflicts', 'review', 'pack'] as const;

/** `?tab=` on the entry names the screen of the sample file to open (the landing's source notes). */
function tabFrom(value: string | string[] | undefined): 'monitor' | (typeof TABS)[number] {
  const first = Array.isArray(value) ? value[0] : value;
  return TABS.find((tab) => tab === first) ?? 'monitor';
}

function DemoPageContent() {
  const t = useTranslations('demo');
  const router = useRouter();
  const runs = useDemoRuns();
  // With exactly one published run there is nothing to choose: the entry opens the sample file.
  const only = runs.data?.runs.length === 1 ? runs.data.runs[0] : undefined;
  const target =
    only === undefined ? null : demoRunSource.hrefs[tabFrom(router.query['tab'])](only.id);

  useEffect(() => {
    if (target !== null && router.isReady) void router.replace(target);
  }, [target, router]);

  return (
    <>
      <Head>
        <title>{t('pageTitle')}</title>
      </Head>
      <DossierPage widthClass="max-w-3xl" head={<DemoRunningHead />}>
        {target !== null ? (
          <LoadingBlock label={t('opening')} />
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <h1 className={PAGE_TITLE_CLASS}>{t('title')}</h1>
              <p className="text-base-content/70">{t('intro')}</p>
            </div>
            <DemoRunList />
          </>
        )}
      </DossierPage>
    </>
  );
}

const DemoPage: NextPage = () => <DemoPageContent />;

export default DemoPage;
