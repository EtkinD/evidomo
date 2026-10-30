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

/** B2-SVG-1: the arch softened: rounded base corners, a wider rounded door. */
function ClayArch({ className = 'size-10' }: MarkProps) {
  return (
    <Svg className={className}>
      <path d="M9 50V30a23 23 0 0 1 46 0v20a6 6 0 0 1-6 6H15a6 6 0 0 1-6-6Z" fill="currentColor" />
      <path d="M23 56V39a9 9 0 0 1 18 0v17Z" className="fill-accent" />
    </Svg>
  );
}

/** B2-SVG-2: the roof and window with thinner, fully rounded strokes and a pillowy window. */
function ClayRoof({ className = 'size-10' }: MarkProps) {
  return (
    <Svg className={className}>
      <path
        d="M7 30 32 10l25 20"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="14" y="29" width="36" height="27" rx="10" fill="currentColor" />
      <path
        d="m24 42 6 6 11-12"
        className="stroke-accent"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** B3-SVG-1: the arch as a heavy geometric block: true semicircle, flat base slab. */
function CanalArch({ className = 'size-10' }: MarkProps) {
  return (
    <Svg className={className}>
      <path d="M8 52V32a24 24 0 0 1 48 0v20Z" fill="currentColor" />
      <rect x="4" y="52" width="56" height="8" fill="currentColor" />
      <path d="M22 52V40a10 10 0 0 1 20 0v12Z" className="fill-accent" />
    </Svg>
  );
}

/** B3-SVG-2: a mitred, heavy roof over a squared window with a square-capped tick. */
function CanalRoof({ className = 'size-10' }: MarkProps) {
  return (
    <Svg className={className}>
      <path
        d="M4 31 32 8l28 23"
        stroke="currentColor"
        strokeWidth="8"
        strokeLinecap="butt"
        strokeLinejoin="miter"
      />
      <rect x="14" y="31" width="36" height="26" rx="2" fill="currentColor" />
      <path
        d="m23 44 7 7 12-13"
        className="stroke-accent"
        strokeWidth="6"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
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
    id: 'B2-SVG-1',
    direction: 'B2',
    title: 'Soft arched doorway, soft serif wordmark',
    Mark: ClayArch,
    wordmarkClass: 'sc-display font-semibold',
  },
  {
    id: 'B2-SVG-2',
    direction: 'B2',
    title: 'Rounded roof and window tick, soft serif wordmark',
    Mark: ClayRoof,
    wordmarkClass: 'sc-display font-bold tracking-tight',
  },
  {
    id: 'B3-SVG-1',
    direction: 'B3',
    title: 'Geometric arch on a base slab, editorial wordmark',
    Mark: CanalArch,
    wordmarkClass: 'sc-display font-semibold tracking-tight',
  },
  {
    id: 'B3-SVG-2',
    direction: 'B3',
    title: 'Mitred roof and square tick, bold editorial wordmark',
    Mark: CanalRoof,
    wordmarkClass: 'sc-display font-bold tracking-tight',
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
