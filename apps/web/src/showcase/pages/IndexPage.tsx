import Link from 'next/link';
import { SHAPE, THEME_NAMES, type Mode } from '../palettes';
import { SUB_PAGES } from '../sections';
import { Candidate, ShowcaseShell } from '../ui';
import { Lockup } from '../logo';
import { SampleScope } from '../samples/parts';

function ThemeSpecimen({ mode }: { mode: Mode }) {
  return (
    <SampleScope mode={mode} className="flex flex-col gap-4 rounded-box border border-base-300 p-4">
      <span className="font-mono text-xs text-base-content/70">{THEME_NAMES[mode]}</span>
      <Lockup markClass="size-10" textClass="text-2xl" />
      <div className="flex flex-wrap gap-2" aria-hidden>
        {[
          'bg-primary',
          'bg-secondary',
          'bg-accent',
          'bg-neutral',
          'bg-base-200',
          'bg-base-300',
        ].map((cls) => (
          <span key={cls} className={`size-10 rounded-field border border-base-300 ${cls}`} />
        ))}
      </div>
      <h3 className="text-3xl font-bold tracking-tight">Every claim, linked to its evidence</h3>
      <p>
        Source Sans 3 for reading: the living area is 118 m² (Wohnfläche), the energy label is B.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary min-h-11">
          Primary
        </button>
        <button type="button" className="btn btn-outline min-h-11">
          Outline
        </button>
        <span className="badge badge-success">Verified</span>
        <span className="badge badge-secondary">Needs review</span>
        <span className="badge badge-error">Conflict</span>
      </div>
    </SampleScope>
  );
}

export function IndexPage() {
  return (
    <ShowcaseShell title="Design language">
      <section
        aria-labelledby="about"
        className="mb-8 rounded-box border border-base-300 bg-base-100 p-4"
      >
        <h2 id="about" className="text-xl font-semibold">
          The approved language
        </h2>
        <p className="mt-2">
          Hearth Clay colours (light and dark), Hearth Canal type (Newsreader for headings, Source
          Sans 3 for text) and sharper shapes (radius {SHAPE.radiusSelector} / {SHAPE.radiusField} /{' '}
          {SHAPE.radiusBox}), the H-LOGO-1 mark, and four images. This is the living reference of
          the product theme: every page here renders with <code>{THEME_NAMES.light}</code> or{' '}
          <code>{THEME_NAMES.dark}</code>, switched with the Light/Dark control above. Specimens
          carry a stable ID such as <code className="font-mono">H-LOGO-1</code>; use it when giving
          feedback. This area exists on the dev server only.
        </p>
      </section>

      <section aria-labelledby="areas" className="mb-8">
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

      <section aria-labelledby="theme-title" className="mb-8">
        <h2 id="theme-title" className="mb-3 text-xl font-semibold">
          Theme specimen
        </h2>
        <Candidate id="H-THEME-1" title="Colours, type, shape, buttons, and badges in both themes">
          <div className="grid gap-4 md:grid-cols-2">
            <ThemeSpecimen mode="light" />
            <ThemeSpecimen mode="dark" />
          </div>
        </Candidate>
      </section>
    </ShowcaseShell>
  );
}
