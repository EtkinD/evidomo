import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { assetUrl, useAssetManifest, type AssetItem } from '../assets';
import { useMode } from '../mode';
import { COMBO_THEME_NAMES, type Mode } from '../palettes';
import { NotGenerated, ShowcaseShell } from '../ui';
import { LogoSwitch } from './logos';

export const COMBO_PAGES = [
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

/** Applies the combination theme (`combo-light` / `combo-dark`) and fonts to a subtree. */
export function ComboScope({
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
      data-theme={COMBO_THEME_NAMES[forced ?? mode]}
      data-direction="combo"
      className={`sc-body bg-base-100 text-base-content ${className}`}
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
      <ComboScope {...(mode === undefined ? {} : { mode })} className={className}>
        {children}
      </ComboScope>
    </section>
  );
}

/** Frame of the combo sample pages: the showcase shell, the logo switch, and the sample links. */
export function ComboShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <ShowcaseShell
      title={title}
      wide
      intro={
        <div className="mb-4 flex flex-col gap-3">
          <nav aria-label="Combination samples">
            <ul className="flex flex-wrap gap-x-1">
              <li>
                <Link
                  href="/showcase/combo"
                  className="inline-flex min-h-11 items-center px-2 underline"
                >
                  Overview
                </Link>
              </li>
              {COMBO_PAGES.map((page) => (
                <li key={page.slug}>
                  <Link
                    href={`/showcase/combo/${page.slug}`}
                    className="inline-flex min-h-11 items-center px-2 underline"
                  >
                    {page.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <LogoSwitch />
        </div>
      }
    >
      <div className="flex flex-col gap-6 pb-10">{children}</div>
    </ShowcaseShell>
  );
}

export const COMBO_IMAGES = {
  hero: {
    id: 'B2-HERO-1',
    alt: 'A bright, empty canal-house living room with a limewashed brick wall and oak floor',
  },
  floor: {
    id: 'B2-INT-1',
    alt: 'Morning light across an oak herringbone floor that meets clay kitchen tiles',
  },
  fireplace: {
    id: 'B2-INT-2',
    alt: 'A limewashed brick fireplace with an oak mantel and a small plant',
  },
  illustration: {
    id: 'B2-ILL-1',
    alt: 'A rounded house with its front door open and a potted plant by the step',
  },
} as const;

export type ComboImageKey = keyof typeof COMBO_IMAGES;

type ComboItem =
  | { readonly state: 'loading' }
  | { readonly state: 'missing' }
  | { readonly state: 'ready'; readonly item: AssetItem };

function useComboItem(key: ComboImageKey): ComboItem {
  const query = useAssetManifest();
  if (query.isPending) return { state: 'loading' };
  if (query.data?.status !== 'ready') return { state: 'missing' };
  const item = query.data.manifest.items.find((candidate) => candidate.id === COMBO_IMAGES[key].id);
  return item === undefined ? { state: 'missing' } : { state: 'ready', item };
}

/** One of the four chosen Muse images, in a fixed-ratio box so nothing shifts while it loads. */
export function ComboImage({
  image,
  aspect = 'aspect-3/2',
  className = '',
  fit = 'object-cover',
  position = '',
  alt,
}: {
  image: ComboImageKey;
  aspect?: string;
  className?: string;
  fit?: string;
  /** An `object-*` position class to crop differently from another use of the same image. */
  position?: string;
  alt?: string;
}) {
  const state = useComboItem(image);
  const [failed, setFailed] = useState(false);
  const frame = `${aspect} w-full overflow-hidden bg-base-200 ${className}`;
  if (state.state === 'loading') return <div className={frame} aria-hidden />;
  if (state.state === 'missing' || failed) {
    return (
      <NotGenerated what={COMBO_IMAGES[image].id} className={`${aspect} w-full ${className}`} />
    );
  }
  return (
    <div className={frame}>
      {/* eslint-disable-next-line @next/next/no-img-element -- local exploration asset, not optimised on purpose */}
      <img
        src={assetUrl(state.item)}
        alt={alt ?? COMBO_IMAGES[image].alt}
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

/** The URL of a chosen image for places that need a string (evidence photos), or null. */
export function useComboImageUrl(image: ComboImageKey): string | null {
  const state = useComboItem(image);
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
