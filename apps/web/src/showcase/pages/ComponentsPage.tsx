import { useId } from 'react';
import { useMode } from '../mode';
import type { DirectionId } from '../palettes';
import { Candidate, DirectionScope, EachDirection, ShowcaseShell } from '../ui';

function Buttons() {
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn btn-primary min-h-11">
        Primary
      </button>
      <button type="button" className="btn btn-secondary min-h-11">
        Secondary
      </button>
      <button type="button" className="btn btn-outline min-h-11">
        Outline
      </button>
      <button type="button" className="btn btn-ghost min-h-11">
        Ghost
      </button>
      <button type="button" className="btn btn-error min-h-11">
        Delete
      </button>
      <button type="button" className="btn btn-primary min-h-11" disabled>
        Disabled
      </button>
    </div>
  );
}

function Inputs() {
  const okId = useId();
  const errId = useId();
  const msgId = useId();
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="fieldset">
        <label htmlFor={okId} className="fieldset-legend">
          Living area (m²)
        </label>
        <input id={okId} className="input min-h-11 w-full" defaultValue="118" inputMode="numeric" />
      </fieldset>
      <fieldset className="fieldset">
        <label htmlFor={errId} className="fieldset-legend">
          Energy label
        </label>
        <input
          id={errId}
          className="input input-error min-h-11 w-full"
          defaultValue="Z"
          aria-invalid
          aria-describedby={msgId}
        />
        <p id={msgId} className="text-sm text-error">
          Use a label from A to G.
        </p>
      </fieldset>
    </div>
  );
}

function Badges() {
  return (
    <div className="flex flex-wrap gap-2">
      <span className="badge badge-primary">Primary</span>
      <span className="badge badge-secondary">Secondary</span>
      <span className="badge badge-outline">Pending</span>
      <span className="badge badge-info">Running</span>
      <span className="badge badge-success">Verified</span>
      <span className="badge badge-warning">Needs review</span>
      <span className="badge badge-error">Conflict</span>
    </div>
  );
}

function Alerts() {
  return (
    <div className="flex flex-col gap-2">
      <div role="status" className="alert alert-info">
        <span>Run queued. You can leave this page.</span>
      </div>
      <div role="status" className="alert alert-success">
        <span>All 24 claims verified.</span>
      </div>
      <div role="status" className="alert alert-warning">
        <span>2 claims need your decision.</span>
      </div>
      <div role="alert" className="alert alert-error">
        <span>The photo could not be analysed. Try again.</span>
      </div>
    </div>
  );
}

function SampleCard() {
  return (
    <div className="card border border-base-300 bg-base-100">
      <div className="card-body gap-2">
        <h4 className="card-title sc-display">Voorbeeldlaan 12</h4>
        <p className="text-base-content/70">5 rooms · 118 m² · Energy label B</p>
        <div className="card-actions justify-end">
          <button type="button" className="btn btn-primary min-h-11">
            Open project
          </button>
        </div>
      </div>
    </div>
  );
}

function FormEvidence() {
  return (
    <article className="card border border-base-300 bg-base-100">
      <div className="card-body gap-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-semibold">The kitchen was renewed in 2021</h4>
          <span className="badge badge-success">Verified</span>
        </div>
        <p className="text-sm font-medium">Form field</p>
        <p>
          <span className="text-base-content/70">Kitchen renovated:</span>{' '}
          <span className="sc-mono">2021</span>
        </p>
      </div>
    </article>
  );
}

/** Also used alone by the compare page. */
export function VoiceEvidence() {
  return (
    <article className="card border border-base-300 bg-base-100">
      <div className="card-body gap-2 p-4">
        <h4 className="font-semibold">South-facing garden</h4>
        <p className="text-sm font-medium">Voice walkthrough, turn at 0:42</p>
        <blockquote className="border-l-4 border-secondary pl-3 italic">
          &ldquo;The garden faces south, it gets sun until late.&rdquo;
        </blockquote>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-outline min-h-11"
            aria-label="Play the turn at 0:42"
          >
            <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
              <path d="M4 2.5v11l9-5.5z" />
            </svg>
            Play
          </button>
          <span className="sc-mono text-sm text-base-content/70">0:42 to 0:51</span>
        </div>
      </div>
    </article>
  );
}

