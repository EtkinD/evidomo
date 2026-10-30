import type { ReactNode } from 'react';
import { oklchToHex } from '../contrast';
import { DIRECTIONS, directionById } from '../directions';
import { Lockup, logoCandidatesFor } from '../logos';
import { useMode } from '../mode';
import { PALETTES, type DirectionId } from '../palettes';
import { Candidate, DirectionScope, ShowcaseShell } from '../ui';
import { VoiceEvidence } from './ComponentsPage';
import { LandingHero } from './LandingPage';

const STRIP_ROLES = [
  { role: 'base-100', swatch: 'bg-base-100' },
  { role: 'base-200', swatch: 'bg-base-200' },
  { role: 'base-300', swatch: 'bg-base-300' },
  { role: 'primary', swatch: 'bg-primary' },
  { role: 'secondary', swatch: 'bg-secondary' },
  { role: 'accent', swatch: 'bg-accent' },
  { role: 'neutral', swatch: 'bg-neutral' },
  { role: 'error', swatch: 'bg-error' },
] as const;

function PaletteStrip({ direction }: { direction: DirectionId }) {
  const { mode } = useMode();
  const palette = PALETTES[direction][mode];
  return (
    <ul className="grid grid-cols-4 gap-2">
      {STRIP_ROLES.map(({ role, swatch }) => (
        <li key={role} className="flex flex-col gap-1">
          <span className={`h-12 rounded-field border border-base-300 ${swatch}`} aria-hidden />
          <span className="text-xs">{role}</span>
          <span className="sc-mono text-xs text-base-content/70">{oklchToHex(palette[role])}</span>
        </li>
      ))}
    </ul>
  );
}

function TypeSample() {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="sc-display text-3xl font-bold leading-tight">
        Lichte hoekwoning met tuin op het zuiden
      </h3>
      <p>
        Evidomo turns a walkthrough, photos and a form into a listing pack in which every statement
        points to where it came from. The agent reviews, the evidence stays one tap away.
      </p>
      <p className="sc-mono text-sm text-base-content/70">run_7f3a91 · EV-0042 · 118 m²</p>
    </div>
  );
}

function CompareButtons() {
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn btn-primary min-h-11">
        Primary
      </button>
      <button type="button" className="btn btn-outline min-h-11">
        Outline
      </button>
      <button type="button" className="btn btn-error min-h-11">
        Delete
      </button>
    </div>
  );
}

function LogoSample({ direction }: { direction: DirectionId }) {
  const logo = logoCandidatesFor(direction)[0];
  if (logo === undefined) return null;
  return <Lockup candidate={logo} markClass="size-12" textClass="text-3xl" />;
}

interface CompareRow {
  readonly slug: string;
  readonly title: string;
  /** Candidate ID suffix per mode; the colours row switches with the light/dark choice. */
  readonly suffix: (mode: 'light' | 'dark') => string;
  /** Extra classes for the direction scope (the hero needs the landing draft's rhythm). */
  readonly scopeClass?: string;
  readonly render: (direction: DirectionId) => ReactNode;
}

const ROWS: readonly CompareRow[] = [
  {
    slug: 'palette',
    title: 'Palette strip',
    suffix: (mode) => (mode === 'light' ? 'COL-1' : 'COL-2'),
    render: (direction) => <PaletteStrip direction={direction} />,
  },
  { slug: 'type', title: 'Type pairing', suffix: () => 'TYPE-1', render: () => <TypeSample /> },
  { slug: 'buttons', title: 'Buttons', suffix: () => 'BTN-1', render: () => <CompareButtons /> },
  {
    slug: 'evidence',
    title: 'Evidence card',
    suffix: () => 'EVD-1',
    render: () => <VoiceEvidence />,
  },
  {
    slug: 'logo',
    title: 'Logo',
    suffix: () => 'SVG-1',
    render: (direction) => <LogoSample direction={direction} />,
  },
  {
    slug: 'hero',
    title: 'Landing hero',
    suffix: () => 'LAND-1',
    scopeClass: 'gap-6',
    render: (direction) => <LandingHero direction={direction} stacked />,
  },
];

export function ComparePage() {
  const { mode } = useMode();
  return (
    <ShowcaseShell title="Compare B, B2 and B3">
      {ROWS.map((row) => (
        <section
          key={row.slug}
          aria-labelledby={`compare-${row.slug}`}
          className="mb-10 flex flex-col gap-3"
        >
          <h2 id={`compare-${row.slug}`} className="text-2xl font-bold">
            {row.title}
          </h2>
          <div className="grid items-start gap-4 lg:grid-cols-3">
            {DIRECTIONS.map(({ id }) => (
              <Candidate
                key={id}
                id={`${id}-${row.suffix(mode)}`}
                title={`${directionById(id).name}, ${row.title.toLowerCase()}`}
              >
                <DirectionScope
                  direction={id}
                  mode={mode}
                  className={`flex flex-col rounded-box p-3 ${row.scopeClass ?? 'gap-3'}`}
                >
                  {row.render(id)}
                </DirectionScope>
              </Candidate>
            ))}
          </div>
        </section>
      ))}
    </ShowcaseShell>
  );
}
