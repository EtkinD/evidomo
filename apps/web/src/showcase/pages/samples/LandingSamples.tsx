import Link from 'next/link';
import { useState } from 'react';
import { Lockup } from '../../logo';
import { CheckIcon, ApprovedImage, SampleShell, Sample } from '../../samples/parts';

const CONTAINER = 'mx-auto w-full max-w-6xl px-4';
const SECTION_PAD = 'py-12 md:py-20';

function Nav() {
  return (
    <header className="border-b border-base-300 bg-base-100">
      <div
        className={`${CONTAINER} flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2`}
      >
        <Link
          href="/showcase/samples/landing"
          aria-label="Evidomo, home"
          className="inline-flex min-h-11 items-center"
        >
          <Lockup />
        </Link>
        <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
          <a href="#h-how-1" className="btn btn-ghost hidden min-h-11 md:inline-flex">
            How it works
          </a>
          <a href="#h-evid-1" className="btn btn-ghost hidden min-h-11 md:inline-flex">
            Evidence
          </a>
          <Link href="/showcase/samples/auth" className="btn btn-ghost min-h-11">
            Log in
          </Link>
          <Link href="/showcase/samples/auth" className="btn btn-outline min-h-11">
            Create account
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <div className="bg-base-200">
      <div
        className={`${CONTAINER} grid items-center gap-8 py-10 md:grid-cols-2 md:gap-12 md:py-16`}
      >
        <div className="flex flex-col gap-5">
          <p className="badge badge-secondary badge-outline w-fit">For estate agents</p>
          <h2 className="text-4xl leading-tight font-bold tracking-tight md:text-5xl">
            Every claim in your listing, linked to its evidence.
          </h2>
          <p className="max-w-prose text-lg text-base-content/70">
            Walk through the property, talk, and take photos. Evidomo drafts the listing and shows
            where every statement came from, so you approve facts, not guesses.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/showcase/samples/review" className="btn btn-primary min-h-11">
              Try the demo
            </Link>
            <Link href="/showcase/samples/auth" className="btn btn-outline min-h-11">
              Create account
            </Link>
          </div>
          <p className="text-sm text-base-content/70">
            The demo replays a finished run. No account, no upload.
          </p>
        </div>
        <div className="relative">
          <ApprovedImage image="hero" className="rounded-box" />
          <div
            role="note"
            aria-label="Example evidence for the living area"
            className="mt-3 flex items-start gap-3 rounded-box border border-base-300 bg-base-100 p-3 shadow-sm sm:absolute sm:right-3 sm:bottom-3 sm:mt-0 sm:max-w-xs"
          >
            <span className="badge badge-success shrink-0 gap-1">
              <CheckIcon />
              Verified
            </span>
            <p className="text-sm">
              <span className="font-semibold">Living area 118 m²</span>
              <br />
              <span className="text-base-content/70">
                Form field, and 2 turns of the walkthrough
              </span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

const STEPS = [
  {
    n: 1,
    title: 'Capture',
    text: 'Photograph each room and record one voice walkthrough. Fill in the facts you already know. It works on a phone, at the property.',
    image: 'floor',
  },
  {
    n: 2,
    title: 'Verify',
    text: 'Where the form, the voice, and the photos disagree, you decide. Every sentence of the draft shows the evidence behind it.',
    image: 'fireplace',
  },
  {
    n: 3,
    title: 'Pack',
    text: 'Download a listing pack: portal text, social caption, buyer Q&A, and fields for your portal, each claim traceable.',
    image: null,
  },
] as const;

function PackPreview() {
  return (
    <div
      className="flex aspect-3/2 w-full flex-col justify-center gap-2 bg-base-200 p-5"
      role="img"
      aria-label="A listing pack with two statements, each with a source"
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

function HowItWorks() {
  return (
    <div id="h-how-1" className={`${CONTAINER} ${SECTION_PAD} flex flex-col gap-8`}>
      <div className="flex max-w-2xl flex-col gap-2">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
          From a walk-through to a pack you can defend
        </h2>
        <p className="text-base-content/70">
          Three steps, and you stay in control of the second one.
        </p>
      </div>
      <ol className="grid gap-6 md:grid-cols-3">
        {STEPS.map((step) => (
          <li key={step.n} className="card overflow-hidden border border-base-300 bg-base-100">
            {step.image === null ? <PackPreview /> : <ApprovedImage image={step.image} />}
            <div className="card-body gap-2">
              <div className="flex items-center gap-3">
                <span className="badge badge-primary font-mono">{step.n}</span>
                <h3 className="card-title text-2xl">{step.title}</h3>
              </div>
              <p className="text-base-content/70">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PlayButton({ label }: { label: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-outline min-h-11"
      aria-pressed={playing}
      aria-label={`${playing ? 'Stop' : 'Play'}: ${label}`}
      onClick={() => setPlaying((value) => !value)}
    >
      <span aria-hidden>{playing ? '■' : '▶'}</span>
      {playing ? 'Stop' : 'Play'}
    </button>
  );
}

function EvidenceHighlight() {
  return (
    <div id="h-evid-1" className="bg-base-200">
      <div className={`${CONTAINER} ${SECTION_PAD} grid items-start gap-10 lg:grid-cols-2`}>
        <div className="flex flex-col gap-5">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            Every claim has a source
          </h2>
          <p className="text-lg text-base-content/70">
            Tap any sentence of the listing and see the field, the spoken turn, or the part of the
            photo it rests on. A sentence without evidence is flagged before it can leave.
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
            Highlighted phrases are claims with evidence. Other sentences wait for your decision.
          </p>
        </div>
        <ul className="flex flex-col gap-4" aria-label="Evidence for the highlighted claims">
          <li className="card border border-base-300 bg-base-100">
            <div className="card-body gap-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">Living area is 38 m²</h3>
                <span className="badge badge-success gap-1">
                  <CheckIcon />
                  Verified
                </span>
              </div>
              <p className="text-sm font-medium">Form field</p>
              <p>
                <span className="text-base-content/70">Living area:</span>{' '}
                <span className="font-mono">38 m²</span>
              </p>
            </div>
          </li>
          <li className="card border border-base-300 bg-base-100">
            <div className="card-body gap-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">Garden faces south</h3>
                <span className="badge badge-success gap-1">
                  <CheckIcon />
                  Verified
                </span>
              </div>
              <p className="text-sm font-medium">Voice walkthrough, turn at 0:42</p>
              <blockquote className="border-l-4 border-secondary pl-3 italic">
                &ldquo;The garden faces south, it gets sun until late.&rdquo;
              </blockquote>
              <div>
                <PlayButton label="the turn about the garden" />
              </div>
            </div>
          </li>
          <li className="card border border-base-300 bg-base-100">
            <div className="card-body gap-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">Herringbone oak floor</h3>
                <span className="badge badge-success gap-1">
                  <CheckIcon />
                  Verified
                </span>
              </div>
              <p className="text-sm font-medium">Photo</p>
              <div className="relative">
                <ApprovedImage
                  image="floor"
                  aspect="aspect-4/3"
                  className="rounded-box"
                  fit="object-contain"
                />
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-[18%] top-[30%] bottom-[22%] border-4 border-accent"
                />
              </div>
              <p className="text-sm text-base-content/70">The region is outlined on the photo.</p>
            </div>
          </li>
        </ul>
      </div>
    </div>
  );
}

const TRUST = [
  {
    title: 'Your files stay yours',
    text: 'Photos, voice memos, and transcripts are private to your account. Nothing is published unless you approve it.',
  },
  {
    title: 'You make the calls',
    text: 'Two reviews put you in charge: conflicting facts, then every flagged sentence. The run waits for you.',
  },
  {
    title: 'Edits are labelled',
    text: 'A virtually staged photo is shown next to its original with a visible label. Nothing is passed off as the real room.',
  },
] as const;

function Trust() {
  return (
    <div className={`${CONTAINER} ${SECTION_PAD} flex flex-col gap-8`}>
      <h2 className="max-w-2xl text-3xl font-bold tracking-tight md:text-4xl">
        Built to be checked
      </h2>
      <ul className="grid gap-6 md:grid-cols-3">
        {TRUST.map((item) => (
          <li key={item.title} className="flex flex-col gap-2 border-t-4 border-secondary pt-4">
            <h3 className="text-xl font-semibold">{item.title}</h3>
            <p className="text-base-content/70">{item.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Cta() {
  return (
    <div className="bg-primary text-primary-content">
      <div
        className={`${CONTAINER} flex flex-col items-start gap-5 py-12 md:flex-row md:items-center md:justify-between md:py-16`}
      >
        <div className="flex max-w-xl flex-col gap-2">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            See it on a finished run
          </h2>
          <p>The demo walks through the same screens you would use at a property.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/showcase/samples/review"
            className="btn min-h-11 border-base-100 bg-base-100 text-base-content"
          >
            Try the demo
          </Link>
          <Link
            href="/showcase/samples/auth"
            className="btn btn-ghost min-h-11 border-primary-content text-primary-content"
          >
            Create account
          </Link>
        </div>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-base-300 bg-base-200">
      <div
        className={`${CONTAINER} flex flex-col gap-6 py-10 md:flex-row md:items-start md:justify-between`}
      >
        <div className="flex flex-col gap-2">
          <Lockup />
          <p className="max-w-xs text-sm text-base-content/70">
            Evidence-linked listing packs for estate agents. Synthetic sample content.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-col md:items-end">
          {[
            ['How it works', '#h-how-1'],
            ['Evidence', '#h-evid-1'],
            ['Log in', '/showcase/samples/auth'],
          ].map(([label, href]) =>
            href?.startsWith('#') ? (
              <a key={label} href={href} className="inline-flex min-h-11 items-center underline">
                {label}
              </a>
            ) : (
              <Link
                key={label}
                href={href ?? '/'}
                className="inline-flex min-h-11 items-center underline"
              >
                {label}
              </Link>
            ),
          )}
        </nav>
      </div>
    </footer>
  );
}

export function SampleLandingPage() {
  return (
    <SampleShell title="Sample: landing page">
      <Sample id="H-NAV-1" title="Header with logo and navigation">
        <Nav />
      </Sample>
      <Sample id="H-HERO-1" title="Hero with B2-HERO-1 and an evidence chip">
        <Hero />
      </Sample>
      <Sample id="H-HOW-1" title="How it works: capture, verify, pack (B2-INT-1, B2-INT-2)">
        <HowItWorks />
      </Sample>
      <Sample id="H-EVID-1" title="Every claim has a source">
        <EvidenceHighlight />
      </Sample>
      <Sample id="H-TRUST-1" title="Trust and privacy">
        <Trust />
      </Sample>
      <Sample id="H-CTA-1" title="Call to action">
        <Cta />
      </Sample>
      <Sample id="H-FOOT-1" title="Footer">
        <Footer />
      </Sample>
    </SampleShell>
  );
}
