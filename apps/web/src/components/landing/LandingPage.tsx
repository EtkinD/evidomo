import Link from 'next/link';
import { useMe } from '../../lib/auth';
import { LANDING_IMAGES } from '../../lib/landing-images';
import { LandingImage } from './LandingImage';

/**
 * Extension point for the public demo (P4-09). While it is null the demo calls to action are not
 * rendered, so the page never links to a route that does not exist. Set it to the demo path when
 * that page ships.
 */
export const DEMO_HREF: string | null = null;

const CONTAINER = 'mx-auto w-full max-w-6xl px-4';
const SECTION_PAD = 'py-12 md:py-20';

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
      {DEMO_HREF !== null && (
        <Link href={DEMO_HREF} className={second}>
          See a finished run
        </Link>
      )}
    </div>
  );
}

function Hero() {
  return (
    <section aria-labelledby="landing-hero" className="bg-base-200">
      <div
        className={`${CONTAINER} grid items-center gap-8 py-10 md:grid-cols-2 md:gap-12 md:py-16`}
      >
        <div className="flex flex-col gap-5">
          <p className="badge badge-secondary badge-outline w-fit">For independent estate agents</p>
          <h1
            id="landing-hero"
            className="text-4xl leading-tight font-bold tracking-tight md:text-5xl"
          >
            Every claim in your listing, linked to its evidence.
          </h1>
          <p className="max-w-prose text-lg text-base-content/70">
            Walk the property, talk, and take photos. Evidomo drafts the listing pack and shows
            where each statement came from, so you approve facts, not guesses.
          </p>
          <Actions surface="light" />
        </div>
        <div className="relative">
          <LandingImage
            image={LANDING_IMAGES.hero}
            sizes="(min-width: 768px) 50vw, 100vw"
            priority
            className="rounded-box"
          />
          <div
            role="note"
            aria-label="Example of evidence for a claim"
            className="mt-3 flex items-start gap-3 rounded-box border border-base-300 bg-base-100 p-3 shadow-sm sm:absolute sm:right-3 sm:bottom-3 sm:mt-0 sm:max-w-xs"
          >
            <span className="badge badge-success shrink-0 gap-1">
              <CheckIcon />
              Verified
            </span>
            <p className="text-sm">
              <span className="font-semibold">Example: living area 118 m²</span>
              <br />
              <span className="text-base-content/70">From the fact form and the walkthrough</span>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function PackPreview() {
  return (
    <div
      className="flex aspect-3/2 w-full flex-col justify-center gap-2 bg-base-200 p-5"
      role="img"
      aria-label="Example of a listing pack: two statements, each with its source"
    >
      {[
        ['Bright living room of 38 m².', 'Form'],
        ['South-facing garden.', 'Voice, 0:42'],
      ].map(([text, source]) => (
        <div
          key={text}
          className="flex flex-wrap items-center justify-between gap-2 rounded-field border border-base-300 bg-base-100 px-3 py-2 text-sm"
        >
          <span>{text}</span>
          <span className="badge badge-outline">{source}</span>
        </div>
      ))}
      <div className="h-2 w-2/3 rounded-field bg-base-300" />
      <div className="h-2 w-1/2 rounded-field bg-base-300" />
    </div>
  );
}

const STEPS = [
  {
    n: 1,
    title: 'Capture',
    text: 'Photograph each room, record a voice walkthrough in your own language, and confirm the facts you know. It works on a phone, at the property.',
    image: LANDING_IMAGES.interior1,
  },
  {
    n: 2,
    title: 'Verify',
    text: 'Where the form, the voice, and the photos disagree, the run stops and you decide. Every sentence of the draft links to the evidence behind it.',
    image: LANDING_IMAGES.interior2,
  },
  {
    n: 3,
    title: 'Pack',
    text: 'Download a print-ready pack: listing text for portals and social, buyer Q&A cards, and structured portal fields. Each claim stays traceable.',
    image: null,
  },
] as const;

function HowItWorks() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="landing-how"
      className={`${CONTAINER} ${SECTION_PAD} flex scroll-mt-4 flex-col gap-8`}
    >
      <div className="flex max-w-2xl flex-col gap-2">
        <h2 id="landing-how" className="text-3xl font-bold tracking-tight md:text-4xl">
          From a walk-through to a pack you can defend
        </h2>
        <p className="text-base-content/70">Three steps, and you stay in control of the second.</p>
      </div>
      <ol className="grid gap-6 md:grid-cols-3">
        {STEPS.map((step) => (
          <li key={step.n} className="card overflow-hidden border border-base-300 bg-base-100">
            {step.image === null ? (
              <PackPreview />
            ) : (
              <LandingImage image={step.image} sizes="(min-width: 768px) 33vw, 100vw" />
            )}
            <div className="card-body gap-2">
              <div className="flex items-center gap-3">
                <span className="badge badge-primary font-mono" aria-hidden>
                  {step.n}
                </span>
                <h3 className="card-title text-2xl">{step.title}</h3>
              </div>
              <p className="text-base-content/70">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ExampleCard({
  claim,
  source,
  children,
}: {
  claim: string;
  source: string;
  children: React.ReactNode;
}) {
  return (
    <li className="card border border-base-300 bg-base-100">
      <div className="card-body gap-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{claim}</h3>
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
    <section id="evidence" aria-labelledby="landing-evidence" className="scroll-mt-4 bg-base-200">
      <div className={`${CONTAINER} ${SECTION_PAD} grid items-start gap-10 lg:grid-cols-2`}>
        <div className="flex flex-col gap-5">
          <h2 id="landing-evidence" className="text-3xl font-bold tracking-tight md:text-4xl">
            Every claim has a source
          </h2>
          <p className="text-lg text-base-content/70">
            Open any sentence of a listing pack and see the form field, the spoken turn, or the part
            of the photo it rests on. A claim without evidence is flagged for your decision before
            export.
          </p>
          <blockquote className="rounded-box border border-base-300 bg-base-100 p-5 text-xl leading-relaxed">
            A{' '}
            <mark className="rounded-field bg-accent px-1 text-accent-content">
              bright living room of 38 m²
            </mark>{' '}
            with an oak{' '}
            <mark className="rounded-field bg-accent px-1 text-accent-content">
              herringbone floor
            </mark>{' '}
            and a garden facing south.
          </blockquote>
          <p className="text-sm text-base-content/70">
            An illustrative example, not a real listing. Highlighted phrases are claims with
            evidence.
          </p>
        </div>
        <ul
          className="flex flex-col gap-4"
          aria-label="Example evidence for the highlighted claims"
        >
          <ExampleCard claim="Living area is 38 m²" source="Form field">
            <p>
              <span className="text-base-content/70">Living area:</span>{' '}
              <span className="font-mono">38 m²</span>
            </p>
          </ExampleCard>
          <ExampleCard claim="Garden faces south" source="Voice walkthrough, turn at 0:42">
            <blockquote className="border-l-4 border-secondary pl-3 italic">
              &ldquo;The garden faces south, it gets sun until late.&rdquo;
            </blockquote>
          </ExampleCard>
          <ExampleCard claim="Herringbone oak floor" source="Photo">
            <div className="relative aspect-4/3 overflow-hidden rounded-box">
              <LandingImage
                image={LANDING_IMAGES.interior1}
                sizes="(min-width: 1024px) 40vw, 100vw"
                className="size-full object-cover"
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-[18%] top-[30%] bottom-[22%] border-4 border-accent"
              />
            </div>
            <p className="text-sm text-base-content/70">The region is outlined on the photo.</p>
          </ExampleCard>
        </ul>
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
    <section
      aria-labelledby="landing-trust"
      className={`${CONTAINER} ${SECTION_PAD} flex flex-col gap-8`}
    >
      <div className="flex items-center justify-between gap-6">
        <h2 id="landing-trust" className="max-w-2xl text-3xl font-bold tracking-tight md:text-4xl">
          Built to be checked
        </h2>
        <div className="hidden w-32 shrink-0 sm:block lg:w-40">
          <LandingImage
            image={LANDING_IMAGES.illustration}
            sizes="(min-width: 1024px) 160px, 128px"
            className="rounded-box"
          />
        </div>
      </div>
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {TRUST.map((item) => (
          <li key={item.title} className="flex flex-col gap-2 border-t-4 border-secondary pt-4">
            <h3 className="text-xl font-semibold">{item.title}</h3>
            <p className="text-base-content/70">{item.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FinalCta() {
  return (
    <section aria-labelledby="landing-cta" className="bg-primary text-primary-content">
      <div
        className={`${CONTAINER} flex flex-col items-start gap-5 py-12 md:flex-row md:items-center md:justify-between md:py-16`}
      >
        <div className="flex max-w-xl flex-col gap-2">
          <h2 id="landing-cta" className="text-3xl font-bold tracking-tight md:text-4xl">
            Ready for your next listing?
          </h2>
          <p>Add photos and a voice walkthrough, then review the draft before anything leaves.</p>
        </div>
        <Actions surface="primary" />
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
