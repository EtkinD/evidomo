import Link from 'next/link';
import type { CSSProperties } from 'react';
import { useMe } from '../../lib/auth';
import { LANDING_IMAGES } from '../../lib/landing-images';
import { LandingImage } from './LandingImage';

/** The public demo replay (P4-09). */
export const DEMO_HREF = '/demo';

const CONTAINER = 'mx-auto w-full max-w-6xl px-4';
const SECTION_PAD = 'py-14 md:py-24';

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden focusable="false">
      <path
        d="M3 8.5l3.2 3L13 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Sets CSS custom properties (animation order, positions) on an element. */
function vars(values: Record<string, string | number>): CSSProperties {
  return values;
}

type Surface = 'light' | 'primary';

/** Calls to action that depend on the session. `primary` surface is the clay-coloured last band. */
function Actions({ surface }: { surface: Surface }) {
  const me = useMe();
  const onPrimary = surface === 'primary';

  // Reserve the row's height while the session check runs, so the page does not jump.
  if (me.isPending) return <div className="min-h-11" aria-hidden />;

  const main = onPrimary ? 'btn min-h-11 border-base-100 bg-base-100 text-base-content' : null;
  const second = onPrimary
    ? 'btn btn-ghost min-h-11 border-primary-content text-primary-content'
    : 'btn btn-outline min-h-11';

  return (
    <div className="flex flex-wrap gap-3">
      {me.data ? (
        <Link href="/projects" className={main ?? 'btn btn-primary min-h-11'}>
          Go to your projects
        </Link>
      ) : (
        <>
          <Link href="/register" className={main ?? 'btn btn-primary min-h-11'}>
            Create account
          </Link>
          <Link href="/login" className={second}>
            Log in
          </Link>
        </>
      )}
      <Link href={DEMO_HREF} className={second}>
        See a finished run
      </Link>
    </div>
  );
}

type HeroNote = {
  n: number;
  claim: string;
  source: string;
  /** Marker position in percent of the photograph. */
  px: number;
  py: number;
};

// Positions are matched to the hero photograph (windows, brick wall, floor). The notes are an
// illustration of the product, not facts about the picture, and the caption says so. On large
// screens the photo takes the left 70% of the figure and the notes stand in the right 30%.
const HERO_NOTES: readonly HeroNote[] = [
  { n: 1, claim: 'Two tall windows', source: 'Photo', px: 73, py: 22 },
  { n: 2, claim: 'Brick feature wall', source: 'Photo', px: 22, py: 45 },
  { n: 3, claim: 'Living area 38 m²', source: 'Form field', px: 45, py: 86 },
];

