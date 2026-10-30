import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import {
  APPROVED_IMAGES,
  assetUrl,
  useAssetManifest,
  type ApprovedImageKey,
  type AssetItem,
} from '../assets';
import { useMode } from '../mode';
import { THEME_NAMES, type Mode } from '../palettes';
import { NotGenerated, ShowcaseShell } from '../ui';

export const SAMPLE_PAGES = [
  {
    slug: 'landing',
    label: 'Landing',
    summary: 'Header, hero, how it works, evidence highlight, trust, call to action, footer.',
  },
  {
    slug: 'projects',
    label: 'Projects',
    summary: 'Signed-in header with account menu, project list with status badges, empty state.',
  },
  {
    slug: 'project',
    label: 'Project',
    summary: 'Materials, fact form with an error, readiness with the access code and Start run.',
  },
  {
    slug: 'run',
    label: 'Run monitor',
    summary: 'Readable steps, live cost against the cap, paused for review.',
  },
  {
    slug: 'review',
    label: 'Review gates',
    summary: 'The real Gate 1 and Gate 2 screens with evidence, on sample data.',
  },
  { slug: 'auth', label: 'Log in', summary: 'The log in card with the logo.' },
] as const;

/**
 * Pins a subtree to the light or dark product theme (the page's own mode when none is given). The
 * `data-sample` marker lets tests find one themed view.
 */
export function SampleScope({
  mode: forced,
  className = '',
  children,
}: {
  mode?: Mode;
  className?: string;
  children: ReactNode;
}) {
  const { mode } = useMode();
  return (
    <div
      data-theme={THEME_NAMES[forced ?? mode]}
      data-sample
      className={`bg-base-100 text-base-content ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * One sample section with its feedback ID, shown above the design (never inside it), so the
 * sample itself looks as it would in the product.
 */
export function Sample({
  id,
  title,
  children,
  className = '',
  mode,
}: {
  id: string;
  title: string;
  children: ReactNode;
  /** Classes of the themed surface that holds the design. */
  className?: string;
  mode?: Mode;
}) {
  return (
    <section aria-label={`${id} ${title}`} className="flex flex-col">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2 px-4 py-2">
        <code className="badge badge-neutral font-mono">{id}</code>
        <span className="text-sm text-base-content/70">{title}</span>
      </div>
      <SampleScope {...(mode === undefined ? {} : { mode })} className={className}>
        {children}
      </SampleScope>
    </section>
  );
}

/** Frame of the sample pages: the showcase shell and the links between samples. */
export function SampleShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <ShowcaseShell
      title={title}
      wide
      intro={
        <div className="mb-4">
          <nav aria-label="Samples">
            <ul className="flex flex-wrap gap-x-1">
              <li>
                <Link
                  href="/showcase/samples"
                  className="inline-flex min-h-11 items-center px-2 underline"
                >
                  Overview
                </Link>
              </li>
              {SAMPLE_PAGES.map((page) => (
                <li key={page.slug}>
                  <Link
                    href={`/showcase/samples/${page.slug}`}
                    className="inline-flex min-h-11 items-center px-2 underline"
                  >
                    {page.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      }
    >
      <div className="flex flex-col gap-6 pb-10">{children}</div>
    </ShowcaseShell>
  );
}

type ApprovedItem =
  | { readonly state: 'loading' }
  | { readonly state: 'missing' }
  | { readonly state: 'ready'; readonly item: AssetItem };

function useApprovedItem(key: ApprovedImageKey): ApprovedItem {
  const query = useAssetManifest();
  if (query.isPending) return { state: 'loading' };
  if (query.data?.status !== 'ready') return { state: 'missing' };
  const item = query.data.manifest.items.find(
    (candidate) => candidate.id === APPROVED_IMAGES[key].id,
  );
  return item === undefined ? { state: 'missing' } : { state: 'ready', item };
}

/** One of the four approved images, in a fixed-ratio box so nothing shifts while it loads. */
export function ApprovedImage({
  image,
  aspect = 'aspect-3/2',
  className = '',
  fit = 'object-cover',
  position = '',
  alt,
}: {
  image: ApprovedImageKey;
  aspect?: string;
  className?: string;
  fit?: string;
  /** An `object-*` position class to crop differently from another use of the same image. */
  position?: string;
  alt?: string;
}) {
  const state = useApprovedItem(image);
  const [failed, setFailed] = useState(false);
  const frame = `${aspect} w-full overflow-hidden bg-base-200 ${className}`;
  if (state.state === 'loading') return <div className={frame} aria-hidden />;
  if (state.state === 'missing' || failed) {
    return (
      <NotGenerated what={APPROVED_IMAGES[image].id} className={`${aspect} w-full ${className}`} />
    );
  }
  return (
    <div className={frame}>
      {/* eslint-disable-next-line @next/next/no-img-element -- local dev-only asset, not optimised on purpose */}
      <img
        src={assetUrl(state.item)}
        alt={alt ?? APPROVED_IMAGES[image].alt}
        width={state.item.width}
        height={state.item.height}
        loading="lazy"
        data-asset-id={state.item.id}
        className={`size-full ${fit} ${position}`}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

/** The URL of an approved image for places that need a string (evidence photos), or null. */
export function useApprovedImageUrl(image: ApprovedImageKey): string | null {
  const state = useApprovedItem(image);
  return state.state === 'ready' ? assetUrl(state.item) : null;
}

export function CheckIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" aria-hidden focusable="false">
      <path
        d="m3 8.5 3.2 3.2L13 4.8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
