import type { ProjectSummary } from '@evidomo/shared';
import Head from 'next/head';
import Link from 'next/link';
import { useLocale, useTranslations } from 'use-intl';
import { LoadError, LoadingBlock } from '../components/PageStates';
import { RunStatusBadge } from '../components/RunStatusBadge';
import { useMe } from '../lib/auth';
import { getStaticProps } from '../lib/i18n-server';
import type { NextPageWithAuth } from '../lib/page-auth';
import { languageName } from '../lib/project-view';
import { LANDING_IMAGES, landingSrc, landingSrcSet } from '../lib/landing-images';
import { useProjects } from '../lib/projects';

export { getStaticProps };

function ProjectCard({ project }: { project: ProjectSummary }) {
  const t = useTranslations('projects');
  const locale = useLocale();
  const { latestRun } = project;
  return (
    // A folder: the market and language sit on its tab, the sheet below holds the facts.
    // `relative` anchors the stretched title link: the whole folder opens the project, while the
    // run link below sits above it (`relative z-10`) and keeps its own target.
    <li className="lift relative mt-7 bg-base-100 shadow-sheet [&:hover_.folder-tab]:bg-accent">
      <p className="folder-tab absolute -top-7 left-0 max-w-[85%] truncate bg-base-300 px-3 py-1 text-sm leading-5 text-base-content transition-colors duration-200">
        {project.market.name ?? t('unknownMarket')} · {languageName(project.outputLanguage, locale)}
      </p>
      <div className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="text-2xl leading-tight font-medium">
            <Link
              href={`/projects/${project.id}`}
              className="link link-hover inline-flex min-h-11 items-center after:absolute after:inset-0 after:content-['']"
            >
              {project.title}
            </Link>
          </h2>
          {latestRun === null ? (
            <span className="badge badge-outline">{t('noRunYet')}</span>
          ) : (
            <RunStatusBadge status={latestRun.status} />
          )}
        </div>
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-base-content/20 pt-3 text-sm">
          <li>{t('photoCount', { count: project.photoCount })}</li>
          <li>{project.hasVoiceMemo ? t('voiceMemoYes') : t('voiceMemoNo')}</li>
        </ul>
        {latestRun !== null && (
          <div>
            <Link
              href={`/runs/${latestRun.id}`}
              aria-label={t('viewRunFor', { title: project.title })}
              className="btn btn-outline relative z-10 min-h-11"
            >
              {t('viewRun')}
            </Link>
          </div>
        )}
      </div>
    </li>
  );
}

function EmptyProjects() {
  const t = useTranslations('projects');
  const image = LANDING_IMAGES.illustration;
  return (
    <div className="bg-base-100 shadow-sheet">
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        {/* Decorative: the heading below says what the card is about. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- prebuilt responsive variants */}
        <img
          src={landingSrc(image, 640)}
          srcSet={landingSrcSet(image)}
          sizes="(min-width: 640px) 208px, 160px"
          width={image.width}
          height={image.height}
          alt=""
          loading="lazy"
          className="aspect-square w-40 -rotate-2 bg-base-100 p-1.5 shadow-lift sm:w-52"
        />
        <h2 className="text-3xl font-medium">{t('emptyTitle')}</h2>
        <p className="max-w-md text-base-content/70">{t('emptyText')}</p>
        <Link href="/projects/new" className="btn btn-primary min-h-11">
          {t('newProject')}
        </Link>
      </div>
    </div>
  );
}

// The signed-in landing page: the user's projects, newest first.
const ProjectsPage: NextPageWithAuth = () => {
  // RequireAuth renders this page only once `me` holds a user.
  const t = useTranslations('projects');
  const { data: user } = useMe();
  const projects = useProjects();

  return (
    <>
      <Head>
        <title>{t('pageTitle')}</title>
      </Head>
      <main className="flex-1 px-4 py-10 md:py-14">
        <div className="mx-auto flex max-w-3xl flex-col gap-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-5xl leading-none font-medium tracking-tight md:text-6xl">
                {t('title')}
              </h1>
              {user && (
                <p className="mt-2 font-display text-lg text-base-content/70 italic">
                  {t('signedInAs', { email: user.email })}
                </p>
              )}
            </div>
            {projects.data !== undefined && projects.data.projects.length > 0 && (
              <Link href="/projects/new" className="btn btn-primary min-h-11">
                {t('newProject')}
              </Link>
            )}
          </div>

          {projects.isPending && <LoadingBlock label={t('loading')} cards={3} />}

          {projects.isError && (
            <LoadError
              error={projects.error}
              message={t('loadError')}
              onRetry={() => void projects.refetch()}
            />
          )}

          {projects.isSuccess && projects.data.projects.length === 0 && <EmptyProjects />}

          {projects.isSuccess && projects.data.projects.length > 0 && (
            <ul className="flex flex-col gap-6">
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
