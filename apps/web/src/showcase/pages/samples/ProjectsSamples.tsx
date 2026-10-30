import Link from 'next/link';
import { Lockup } from '../../logo';
import { CheckIcon, ApprovedImage, SampleShell, Sample } from '../../samples/parts';

function AccountMenu() {
  return (
    <details className="dropdown dropdown-end">
      <summary className="btn btn-ghost min-h-11 gap-2">
        <span
          aria-hidden
          className="flex size-8 items-center justify-center rounded-selector bg-secondary font-semibold text-secondary-content"
        >
          DA
        </span>
        <span className="hidden max-w-40 truncate text-sm sm:inline">agent@example.test</span>
        <span className="sr-only">Account menu</span>
      </summary>
      <ul className="menu dropdown-content z-10 mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-2 shadow-sm">
        <li className="menu-title truncate">agent@example.test</li>
        <li>
          <Link href="/showcase/samples/projects" className="min-h-11!">
            Your projects
          </Link>
        </li>
        <li>
          <Link href="/showcase/samples/auth" className="min-h-11!">
            Log out
          </Link>
        </li>
      </ul>
    </details>
  );
}

function SignedInHeader() {
  return (
    <header className="border-b border-base-300 bg-base-100">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-2 px-4 py-2">
        <Link
          href="/showcase/samples/landing"
          aria-label="Evidomo, home"
          className="inline-flex min-h-11 items-center"
        >
          <Lockup markClass="size-8" textClass="text-xl" />
        </Link>
        <nav aria-label="Account" className="flex items-center gap-1">
          <Link
            href="/showcase/samples/projects"
            aria-current="page"
            className="btn btn-ghost min-h-11 font-semibold underline"
          >
            Projects
          </Link>
          <AccountMenu />
        </nav>
      </div>
    </header>
  );
}

type Status = 'draft' | 'running' | 'review' | 'completed' | 'failed';

const STATUS: Record<Status, { className: string; label: string; icon: string }> = {
  draft: { className: 'badge-outline', label: 'Draft', icon: '○' },
  running: { className: 'badge-info', label: 'Running', icon: '' },
  review: { className: 'badge-secondary', label: 'Awaiting your review', icon: '!' },
  completed: { className: 'badge-success', label: 'Pack ready', icon: '' },
  failed: { className: 'badge-error', label: 'Run failed', icon: '×' },
};

function StatusBadge({ status }: { status: Status }) {
  const { className, label, icon } = STATUS[status];
  return (
    <span className={`badge ${className} gap-1`}>
      {status === 'running' && <span className="loading loading-spinner loading-xs" aria-hidden />}
      {status === 'completed' && <CheckIcon className="size-3.5" />}
      {icon !== '' && <span aria-hidden>{icon}</span>}
      {label}
    </span>
  );
}

const PROJECTS: readonly {
  title: string;
  address: string;
  status: Status;
  meta: string;
  updated: string;
  action: string;
}[] = [
  {
    title: 'Voorbeeldgracht 14',
    address: 'Voorbeeldstad, upper floor flat',
    status: 'review',
    meta: '24 photos · voice walkthrough · 12 of 12 facts',
    updated: 'Updated 12 minutes ago',
    action: 'Review conflicts',
  },
  {
    title: 'Kastanjelaan 7',
    address: 'Voorbeeldstad, terraced house',
    status: 'running',
    meta: '18 photos · voice walkthrough · 11 of 12 facts',
    updated: 'Started 3 minutes ago',
    action: 'Open run',
  },
  {
    title: 'Molenpad 3',
    address: 'Voorbeeldstad, canal house',
    status: 'completed',
    meta: '27 photos · voice walkthrough · 12 of 12 facts',
    updated: 'Finished yesterday',
    action: 'Open pack',
  },
  {
    title: 'Heidehof 21',
    address: 'Voorbeeldstad, semi-detached',
    status: 'draft',
    meta: '6 photos · no voice walkthrough yet · 5 of 12 facts',
    updated: 'Updated 2 days ago',
    action: 'Continue',
  },
  {
    title: 'Wilgenstraat 9',
    address: 'Voorbeeldstad, ground floor flat',
    status: 'failed',
    meta: '15 photos · voice walkthrough · 12 of 12 facts',
    updated: 'Failed last week',
    action: 'See what happened',
  },
];

function ProjectList() {
  return (
    <div className="bg-base-200 px-4 py-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Your projects</h2>
            <p className="text-base-content/70">Signed in as agent@example.test</p>
          </div>
          <Link href="/showcase/samples/project" className="btn btn-primary min-h-11">
            New project
          </Link>
        </div>
        <ul className="flex flex-col gap-4">
          {PROJECTS.map((project) => (
            <li key={project.title} className="card border border-base-300 bg-base-100">
              <div className="card-body gap-3 p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="card-title text-xl">{project.title}</h3>
                    <p className="text-sm text-base-content/70">{project.address}</p>
                  </div>
                  <StatusBadge status={project.status} />
                </div>
                <p className="text-sm">{project.meta}</p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-base-content/70">{project.updated}</p>
                  <Link href="/showcase/samples/project" className="btn btn-outline min-h-11">
                    {project.action}
                    <span className="sr-only">: {project.title}</span>
                  </Link>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-base-200 px-4 py-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Your projects</h2>
          <p className="text-base-content/70">Signed in as agent@example.test</p>
        </div>
        <div className="card border border-base-300 bg-base-100">
          <div className="card-body items-center gap-3 text-center">
            <div className="w-40 sm:w-52">
              <ApprovedImage image="illustration" aspect="aspect-square" className="rounded-box" />
            </div>
            <h3 className="card-title text-2xl">No projects yet</h3>
            <p className="max-w-md text-base-content/70">
              A project holds one property: its photos, voice walkthrough, and listing pack. Start
              one when you are at the door.
            </p>
            <Link href="/showcase/samples/project" className="btn btn-primary min-h-11">
              New project
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SampleProjectsPage() {
  return (
    <SampleShell title="Sample: app shell and projects">
      <Sample id="H-SHELL-1" title="Signed-in header with account menu (tap the account button)">
        <div className="min-h-64">
          <SignedInHeader />
        </div>
      </Sample>
      <Sample id="H-LIST-1" title="Projects list with status badges">
        <ProjectList />
      </Sample>
      <Sample id="H-EMPTY-1" title="Empty state with B2-ILL-1">
        <EmptyState />
      </Sample>
    </SampleShell>
  );
}
