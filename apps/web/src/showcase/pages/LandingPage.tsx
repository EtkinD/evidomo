import { directionById } from '../directions';
import { assetUrl, itemsFor, useAssetManifest } from '../assets';
import { Lockup, logoCandidatesFor } from '../logos';
import { useMode } from '../mode';
import type { DirectionId } from '../palettes';
import { Candidate, DirectionScope, EachDirection, NotGenerated, ShowcaseShell } from '../ui';

const STEPS = [
  {
    n: 1,
    title: 'Capture',
    text: 'Walk through, talk, and photograph. Works on a phone at the property.',
  },
  {
    n: 2,
    title: 'Verify',
    text: 'Review each claim next to its evidence: a form value, a spoken sentence, a marked photo.',
  },
  {
    n: 3,
    title: 'Pack',
    text: 'Download a listing pack where every statement links back to its source.',
  },
] as const;

function HeroImage({ direction }: { direction: DirectionId }) {
  const query = useAssetManifest();
  const manifest = query.data?.status === 'ready' ? query.data.manifest : undefined;
  const hero = itemsFor(manifest, direction, ['hero'])[0];
  if (hero === undefined) return <NotGenerated what="Muse hero" className="min-h-48" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- local exploration asset
    <img
      src={assetUrl(hero)}
      alt={`${hero.id}: ${hero.prompt}`}
      className="h-full max-h-96 w-full rounded-box object-cover"
    />
  );
}

function LandingDraft({ direction }: { direction: DirectionId }) {
  const { mode } = useMode();
  const info = directionById(direction);
  const logo = logoCandidatesFor(direction)[0];
  return (
    <Candidate id={`${direction}-LAND-1`} title={`${info.name} landing draft`}>
      <DirectionScope
        direction={direction}
        mode={mode}
        className="flex flex-col gap-8 rounded-box p-4"
      >
        <header className="flex flex-wrap items-center justify-between gap-2">
          {logo && <Lockup candidate={logo} />}
          <button type="button" className="btn btn-ghost min-h-11">
            Log in
          </button>
        </header>
        <section aria-label="Hero" className="grid items-center gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-4">
            <h3 className="sc-display text-4xl font-bold leading-tight">
              Every claim in your listing, linked to its evidence.
            </h3>
            <p className="text-lg text-base-content/70">
              Capture a property in minutes. Evidomo builds the listing and shows where every
              statement came from.
            </p>
            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn btn-primary min-h-11">
                Create account
              </button>
              <button type="button" className="btn btn-outline min-h-11">
                See a demo
              </button>
            </div>
          </div>
          <HeroImage direction={direction} />
        </section>
        <section aria-label="How it works" className="flex flex-col gap-4">
          <h3 className="sc-display text-2xl font-semibold">How it works</h3>
          <ol className="grid gap-3 md:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.n} className="card border border-base-300 bg-base-200">
                <div className="card-body gap-2 p-4">
                  <span className="badge badge-primary sc-mono">{step.n}</span>
                  <h4 className="sc-display text-lg font-semibold">{step.title}</h4>
                  <p className="text-sm text-base-content/70">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </DirectionScope>
    </Candidate>
  );
}

export function LandingPage() {
  return (
    <ShowcaseShell title="Landing">
      <EachDirection render={(direction) => <LandingDraft direction={direction} />} />
    </ShowcaseShell>
  );
}
