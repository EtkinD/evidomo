import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState, type ReactNode } from 'react';
import { assetUrl, type AssetItem } from './assets';
import { useMode } from './mode';
import { SUB_PAGES } from './sections';

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

/** Page frame of every showcase page, in the product theme (`evidomo-light` / `evidomo-dark`). */
export function ShowcaseShell({
  title,
  children,
  wide = false,
  intro,
}: {
  title: string;
  children: ReactNode;
  /** Full-width content below the title (the sample pages); `intro` sits above it. */
  wide?: boolean;
  intro?: ReactNode;
}) {
  const { mode } = useMode();
  const router = useRouter();
  return (
    <div
      data-theme={`evidomo-${mode}`}
      className="flex min-h-dvh flex-col bg-base-200 text-base-content"
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
            The approved design language, rendered with the product theme. Give feedback by ID, for
            example &ldquo;H-HERO-1 more air&rdquo;.
          </p>
          {intro}
        </div>
        {children}
      </main>
    </div>
  );
}

/** A specimen with its stable feedback ID. */
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
        // eslint-disable-next-line @next/next/no-img-element -- local dev-only asset, not optimised on purpose
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
