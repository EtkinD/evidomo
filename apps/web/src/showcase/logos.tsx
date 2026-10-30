import type { ReactNode } from 'react';
import type { DirectionId } from './palettes';

/**
 * Hand-drawn SVG logo candidates. Marks use `currentColor` for the main shape and the theme's
 * `accent` for the one highlight, so they follow whichever direction theme wraps them.
 */
function Svg({ className, children }: { className: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 64 64" className={className} fill="none" aria-hidden focusable="false">
      {children}
    </svg>
  );
}

interface MarkProps {
  className?: string;
}

/** A-SVG-1: a house outline holding a verification tick. */
function LedgerHouse({ className = 'size-10' }: MarkProps) {
  return (
    <Svg className={className}>
      <path
        d="M9 31 32 10l23 21v22a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3Z"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinejoin="round"
      />
      <path
        d="m22 38 7 7 14-15"
        className="stroke-accent"
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** A-SVG-2: an "E" built from ledger lines, one line marked. */
function LedgerLines({ className = 'size-10' }: MarkProps) {
  return (
    <Svg className={className}>
      <rect x="10" y="10" width="9" height="44" rx="2" fill="currentColor" />
      <rect x="10" y="10" width="44" height="9" rx="2" fill="currentColor" />
      <rect x="10" y="45" width="44" height="9" rx="2" fill="currentColor" />
      <rect x="10" y="27.5" width="28" height="9" rx="2" className="fill-accent" />
    </Svg>
  );
}

/** B-SVG-1: an arched doorway with a warm light. */
function HearthArch({ className = 'size-10' }: MarkProps) {
  return (
    <Svg className={className}>
      <path d="M10 56V30a22 22 0 0 1 44 0v26Z" fill="currentColor" />
      <path d="M24 56V38a8 8 0 0 1 16 0v18Z" className="fill-accent" />
    </Svg>
  );
}

/** B-SVG-2: a pitched roof over a window with a tick. */
function HearthRoof({ className = 'size-10' }: MarkProps) {
  return (
    <Svg className={className}>
      <path
        d="M6 30 32 9l26 21"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="15" y="29" width="34" height="27" rx="5" fill="currentColor" />
      <path
        d="m24 42 6 6 11-12"
        className="stroke-accent"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** C-SVG-1: viewfinder corners around a highlighted region. */
function SignalFrame({ className = 'size-10' }: MarkProps) {
  return (
    <Svg className={className}>
      <path
        d="M8 22V10a2 2 0 0 1 2-2h12M42 8h12a2 2 0 0 1 2 2v12M56 42v12a2 2 0 0 1-2 2H42M22 56H10a2 2 0 0 1-2-2V42"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="square"
      />
      <rect x="20" y="20" width="24" height="24" className="fill-accent" />
    </Svg>
  );
}

/** C-SVG-2: a solid block "E" with a signal bar. */
function SignalBlock({ className = 'size-10' }: MarkProps) {
  return (
    <Svg className={className}>
      <path d="M8 8h48v10H20v8h26v10H20v8h36v10H8Z" fill="currentColor" />
      <rect x="26" y="22" width="30" height="6" className="fill-accent" />
    </Svg>
  );
}

export interface LogoCandidate {
  readonly id: string;
  readonly direction: DirectionId;
  readonly title: string;
  readonly Mark: (props: MarkProps) => ReactNode;
  /** Tailwind classes for the wordmark in the direction's display font. */
  readonly wordmarkClass: string;
}

export const LOGO_CANDIDATES: readonly LogoCandidate[] = [
  {
    id: 'A-SVG-1',
    direction: 'A',
    title: 'House with tick, tight wordmark',
    Mark: LedgerHouse,
    wordmarkClass: 'sc-display font-semibold tracking-tight',
  },
  {
    id: 'A-SVG-2',
    direction: 'A',
    title: 'Ledger-line E, spaced wordmark',
    Mark: LedgerLines,
    wordmarkClass: 'sc-display font-medium tracking-wide',
  },
  {
    id: 'B-SVG-1',
    direction: 'B',
    title: 'Arched doorway, serif wordmark',
    Mark: HearthArch,
    wordmarkClass: 'sc-display font-semibold',
  },
  {
    id: 'B-SVG-2',
    direction: 'B',
    title: 'Roof and window tick, bold serif wordmark',
    Mark: HearthRoof,
    wordmarkClass: 'sc-display font-bold tracking-tight',
  },
  {
    id: 'C-SVG-1',
    direction: 'C',
    title: 'Viewfinder frame, bold wordmark',
    Mark: SignalFrame,
    wordmarkClass: 'sc-display font-bold tracking-tight',
  },
  {
    id: 'C-SVG-2',
    direction: 'C',
    title: 'Block E with signal bar, uppercase wordmark',
    Mark: SignalBlock,
    wordmarkClass: 'sc-display font-bold uppercase tracking-widest',
  },
];

export function logoCandidatesFor(direction: DirectionId): LogoCandidate[] {
  return LOGO_CANDIDATES.filter((candidate) => candidate.direction === direction);
}

/** Mark and wordmark side by side (the horizontal lockup). */
export function Lockup({
  candidate,
  markClass = 'size-10',
  textClass = 'text-2xl',
}: {
  candidate: LogoCandidate;
  markClass?: string;
  textClass?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-primary">
      <candidate.Mark className={markClass} />
      <span className={`${candidate.wordmarkClass} ${textClass} text-base-content`}>Evidomo</span>
    </span>
  );
}