function Hero() {
  return (
    <section aria-labelledby="landing-hero" className="grain bg-base-200">
      <div
        className={`${CONTAINER} grid gap-x-10 gap-y-8 pt-8 pb-16 md:pt-14 md:pb-28 lg:grid-cols-12`}
      >
        <h1
          id="landing-hero"
          className="text-[clamp(2.6rem,8.6vw,6.25rem)] leading-[0.98] font-medium tracking-tight lg:col-span-11"
        >
          {/* Each line rises out of its own mask; the spaces keep the accessible name one sentence. */}
          <span className="line-mask">
            <span className="line-rise [--i:0]">Every claim</span>
          </span>{' '}
          <span className="line-mask">
            <span className="line-rise [--i:1]">in your listing,</span>
          </span>{' '}
          <span className="line-mask">
            <span className="line-rise [--i:2]">
              linked to its evidence.
              <sup aria-hidden className="ml-1 align-super text-[0.32em] font-normal text-primary">
                1
              </sup>
            </span>
          </span>
        </h1>

        <div className="fade-late flex flex-col gap-6 lg:col-span-4 lg:pt-6">
          <p className="max-w-prose font-display text-xl leading-relaxed md:text-2xl">
            Walk the property, talk, and take photos. Evidomo drafts the listing pack and shows
            where each statement came from, so you approve facts, not guesses.
          </p>
          <Actions surface="light" />
          <p className="max-w-prose border-t border-base-content/25 pt-3 font-display text-base text-base-content/70 italic">
            <span aria-hidden className="mr-1 text-primary not-italic">
              1
            </span>
            Open any sentence of a pack to see the form field, the spoken turn, or the part of the
            photo it rests on.
          </p>
        </div>

        <figure className="relative lg:col-span-8 lg:-mt-4">
          <div className="relative">
            {/* On large screens the stage is static, so markers, lines, and notes all position
                against the whole figure; on a phone the stage is the photo alone. */}
            <div className="relative lg:static">
              {/* Two sheets under the print, so the photo reads as the top of a stack. */}
              <div
                aria-hidden
                className="absolute inset-0 hidden translate-x-3 translate-y-4 rotate-2 bg-base-100 shadow-sheet lg:block lg:w-[70%]"
              />
              <div
                aria-hidden
                className="absolute inset-0 hidden -translate-x-2 translate-y-2 -rotate-1 bg-base-300 shadow-sheet lg:block lg:w-[70%]"
              />
              <div className="settle relative bg-base-100 p-2 shadow-lift lg:w-[70%]">
                <LandingImage
                  image={LANDING_IMAGES.hero}
                  sizes="(min-width: 1024px) 560px, 100vw"
                  priority
                />
              </div>

              {HERO_NOTES.map((note) => (
                <span
                  key={note.n}
                  aria-hidden
                  className="pin absolute top-[calc(var(--py)*1%)] left-[calc(var(--px)*1%)] z-10 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-content shadow-sheet ring-2 ring-base-100 lg:left-[calc(var(--px)*0.7%)]"
                  style={vars({ '--px': note.px, '--py': note.py, '--i': note.n })}
                >
                  {note.n}
                </span>
              ))}
              {HERO_NOTES.map((note) => (
                <span
                  key={note.n}
                  aria-hidden
                  className="leader absolute top-[calc(var(--py)*1%)] left-[calc(var(--px)*0.7%)] hidden w-[calc((100_-_var(--px))*0.7%)] -translate-y-px lg:block"
                  style={vars({ '--px': note.px, '--py': note.py, '--i': note.n })}
                />
              ))}
            </div>

            <ol
              aria-label="Example notes on the photo"
              className="mt-4 flex flex-col gap-3 lg:mt-0 lg:contents"
            >
              {HERO_NOTES.map((note) => (
                <li
                  key={note.n}
                  className="note-in flex items-start gap-3 bg-base-100 p-3 shadow-sheet lg:absolute lg:top-[calc(var(--py)*1%)] lg:left-[70%] lg:w-[30%] lg:-translate-y-1/2"
                  style={vars({ '--py': note.py, '--i': note.n })}
                >
                  <span
                    aria-hidden
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-content"
                  >
                    {note.n}
                  </span>
                  <p className="text-sm leading-snug">
                    <span className="font-semibold">{note.claim}</span>
                    <br />
                    <span className="inline-flex items-center gap-1 text-base-content/70">
                      <CheckIcon />
                      {note.source}
                    </span>
                  </p>
                </li>
              ))}
            </ol>
          </div>
          <figcaption className="mt-5 max-w-lg font-display text-base text-base-content/70 italic lg:w-[70%]">
            An illustrative example, not a real listing. Each numbered note names the source of a
            claim.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

function PackPreview() {
  return (
    <div
      className="relative mx-3 mt-2 mb-3 aspect-3/2 w-full max-w-72"
      role="img"
      aria-label="Example of a listing pack: two statements, each with its source"
    >
      <div
        aria-hidden
        className="absolute inset-0 translate-x-2 translate-y-2 rotate-3 bg-base-300 shadow-sheet"
      />
      <div className="absolute inset-0 flex flex-col justify-center gap-2 bg-base-100 p-4 shadow-sheet">
        {[
          ['Bright living room of 38 m².', 'Form'],
          ['South-facing garden.', 'Voice, 0:42'],
        ].map(([text, source]) => (
          <div
            key={text}
            className="flex flex-wrap items-center justify-between gap-1 border-b border-base-content/20 pb-1.5 text-sm"
          >
            <span>{text}</span>
            <span className="text-base-content/70 italic">{source}</span>
          </div>
        ))}
        <div className="h-1.5 w-2/3 bg-base-300" />
        <div className="h-1.5 w-1/2 bg-base-300" />
      </div>
    </div>
  );
}

const STEPS = [
  {
    n: 1,
    title: 'Capture',
    text: 'Photograph each room, record a voice walkthrough in your own language, and confirm the facts you know. It works on a phone, at the property.',
    image: LANDING_IMAGES.interior1,
    tilt: '-rotate-2',
  },
  {
    n: 2,
    title: 'Verify',
    text: 'Where the form, the voice, and the photos disagree, the run stops and you decide. Every sentence of the draft links to the evidence behind it.',
    image: LANDING_IMAGES.interior2,
    tilt: 'rotate-1',
  },
  {
    n: 3,
    title: 'Pack',
    text: 'Download a print-ready pack: listing text for portals and social, buyer Q&A cards, and structured portal fields. Each claim stays traceable.',
    image: null,
    tilt: '',
  },
] as const;

function HowItWorks() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="landing-how"
      className={`${CONTAINER} ${SECTION_PAD} grid scroll-mt-4 gap-8 lg:grid-cols-12 lg:gap-12`}
    >
      <div className="flex flex-col gap-3 self-start lg:sticky lg:top-8 lg:col-span-4">
        <h2
          id="landing-how"
          className="text-4xl leading-[1.05] font-medium tracking-tight md:text-5xl"
        >
          From a walk-through to a pack you can defend
        </h2>
        <p className="font-display text-xl text-base-content/70 italic">
          Three steps, and you stay in control of the second.
        </p>
      </div>
      <ol className="lg:col-span-8">
        {STEPS.map((step) => (
          <li
            key={step.n}
            className="grid gap-x-6 gap-y-4 border-t border-base-content/25 py-8 md:grid-cols-[3.5rem_1fr_16rem] first:md:pt-2 first:border-t-0 lg:grid-cols-[4.5rem_1fr_17rem]"
          >
            <span
              aria-hidden
              className="font-display text-6xl leading-none font-light text-primary md:text-7xl"
            >
              {step.n}
            </span>
            <div className="flex flex-col gap-2">
              <h3 className="text-3xl font-medium">{step.title}</h3>
              <p className="max-w-prose text-base-content/70">{step.text}</p>
            </div>
            <div className="md:pt-1">
              {step.image === null ? (
                <PackPreview />
              ) : (
                <div className={`tilt w-full max-w-72 bg-base-100 p-1.5 shadow-sheet ${step.tilt}`}>
                  <LandingImage image={step.image} sizes="(min-width: 768px) 272px, 100vw" />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Claim({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <>
      <mark data-claim={n} className="claim bg-transparent text-base-content">
        {children}
      </mark>
      <sup aria-hidden className="ml-0.5 font-sans text-[0.4em] font-semibold text-primary">
        {n}
      </sup>
    </>
  );
}

function ExampleNote({
  n,
  claim,
  source,
  className = '',
  children,
}: {
  n: number;
  claim: string;
  source: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <li
      data-note={n}
      className={`lift grain relative flex gap-4 bg-base-100 p-4 shadow-sheet ${className}`}
    >
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-content"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xl font-medium">{claim}</h3>
          <span className="badge badge-success gap-1">
            <CheckIcon />
            Verified
          </span>
        </div>
        <p className="text-sm font-medium">{source}</p>
        {children}
      </div>
    </li>
  );
}

function EvidenceHighlight() {
  return (
    <section
      id="evidence"
      aria-labelledby="landing-evidence"
      className="grain scroll-mt-4 bg-base-200"
    >
      <div
        className={`${CONTAINER} ${SECTION_PAD} dossier grid items-start gap-10 lg:grid-cols-12`}
      >
        <div className="flex flex-col gap-5 lg:sticky lg:top-8 lg:col-span-4">
          <h2
            id="landing-evidence"
            className="text-4xl leading-[1.05] font-medium tracking-tight md:text-5xl"
          >
            Every claim has a source
          </h2>
          <p className="text-lg text-base-content/70">
            Open any sentence of a listing pack and see the form field, the spoken turn, or the part
            of the photo it rests on. A claim without evidence is flagged for your decision before
            export.
          </p>
          <p className="font-display text-base text-base-content/70 italic">
            An illustrative example, not a real listing. Highlighted phrases are claims with
            evidence.
          </p>
        </div>

        <div className="lg:col-span-8">
          <blockquote className="grain bg-base-100 p-6 font-display text-3xl leading-snug shadow-sheet md:p-10 md:text-[2.5rem] md:leading-[1.25]">
            A bright <Claim n={1}>living room of 38 m²</Claim> with an{' '}
            <Claim n={2}>oak herringbone floor</Claim> and a{' '}
            <Claim n={3}>garden facing south</Claim>.
          </blockquote>

          <ol
            aria-label="Example evidence for the highlighted claims"
            className="relative z-10 -mt-4 flex flex-col gap-4 sm:ml-10 md:-mt-8 md:ml-16"
          >
            <ExampleNote n={1} claim="Living area is 38 m²" source="Form field">
              <p>
                <span className="text-base-content/70">Living area:</span>{' '}
                <span className="font-mono">38 m²</span>
              </p>
            </ExampleNote>
            <ExampleNote n={2} claim="Herringbone oak floor" source="Photo" className="md:ml-8">
              <div className="relative aspect-4/3 max-w-sm overflow-hidden">
                <LandingImage
                  image={LANDING_IMAGES.interior1}
                  sizes="(min-width: 1024px) 384px, 100vw"
                  className="size-full object-cover"
                />
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-[18%] top-[30%] bottom-[22%] border-4 border-accent"
                />
              </div>
              <p className="text-sm text-base-content/70">The region is outlined on the photo.</p>
            </ExampleNote>
            <ExampleNote n={3} claim="Garden faces south" source="Voice walkthrough, turn at 0:42">
              <blockquote className="border-l-4 border-secondary pl-3 font-display text-lg italic">
                &ldquo;The garden faces south, it gets sun until late.&rdquo;
              </blockquote>
            </ExampleNote>
          </ol>
        </div>
      </div>
    </section>
  );
}

const TRUST = [
  {
    title: 'You make the calls',
    text: 'Two reviews put you in charge: conflicting facts first, then every flagged sentence and staged image. The run waits for you.',
  },
  {
    title: 'Staging is labelled',
    text: 'A virtually staged image is labelled as such and always shown next to the original.',
  },
  {
    title: 'Private details are removed',
    text: 'Photo metadata, including GPS, is stripped at upload. Faces and license plates are blurred in exports.',
  },
  {
    title: 'It assists, it does not certify',
    text: 'The publication checklist helps you spot missing items. Evidomo does not certify legal compliance, value a property, or publish to portals for you.',
  },
] as const;

function Trust() {
  return (
    <section aria-labelledby="landing-trust" className="grain bg-neutral text-neutral-content">
      <div className={`${CONTAINER} ${SECTION_PAD} grid gap-10 lg:grid-cols-12`}>
        <div className="flex items-start justify-between gap-6 lg:col-span-4 lg:flex-col">
          <h2
            id="landing-trust"
            className="text-4xl leading-[1.05] font-medium tracking-tight md:text-5xl"
          >
            Built to be checked
          </h2>
          <div className="w-28 shrink-0 -rotate-3 bg-base-100 p-1.5 shadow-lift lg:w-40">
            <LandingImage
              image={LANDING_IMAGES.illustration}
              sizes="(min-width: 1024px) 160px, 112px"
            />
          </div>
        </div>
        <ul className="grid gap-x-12 gap-y-10 sm:grid-cols-2 lg:col-span-8">
          {TRUST.map((item) => (
            <li
              key={item.title}
              className="flex flex-col gap-2 border-t border-neutral-content/40 pt-4"
            >
              <h3 className="text-2xl font-medium">{item.title}</h3>
              <p className="text-neutral-content/80">{item.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    // The hard colour stop sits at the middle of the sheet: dark above (the band before), the
    // footer's colour below, so the clay sheet straddles the two.
    <section
      aria-labelledby="landing-cta"
      className="bg-linear-to-b from-neutral from-50% to-base-200 to-50%"
    >
      <div className={CONTAINER}>
        <div className="grain flex flex-col items-start gap-6 bg-primary p-6 text-primary-content shadow-lift md:flex-row md:items-center md:justify-between md:p-12">
          <div className="flex max-w-xl flex-col gap-2">
            <h2
              id="landing-cta"
              className="text-4xl leading-[1.05] font-medium tracking-tight md:text-5xl"
            >
              Ready for your next listing?
            </h2>
            <p className="text-lg">
              Add photos and a voice walkthrough, then review the draft before anything leaves.
            </p>
          </div>
          <Actions surface="primary" />
        </div>
      </div>
    </section>
  );
}

export function LandingPage() {
  return (
    <main className="flex-1">
      <Hero />
      <HowItWorks />
      <EvidenceHighlight />
      <Trust />
      <FinalCta />
    </main>
  );
}
