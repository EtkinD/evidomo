import Link from 'next/link';
import { DIRECTIONS, SUB_PAGES } from '../directions';
import { useMode } from '../mode';
import { DirectionScope, ShowcaseShell } from '../ui';

export function IndexPage() {
  const { mode } = useMode();
  return (
    <ShowcaseShell title="Design directions">
      <section
        aria-labelledby="how-to"
        className="mb-8 rounded-box border border-base-300 bg-base-100 p-4"
      >
        <h2 id="how-to" className="text-xl font-semibold">
          How to give feedback
        </h2>
        <p className="mt-2">
          Every candidate carries a stable ID in the form <code className="font-mono">A-COL-2</code>{' '}
          (direction, area, number). Write feedback by ID, for example &ldquo;A-COL-2 keep, B-TYPE-1
          too soft, C-BTN-1 keep with rounder corners&rdquo;. Use the Light/Dark switch above; it
          applies to every sub-page. This area exists on the dev server only.
        </p>
      </section>

      <section aria-labelledby="directions" className="mb-8">
        <h2 id="directions" className="mb-3 text-xl font-semibold">
          Three directions
        </h2>
        <ul className="grid gap-4 md:grid-cols-3">
          {DIRECTIONS.map((direction) => (
            <li key={direction.id}>
              <DirectionScope
                direction={direction.id}
                mode={mode}
                className="flex h-full flex-col gap-3 rounded-box border border-base-300 p-4"
              >
                <h3 className="sc-display text-2xl font-bold">
                  <span className="sc-mono">{direction.id}</span> {direction.name}
                </h3>
                <p className="font-medium text-primary">{direction.tagline}</p>
                <p className="text-base-content/70">{direction.mood}</p>
                <div className="flex gap-2" aria-hidden>
                  <span className="size-8 rounded-field bg-primary" />
                  <span className="size-8 rounded-field bg-secondary" />
                  <span className="size-8 rounded-field bg-accent" />
                  <span className="size-8 rounded-field border border-base-300 bg-base-200" />
                </div>
                <p className="sc-mono text-xs text-base-content/70">
                  {direction.fonts.display} / {direction.fonts.body} / {direction.fonts.mono}
                </p>
              </DirectionScope>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="areas">
        <h2 id="areas" className="mb-3 text-xl font-semibold">
          Areas
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SUB_PAGES.map((page) => (
            <li key={page.slug} className="card border border-base-300 bg-base-100">
              <div className="card-body gap-1 p-4">
                <h3 className="card-title">
                  <Link
                    href={`/showcase/${page.slug}`}
                    className="inline-flex min-h-11 items-center underline"
                  >
                    {page.label}
                  </Link>
                </h3>
                <p className="text-sm text-base-content/70">{page.summary}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </ShowcaseShell>
  );
}