function PhotoEvidence() {
  return (
    <article className="card border border-base-300 bg-base-100">
      <div className="card-body gap-2 p-4">
        <h4 className="font-semibold">Wooden floor in the living room</h4>
        <p className="text-sm font-medium">Photo</p>
        <div
          role="img"
          aria-label="Synthetic photo with the floor area highlighted"
          className="relative aspect-4/3 w-full overflow-hidden rounded-box bg-base-300"
        >
          <div className="absolute inset-x-0 bottom-0 h-1/3 border-4 border-accent bg-accent/60" />
        </div>
        <p className="text-sm text-base-content/70">Highlighted: floor, living room</p>
      </div>
    </article>
  );
}

function EvidenceCard() {
  return (
    <div className="flex flex-col gap-3">
      <FormEvidence />
      <VoiceEvidence />
      <PhotoEvidence />
    </div>
  );
}

const STEPS = [
  {
    name: 'Upload check',
    badge: 'badge-success',
    label: 'Completed',
    detail: '12 photos, 1 recording',
  },
  {
    name: 'Transcribe walkthrough',
    badge: 'badge-success',
    label: 'Completed',
    detail: '3 min 12 s',
  },
  { name: 'Analyse photos', badge: 'badge-info', label: 'Running', detail: '7 of 12 photos' },
  { name: 'Draft listing', badge: 'badge-outline', label: 'Pending', detail: 'Waits for photos' },
  { name: 'Compose pack', badge: 'badge-error', label: 'Failed', detail: 'Retry available' },
] as const;

function RunSteps() {
  return (
    <ol className="flex flex-col gap-2">
      {STEPS.map((step) => (
        <li
          key={step.name}
          className="flex flex-wrap items-center justify-between gap-2 rounded-box border border-base-300 p-3"
        >
          <div className="flex flex-col">
            <span className="font-medium">{step.name}</span>
            <span className="text-sm text-base-content/70">{step.detail}</span>
          </div>
          <span className={`badge ${step.badge}`}>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

function Conflict() {
  return (
    <div className="flex flex-col gap-3 rounded-box border border-secondary p-4">
      <h4 className="font-semibold">Living area differs between sources</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-box border border-base-300 p-3">
          <span className="text-sm text-base-content/70">Form</span>
          <span className="sc-mono text-2xl font-bold">118 m²</span>
          <button type="button" className="btn btn-outline min-h-11">
            Use form value
          </button>
        </div>
        <div className="flex flex-col gap-2 rounded-box border border-base-300 p-3">
          <span className="text-sm text-base-content/70">Voice walkthrough</span>
          <span className="sc-mono text-2xl font-bold">124 m²</span>
          <button type="button" className="btn btn-outline min-h-11">
            Use spoken value
          </button>
        </div>
      </div>
    </div>
  );
}

const BLOCKS = [
  { slug: 'BTN', title: 'Buttons', Body: Buttons },
  { slug: 'INP', title: 'Inputs with error', Body: Inputs },
  { slug: 'BDG', title: 'Badges', Body: Badges },
  { slug: 'ALR', title: 'Alerts', Body: Alerts },
  { slug: 'CARD', title: 'Card', Body: SampleCard },
  { slug: 'EVD', title: 'Evidence cards (form, voice, photo)', Body: EvidenceCard },
  { slug: 'RUN', title: 'Run steps', Body: RunSteps },
  { slug: 'CNF', title: 'Conflict side by side', Body: Conflict },
] as const;

function DirectionComponents({ direction }: { direction: DirectionId }) {
  const { mode } = useMode();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {BLOCKS.map(({ slug, title, Body }) => (
        <Candidate key={slug} id={`${direction}-${slug}-1`} title={title}>
          <DirectionScope direction={direction} mode={mode} className="rounded-box p-3">
            <Body />
          </DirectionScope>
        </Candidate>
      ))}
    </div>
  );
}

export function ComponentsPage() {
  return (
    <ShowcaseShell title="Components">
      <EachDirection render={(direction) => <DirectionComponents direction={direction} />} />
    </ShowcaseShell>
  );
}
