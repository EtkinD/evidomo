import Link from 'next/link';
import { CheckIcon, SampleShell, Sample } from '../../samples/parts';

type StepStatus = 'done' | 'running' | 'paused' | 'waiting';

const STEPS: readonly {
  name: string;
  detail: string;
  status: StepStatus;
  cost: string;
  time: string;
}[] = [
  {
    name: 'Reading the form',
    detail: '12 facts from your fact form',
    status: 'done',
    cost: '$0.00',
    time: '1 s',
  },
  {
    name: 'Reading the walkthrough',
    detail: 'Transcribing 4:12 of speech into turns',
    status: 'done',
    cost: '$0.18',
    time: '38 s',
  },
  {
    name: 'Looking at the photos',
    detail: '24 photos checked for rooms, fittings, and condition',
    status: 'done',
    cost: '$0.52',
    time: '1 min 20 s',
  },
  {
    name: 'Comparing the facts',
    detail: '1 fact disagrees between the form, the voice, and the photos',
    status: 'paused',
    cost: '$0.14',
    time: 'waiting for you',
  },
  {
    name: 'Writing the listing',
    detail: 'Portal text, social caption, and buyer questions',
    status: 'waiting',
    cost: '',
    time: '',
  },
  {
    name: 'Checking every claim',
    detail: 'Each sentence against its facts',
    status: 'waiting',
    cost: '',
    time: '',
  },
  {
    name: 'Building the pack',
    detail: 'HTML pack, portal fields, and images',
    status: 'waiting',
    cost: '',
    time: '',
  },
];

const BADGE: Record<StepStatus, { className: string; label: string }> = {
  done: { className: 'badge-success', label: 'Done' },
  running: { className: 'badge-info', label: 'Running' },
  paused: { className: 'badge-secondary', label: 'Needs your review' },
  waiting: { className: 'badge-outline', label: 'Waiting' },
};

function StepBadge({ status }: { status: StepStatus }) {
  const { className, label } = BADGE[status];
  return (
    <span className={`badge ${className} gap-1`}>
      {status === 'done' && <CheckIcon className="size-3.5" />}
      {status === 'running' && <span className="loading loading-spinner loading-xs" aria-hidden />}
      {status === 'paused' && <span aria-hidden>!</span>}
      {label}
    </span>
  );
}

function Steps() {
  return (
    <section aria-labelledby="steps-title" className="flex flex-col gap-3">
      <h3 id="steps-title" className="text-xl font-semibold">
        What the run is doing
      </h3>
      <ol className="flex flex-col gap-2">
        {STEPS.map((step, index) => (
          <li
            key={step.name}
            aria-current={step.status === 'paused' ? 'step' : undefined}
            className={`flex flex-col gap-1 rounded-box border p-3 ${
              step.status === 'paused'
                ? 'border-secondary bg-base-100'
                : 'border-base-300 bg-base-100'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 font-semibold">
                <span className="badge badge-ghost font-mono">{index + 1}</span>
                {step.name}
              </span>
              <StepBadge status={step.status} />
            </div>
            <p className="text-sm text-base-content/70">{step.detail}</p>
            {step.cost !== '' && (
              <p className="text-sm text-base-content/70">
                Cost {step.cost} · {step.time}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Cost() {
  return (
    <section
      aria-labelledby="cost-title"
      className="flex flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="cost-title" className="text-lg font-semibold">
          Cost so far
        </h3>
        <span className="badge badge-outline">Visible in development only</span>
      </div>
      <p className="text-3xl font-bold">
        $0.84 <span className="text-base font-normal text-base-content/70">of the $2.00 cap</span>
      </p>
      <progress
        className="progress progress-primary w-full"
        value={42}
        max={100}
        aria-label="Cost against the cap"
      />
      <p className="text-sm text-base-content/70">
        42% of the cap. The run stops by itself at the cap; nothing is charged past it.
      </p>
    </section>
  );
}

function Paused() {
  return (
    <section
      aria-labelledby="pause-title"
      className="flex flex-col gap-3 rounded-box border-2 border-secondary bg-base-100 p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-secondary gap-1">
          <span aria-hidden>!</span>Paused
        </span>
        <h3 id="pause-title" className="text-lg font-semibold">
          Waiting for you: 1 fact disagrees
        </h3>
      </div>
      <p className="text-sm text-base-content/70">
        The run stays here for as long as you need. You can leave this page; it continues after your
        last decision.
      </p>
      <div>
        <Link href="/showcase/samples/review" className="btn btn-primary min-h-11">
          Resolve conflicts
        </Link>
      </div>
    </section>
  );
}

function RunPage() {
  return (
    <div className="bg-base-200 px-4 py-8">
      <div className="card mx-auto max-w-5xl border border-base-300 bg-base-100">
        <div className="card-body gap-6">
          <div className="flex flex-col gap-2">
            <h2 className="card-title text-3xl">Voorbeeldgracht 14: run</h2>
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge badge-secondary gap-1">
                <span aria-hidden>!</span>Awaiting your review
              </span>
              <span className="text-sm text-base-content/70">Started 6 minutes ago</span>
            </div>
          </div>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="flex flex-col gap-4 lg:order-last">
              <Paused />
              <Cost />
            </div>
            <Steps />
          </div>
        </div>
      </div>
    </div>
  );
}

export function SampleRunPage() {
  return (
    <SampleShell title="Sample: run monitor">
      <Sample
        id="H-RUN-1"
        title="Run monitor: steps, paused for review (cost figures, here and per step, are visible in development only)"
      >
        <RunPage />
      </Sample>
    </SampleShell>
  );
}
