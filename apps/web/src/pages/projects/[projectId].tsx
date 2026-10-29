import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { FactForm } from '../../components/FactForm';
import { MaterialsSummary } from '../../components/MaterialsSummary';
import { ProjectDetailsForm } from '../../components/ProjectDetailsForm';
import { ReadinessPanel } from '../../components/ReadinessPanel';
import { ApiRequestError } from '../../lib/api';
import type { NextPageWithAuth } from '../../lib/page-auth';
import { languageName } from '../../lib/project-view';
import { useMarketForm, useProject } from '../../lib/projects';

function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-3 text-base-content/70">
      <span className="loading loading-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

const ProjectPage: NextPageWithAuth = () => {
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
    body = (
      <div role="alert" className="alert alert-error">
        <span>
          {missing
            ? 'This project does not exist.'
            : 'We could not load this project. Check your connection and try again.'}
        </span>
        {!missing && (
          <button type="button" className="btn btn-sm" onClick={() => void project.refetch()}>
            Try again
          </button>
        )}
      </div>
    );
  } else if (detail === undefined) {
    body = <Loading label="Loading the project…" />;
  } else {
    const locked = detail.readiness.inputsLocked;
    body = (
      <>
        <header>
          <h1 className="text-3xl font-bold">{detail.project.title}</h1>
          <p className="text-base-content/70">
            {detail.project.market.name ?? 'Unknown market'} ·{' '}
            {languageName(detail.project.outputLanguage)}
          </p>
        </header>

        <ReadinessPanel
          detail={detail}
          market={market.data?.market}
          hasUnsavedChanges={factsUnsaved || detailsUnsaved}
        />
        <MaterialsSummary projectId={detail.project.id} readiness={detail.readiness} />

        <section aria-labelledby="facts-heading" className="card bg-base-100 shadow-sm">
          <div className="card-body gap-4">
            <h2 id="facts-heading" className="card-title">
              Property facts
            </h2>
            {locked && (
              <div role="note" className="alert alert-info">
                <span>
                  A run has been started, so these facts are locked: the run cites them as evidence.
                </span>
              </div>
            )}
            {market.isPending && <Loading label="Loading the fact form…" />}
            {market.isError && (
              <div role="alert" className="alert alert-error">
                <span>We could not load the fact form. Check your connection and try again.</span>
                <button type="button" className="btn btn-sm" onClick={() => void market.refetch()}>
                  Try again
                </button>
              </div>
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

        <section aria-labelledby="details-heading" className="card bg-base-100 shadow-sm">
          <div className="card-body gap-4">
            <h2 id="details-heading" className="card-title">
              Project details
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
        <title>{detail ? `${detail.project.title} — Evidomo` : 'Project — Evidomo'}</title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <Link href="/projects" className="link w-fit text-sm">
            Back to projects
          </Link>
          {body}
        </div>
      </main>
    </>
  );
};

ProjectPage.auth = 'required';

export default ProjectPage;
