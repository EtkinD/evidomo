import Link from 'next/link';
import { SAMPLE_PAGES, SampleShell } from '../../samples/parts';

export function SamplesIndexPage() {
  return (
    <SampleShell title="Samples">
      <div className="mx-auto w-full max-w-6xl px-4">
        <p className="rounded-box border border-base-300 bg-base-100 p-4">
          Sample pages built with the approved design language and the product theme. They use
          invented data; the two review gates run the real Gate 1 and Gate 2 views against an
          in-memory stand-in for the API. Give feedback by <code className="font-mono">H-</code> ID,
          for example &ldquo;H-HERO-1 keep, H-LIST-1 more air&rdquo;.
        </p>
      </div>

      <section aria-labelledby="samples-title" className="mx-auto w-full max-w-6xl px-4">
        <h2 id="samples-title" className="mb-3 text-2xl font-bold">
          Sample pages
        </h2>
        <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {SAMPLE_PAGES.map((page) => (
            <li key={page.slug} className="card border border-base-300 bg-base-100">
              <div className="card-body gap-2 p-4">
                <h3 className="card-title text-lg">
                  <Link
                    href={`/showcase/samples/${page.slug}`}
                    className="link inline-flex min-h-11 items-center"
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
    </SampleShell>
  );
}
