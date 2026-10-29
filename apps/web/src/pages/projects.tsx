import type { ProjectSummary } from '@evidomo/shared';
import Head from 'next/head';
import Link from 'next/link';
import { useMe } from '../lib/auth';
import type { NextPageWithAuth } from '../lib/page-auth';
import { languageName, runStatusBadge, runStatusLabel } from '../lib/project-view';
import { useProjects } from '../lib/projects';

function ProjectCard({ project }: { project: ProjectSummary }) {
  const { latestRun } = project;
  return (
    <li className="card bg-base-100 shadow-sm">
      <div className="card-body gap-2">
        <h2 className="card-title">
          <Link href={`/projects/${project.id}`} className="link link-hover">
            {project.title}
          </Link>
        </h2>
        <p className="text-sm text-base-content/70">
          {project.market.name ?? 'Unknown market'} · {languageName(project.outputLanguage)}
        </p>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <li>
            {project.photoCount} {project.photoCount === 1 ? 'photo' : 'photos'}
          </li>
          <li>Voice memo: {project.hasVoiceMemo ? 'yes' : 'no'}</li>
          <li className="flex items-center gap-2">
            {latestRun === null ? (
              <span className="text-base-content/70">No run yet</span>
            ) : (
              <>
                <span className={`badge ${runStatusBadge(latestRun.status)}`}>
                  {runStatusLabel(latestRun.status)}
                </span>
                <Link href={`/runs/${latestRun.id}`} className="link">
                  View run
                  <span className="sr-only"> for {project.title}</span>
                </Link>
              </>
            )}
          </li>
        </ul>
      </div>
    </li>
  );
}

// The signed-in landing page: the user's projects, newest first.
const ProjectsPage: NextPageWithAuth = () => {
  // RequireAuth renders this page only once `me` holds a user.
  const { data: user } = useMe();
  const projects = useProjects();

  return (
    <>
      <Head>
        <title>Your projects — Evidomo</title>
      </Head>
      <main className="flex-1 bg-base-200 px-4 py-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold">Your projects</h1>
              {user && <p className="text-base-content/70">Signed in as {user.email}</p>}
            </div>
            {projects.data !== undefined && projects.data.projects.length > 0 && (
              <Link href="/projects/new" className="btn btn-primary">
                New project
              </Link>
            )}
          </div>

          {projects.isPending && (
            <div role="status" className="flex items-center gap-3 text-base-content/70">
              <span className="loading loading-spinner" aria-hidden="true" />
              <span>Loading your projects…</span>
            </div>
          )}

          {projects.isError && (
            <div role="alert" className="alert alert-error">
              <span>We could not load your projects. Check your connection and try again.</span>
              <button type="button" className="btn btn-sm" onClick={() => void projects.refetch()}>
                Try again
              </button>
            </div>
          )}

          {projects.isSuccess && projects.data.projects.length === 0 && (
            <div className="card bg-base-100 shadow-sm">
              <div className="card-body items-center text-center">
                <h2 className="card-title">No projects yet</h2>
                <p className="text-base-content/70">
                  A project holds one property: its photos, voice walkthrough, and listing pack.
                </p>
                <Link href="/projects/new" className="btn btn-primary">
                  New project
                </Link>
              </div>
            </div>
          )}

          {projects.isSuccess && projects.data.projects.length > 0 && (
            <ul className="flex flex-col gap-4">
              {projects.data.projects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
};

ProjectsPage.auth = 'required';

export default ProjectsPage;
