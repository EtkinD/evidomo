import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { FactForm } from '../../components/FactForm';
import { MaterialsSummary } from '../../components/MaterialsSummary';
import { ProjectDetailsForm } from '../../components/ProjectDetailsForm';
import { LoadError, LoadingBlock } from '../../components/PageStates';
import { ReadinessPanel } from '../../components/ReadinessPanel';
import { ApiRequestError } from '../../lib/api';
import { getServerSideProps } from '../../lib/i18n-server';
import type { NextPageWithAuth } from '../../lib/page-auth';
import { languageName } from '../../lib/project-view';
import { useMarketForm, useProject } from '../../lib/projects';

export { getServerSideProps };

const ProjectPage: NextPageWithAuth = () => {
  const t = useTranslations('projectPage');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const raw = router.query['projectId'];
  const projectId = router.isReady && typeof raw === 'string' ? raw : undefined;

  const project = useProject(projectId);
  const detail = project.data;
  const market = useMarketForm(detail?.project.market);
  const [factsUnsaved, setFactsUnsaved] = useState(false);
  const [detailsUnsaved, setDetailsUnsaved] = useState(false);

  let body;
  if (project.isError) {
    const missing = project.error instanceof ApiRequestError && project.error.status === 404;
    body = missing ? (
      <div role="alert" className="alert alert-error">
        <span>{tCommon('projectMissing')}</span>
      </div>
    ) : (
      <LoadError
        error={project.error}
        message={tCommon('projectLoadError')}
        onRetry={() => void project.refetch()}
      />
    );
  } else if (detail === undefined) {
    body = <LoadingBlock label={tCommon('loadingProject')} cards={3} />;
  } else {
    const locked = detail.readiness.inputsLocked;
    body = (
      <>
        <header>
          <h1 className="text-3xl font-bold tracking-tight">{detail.project.title}</h1>
          <p className="text-base-content/70">
            {detail.project.market.name ?? t('unknownMarket')} ·{' '}
            {languageName(detail.project.outputLanguage, locale)}
          </p>
        </header>

        <ReadinessPanel
          detail={detail}
          market={market.data?.market}
          hasUnsavedChanges={factsUnsaved || detailsUnsaved}
        />
        <MaterialsSummary
          projectId={detail.project.id}
          readiness={detail.readiness}
          materials={detail.materials}
        />

        <section
          aria-labelledby="facts-heading"
          className="card border border-base-300 bg-base-100"
        >
          <div className="card-body gap-4">
            <h2 id="facts-heading" className="card-title text-2xl">
              {t('facts')}
            </h2>
            {locked && (
              <div role="note" className="alert alert-info">
                <span>{t('factsLocked')}</span>
              </div>
            )}
            {market.isPending && <LoadingBlock label={t('loadingFacts')} cards={1} />}
            {market.isError && (
              <LoadError
                error={market.error}
                message={t('factsLoadError')}
                onRetry={() => void market.refetch()}
              />
            )}
            {market.isSuccess && (
              <FactForm
                key={detail.project.id}
                onUnsavedChange={setFactsUnsaved}
                projectId={detail.project.id}
                market={market.data.market}
                values={detail.factForm.values}
                locked={locked}
              />
            )}
          </div>
        </section>

        <section
          aria-labelledby="details-heading"
          className="card border border-base-300 bg-base-100"
        >
          <div className="card-body gap-4">
            <h2 id="details-heading" className="card-title text-2xl">
              {t('details')}
            </h2>
            <ProjectDetailsForm
              key={detail.project.id}
              detail={detail}
              onUnsavedChange={setDetailsUnsaved}
            />
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <Head>
        <title>
          {detail ? t('pageTitleFor', { title: detail.project.title }) : t('pageTitle')}
        </title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <Link href="/projects" className="link inline-flex min-h-11 w-fit items-center text-sm">
            {t('back')}
          </Link>
          {body}
        </div>
      </main>
    </>
  );
};

ProjectPage.auth = 'required';

export default ProjectPage;
