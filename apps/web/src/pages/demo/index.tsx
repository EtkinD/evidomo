import type { NextPage } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
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
  const tAction = useTranslations('landing.actions');
  const router = useRouter();
  const runs = useDemoRuns();
  const [failedTarget, setFailedTarget] = useState<string | null>(null);
  // The target the redirect was already started for: a new router identity must not start it again.
  const started = useRef<string | null>(null);
  // With exactly one published run there is nothing to choose: the entry opens the sample file.
  const only = runs.data?.runs.length === 1 ? runs.data.runs[0] : undefined;
  const target =
    only === undefined ? null : demoRunSource.hrefs[tabFrom(router.query['tab'])](only.id);
  // Until the runs are known the visitor is on the way in, not looking at a list.
  // Once the runs have answered (or failed) the page does not go back to waiting while the list
  // retries: the timestamps only ever move forward.
  const answered = runs.dataUpdatedAt > 0 || runs.errorUpdatedAt > 0;
  const opening = !answered || target !== null;

  useEffect(() => {
    if (target === null || !router.isReady || started.current === target) return;
    started.current = target;
    router.replace(target).catch(() => {
      setFailedTarget(target);
    });
  }, [target, router]);

  return (
    <>
      <Head>
        <title>{t('pageTitle')}</title>
      </Head>
      <DossierPage widthClass="max-w-3xl" head={<DemoRunningHead />}>
        {opening ? (
          <>
            <LoadingBlock label={t('opening')} />
            {target !== null && failedTarget === target && (
              <Link href={target} className="inline-flex min-h-11 w-fit items-center underline">
                {tAction('openSample')}
              </Link>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <h1 className={PAGE_TITLE_CLASS}>{t('title')}</h1>
              <p className="text-base-content/70">{t('intro')}</p>
            </div>
            <DemoRunList query={runs} />
          </>
        )}
      </DossierPage>
    </>
  );
}

const DemoPage: NextPage = () => <DemoPageContent />;

export default DemoPage;
