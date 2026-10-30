import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState, type ReactNode } from 'react';
import { assetUrl, useAssetManifest, type AssetItem } from './assets';
import { DIRECTIONS, SUB_PAGES, directionById } from './directions';
import { FONT_VARIABLE_CLASSES } from './fonts';
import { useMode } from './mode';
import { THEME_NAMES, type DirectionId } from './palettes';

export function ModeSwitch() {
  const { mode, setMode } = useMode();
  return (
    <div role="group" aria-label="Colour mode" className="join">
      {(['light', 'dark'] as const).map((value) => (
        <button
          key={value}
          type="button"
          className={`btn join-item min-h-11 ${mode === value ? 'btn-neutral' : 'btn-outline'}`}
          aria-pressed={mode === value}
          onClick={() => setMode(value)}
        >
          {value === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </div>
  );
}

/**
 * Page frame of every showcase page. The chrome uses the product theme; candidates sit inside
 * `DirectionScope`s with their own theme.
 */
export function ShowcaseShell({
  title,
  children,
  wide = false,
  intro,
}: {
  title: string;
  children: ReactNode;
  /** Full-width content below the title (the combination's sample pages); `intro` sits above it. */
  wide?: boolean;
  intro?: ReactNode;
}) {
  const { mode } = useMode();
  const router = useRouter();
  return (
    <div
      data-theme={`evidomo-${mode}`}
      className={`${FONT_VARIABLE_CLASSES} flex min-h-dvh flex-col bg-base-200 text-base-content`}
    >
      <header className="border-b border-base-300 bg-base-100 px-4 py-3">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2">
          <Link href="/showcase" className="inline-flex min-h-11 items-center text-lg font-bold">
            Evidomo showcase
          </Link>
          <span className="badge badge-warning">Dev only</span>
          <div className="ml-auto">
            <ModeSwitch />
          </div>
        </div>
        <nav aria-label="Showcase pages" className="mx-auto mt-1 max-w-6xl">
          <ul className="flex flex-wrap gap-x-2">
            {SUB_PAGES.map((page) => {
              const current =
                router.pathname === `/showcase/${page.slug}` ||
                router.pathname.startsWith(`/showcase/${page.slug}/`);
              return (
                <li key={page.slug}>
                  <Link
                    href={`/showcase/${page.slug}`}
                    aria-current={current ? 'page' : undefined}
                    className={`inline-flex min-h-11 items-center px-2 ${
                      current ? 'font-semibold underline' : 'text-base-content/70 hover:underline'
                    }`}
                  >
                    {page.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <main className={wide ? 'w-full flex-1' : 'mx-auto w-full max-w-6xl flex-1 px-4 py-6'}>
        <div className={wide ? 'mx-auto w-full max-w-6xl px-4 pt-6' : ''}>
          <h1 className="mb-1 text-3xl font-bold">{title}</h1>
          <p className="mb-6 text-sm text-base-content/70">
            Give feedback by ID, for example &ldquo;B2-COL-2 yes, B3-TYPE-1 no&rdquo;.
          </p>
          {intro}
        </div>
        {children}
      </main>
    </div>
  );
}

/** Applies a direction's theme and fonts to its subtree. */
export function DirectionScope({
  direction,
  mode,
  className = '',
  children,
}: {
  direction: DirectionId;
  mode: 'light' | 'dark';
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-theme={THEME_NAMES[direction][mode]}
      data-direction={direction}
      className={`sc-body bg-base-100 text-base-content ${className}`}
    >
      {children}
    </div>
  );
}

/** One directional section of a sub-page: heading with name and tagline. */
export function DirectionSection({
  direction,
  children,
}: {
  direction: DirectionId;
  children: ReactNode;
}) {
  const info = directionById(direction);
  const headingId = `direction-${direction}`;
  return (
    <section aria-labelledby={headingId} className="mb-10 flex flex-col gap-4">
      <h2 id={headingId} className="text-2xl font-bold">
        <span className="font-mono">{direction}</span> {info.name}{' '}
        <span className="text-base font-normal text-base-content/70">{info.tagline}</span>
      </h2>
      {children}
    </section>
  );
}

/** A candidate with its stable feedback ID. */
export function Candidate({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <figure
      className="m-0 flex flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-3"
      aria-label={`${id} ${title}`}
    >
      <figcaption className="flex flex-wrap items-center gap-2">
        <code className="badge badge-neutral font-mono">{id}</code>
        <span className="text-sm text-base-content/70">{title}</span>
      </figcaption>
      {children}
    </figure>
  );
}

export function EachDirection({ render }: { render: (direction: DirectionId) => ReactNode }) {
  return (
    <>
      {DIRECTIONS.map((direction) => (
        <DirectionSection key={direction.id} direction={direction.id}>
          {render(direction.id)}
        </DirectionSection>
      ))}
    </>
  );
}

/** Shown when the Muse manifest or a single file does not exist. */
export function NotGenerated({ what, className = '' }: { what: string; className?: string }) {
  return (
    <div
      role="note"
      className={`flex items-center justify-center rounded-box border border-dashed border-base-300 bg-base-200 p-4 text-center text-sm text-base-content/70 ${className}`}
    >
      {what}: not generated yet.
    </div>
  );
}

/** A Muse image with its ID and prompt; falls back to the placeholder when the file is missing. */
export function AssetFigure({ item, aspectClass = '' }: { item: AssetItem; aspectClass?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <Candidate id={item.id} title={`${item.kind}, ${item.width}x${item.height}`}>
      {failed ? (
        <NotGenerated what={`File ${item.file}`} className={`min-h-40 ${aspectClass}`} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- local exploration asset, not optimised on purpose
        <img
          src={assetUrl(item)}
          alt={`${item.id}: ${item.prompt}`}
          width={item.width}
          height={item.height}
          loading="lazy"
          className={`h-auto w-full rounded-field bg-base-200 object-cover ${aspectClass}`}
          onError={() => setFailed(true)}
        />
      )}
      <details>
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-base-content/70">
          Prompt
        </summary>
        <p className="text-sm text-base-content/70">{item.prompt}</p>
      </details>
    </Candidate>
  );
}

/** Manifest-driven asset grid for one direction; handles loading, missing, and invalid states. */
export function AssetGrid({
  direction,
  kinds,
  emptyLabel,
  columns = 'sm:grid-cols-2 lg:grid-cols-3',
}: {
  direction: DirectionId;
  kinds: readonly AssetItem['kind'][];
  emptyLabel: string;
  columns?: string;
}) {
  const query = useAssetManifest();
  if (query.isPending) {
    return (
      <div role="status" className="flex items-center gap-2 text-base-content/70">
        <span className="loading loading-spinner loading-sm" aria-hidden />
        Loading assets
      </div>
    );
  }
  if (query.isError) {
    return (
      <div role="alert" className="alert alert-error">
        <span>The asset manifest could not be loaded.</span>
      </div>
    );
  }
  if (query.data.status === 'missing')
    return <NotGenerated what={emptyLabel} className="min-h-40" />;
  if (query.data.status === 'invalid') {
    return (
      <div role="alert" className="alert alert-error">
        <span>manifest.json does not match the expected shape: {query.data.message}</span>
      </div>
    );
  }
  const items = query.data.manifest.items.filter(
    (item) => item.direction === direction && kinds.includes(item.kind),
  );
  if (items.length === 0) return <NotGenerated what={emptyLabel} className="min-h-40" />;
  return (
    <div className={`grid gap-4 ${columns}`}>
      {items.map((item) => (
        <AssetFigure key={item.id} item={item} />
      ))}
    </div>
  );
}
