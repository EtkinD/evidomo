import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { applySourcesFromUrl } from '../../lib/sources';
import { Boundaries } from './Boundaries';
import { Ledger } from './Ledger';
import { Numbers } from './Numbers';
import { CONTAINER } from './Section';
import { Specimen } from './Specimen';
import { SourceNotes, Sourced, SourcesSwitch } from './sources';

/** The public demo replay: with one published run it opens the sample file itself. */
export const DEMO_HREF = '/demo';

function OpenSample({ className }: { className: string }) {
  const t = useTranslations('landing.actions');
  return (
    <Link href={DEMO_HREF} className={className}>
      {t('openSample')}
    </Link>
  );
}

/**
 * The landing page as an audited page (redesign round 5): the page makes the product's promise
 * about itself. A specimen first, then the sample run's ledger, the eval numbers with their
 * limits, and the boundaries. Every factual claim has a source note behind "Show sources".
 */
export function LandingPage() {
  const t = useTranslations('landing.hero');
  const { asPath } = useRouter();

  // `?sources=on` is read after hydration (a static page has no query on the server).
  useEffect(() => {
    applySourcesFromUrl(new URL(asPath, 'http://localhost').search);
  }, [asPath]);

  // `overflow-x-clip`, not `hidden`: the source notes slide in from the margin, and that must
  // never widen the page (clip makes no scroll container, so the sticky bar still sticks).
  return (
    <main className="flex-1 overflow-x-clip">
      <section aria-labelledby="landing-hero" className="grain bg-base-200">
        <div
          className={`${CONTAINER} grid gap-x-10 gap-y-8 pt-8 pb-12 md:pt-12 md:pb-16 lg:grid-cols-12`}
        >
          <h1
            id="landing-hero"
            className="text-[clamp(2.4rem,7.4vw,4.25rem)] leading-[1] font-medium tracking-tight lg:col-span-8"
          >
            {/* Each line rises out of its own mask; the spaces keep the accessible name one sentence. */}
            <span className="line-mask">
              <span className="line-rise [--i:0]">{t('line1')}</span>
            </span>{' '}
            <span className="line-mask">
              <span className="line-rise [--i:1]">{t('line2')}</span>
            </span>{' '}
            <span className="line-mask">
              <span className="line-rise [--i:2]">{t('line3')}</span>
            </span>
          </h1>

          <div className="fade-late flex flex-col gap-5 lg:col-span-4 lg:pt-3">
            <p className="max-w-prose font-display text-xl leading-relaxed">
              <Sourced id="lede">{t('lede')}</Sourced>
            </p>
            <SourceNotes ids={['lede']} />
            {/* One action. On a phone it lives in the sticky bar below instead. */}
            <OpenSample className="btn btn-primary min-h-11 w-fit max-md:hidden" />
          </div>

          <Specimen />
        </div>
      </section>

      <Ledger />
      <Numbers />
      <Boundaries />

      <div className={`${CONTAINER} border-t border-base-content/25 py-8`}>
        <OpenSample className="inline-flex min-h-11 items-center font-display text-xl underline underline-offset-8" />
      </div>

      {/* A phone's one-thumb bar: it stays on screen while the page scrolls and comes to rest at
          the end of the page, above the colophon. */}
      <div className="sticky bottom-0 z-10 border-t border-base-content/25 bg-base-200 md:hidden">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2">
          <SourcesSwitch />
          <OpenSample className="btn btn-primary h-auto min-h-11 flex-1 py-2 whitespace-normal" />
        </div>
      </div>
    </main>
  );
}
