import { useSyncExternalStore, type ReactNode } from 'react';

/**
 * Logo candidates of the combination. Marks use theme tokens only (`fill-*`, `stroke-*`), so they
 * follow `combo-light` / `combo-dark`.
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

/** H-LOGO-1: B-SVG-2 (roof over a window with a tick) recoloured: clay roof, sage window. */
function RoofWindowMark({ className = 'size-10' }: MarkProps) {
  return (
    <Svg className={className}>
      <path
        d="M6 30 32 9l26 21"
        className="stroke-primary"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="15" y="29" width="34" height="27" rx="5" className="fill-secondary" />
      <path
        d="m24 42 6 6 11-12"
        className="stroke-secondary-content"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * H-LOGO-2: B3-LOGO-2's idea as a vector. A roof slope that bends into the ring of a lowercase e,
 * with its bar, in brass (accent) on a dark tile (neutral). The Muse tile is teal; the combination
 * palette has no teal, so the tile takes the deepest warm neutral.
 */
function RoofEMark({ className = 'size-10' }: MarkProps) {
  return (
    <Svg className={className}>
      <rect x="3" y="3" width="58" height="58" rx="9" className="fill-neutral" />
      <path
        d="M13 34 26 25.5A14 14 0 1 1 24 47M27 37H48"
        className="stroke-accent"
        strokeWidth="5"
        strokeLinecap="butt"
        strokeLinejoin="miter"
      />
    </Svg>
  );
}

/**
 * H-LOGO-3: a second reading of the same idea: a gable chevron above a compact lowercase e, on a
 * sage tile (secondary) with the content colour as the mark, so the pair is contrast-safe by
 * construction in both modes.
 */
function GableEMark({ className = 'size-10' }: MarkProps) {
  return (
    <Svg className={className}>
      <rect x="3" y="3" width="58" height="58" rx="9" className="fill-secondary" />
      <path
        d="M13 28 32 13l19 15"
        className="stroke-secondary-content"
        strokeWidth="5"
        strokeLinecap="butt"
        strokeLinejoin="miter"
      />
      <path
        d="M22 42H42A10 10 0 1 0 38.5 49.6"
        className="stroke-secondary-content"
        strokeWidth="5"
        strokeLinecap="butt"
        strokeLinejoin="miter"
      />
    </Svg>
  );
}

export interface ComboLogo {
  readonly id: 'H-LOGO-1' | 'H-LOGO-2' | 'H-LOGO-3';
  readonly title: string;
  readonly Mark: (props: MarkProps) => ReactNode;
}

export const COMBO_LOGOS: readonly ComboLogo[] = [
  {
    id: 'H-LOGO-1',
    title: 'B-SVG-2 recoloured: roof and window tick',
    Mark: RoofWindowMark,
  },
  {
    id: 'H-LOGO-2',
    title: 'B3-LOGO-2 as vector: roof arc that closes into an e, brass on a dark tile',
    Mark: RoofEMark,
  },
  {
    id: 'H-LOGO-3',
    title: 'B3-LOGO-2 second reading: gable over a compact e, on a sage tile',
    Mark: GableEMark,
  },
];

const STORAGE_KEY = 'evidomo-showcase-combo-logo';
const listeners = new Set<() => void>();
let memoryChoice: ComboLogo['id'] | null = null;

function isLogoId(value: unknown): value is ComboLogo['id'] {
  return COMBO_LOGOS.some((logo) => logo.id === value);
}

function readChoice(): ComboLogo['id'] {
  if (memoryChoice !== null) return memoryChoice;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isLogoId(stored) ? stored : 'H-LOGO-2';
  } catch {
    return 'H-LOGO-2';
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function setComboLogo(id: ComboLogo['id']): void {
  memoryChoice = id;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Kept in memoryChoice above.
  }
  listeners.forEach((listener) => listener());
}

/** The logo every sample page shows (chosen with the switch under the page title). */
export function useComboLogo(): ComboLogo {
  const id = useSyncExternalStore(subscribe, readChoice, () => 'H-LOGO-2' as const);
  return COMBO_LOGOS.find((logo) => logo.id === id) ?? COMBO_LOGOS[0]!;
}

/** Mark and the "Evidomo" wordmark in the display face (Newsreader). */
export function ComboLockup({
  logo,
  markClass = 'size-9',
  textClass = 'text-2xl',
}: {
  logo: ComboLogo;
  markClass?: string;
  textClass?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <logo.Mark className={markClass} />
      <span className={`sc-display font-bold tracking-tight text-base-content ${textClass}`}>
        Evidomo
      </span>
    </span>
  );
}

/** The lockup of the logo chosen with the switch, for sample headers. */
export function ChosenLockup(props: { markClass?: string; textClass?: string }) {
  const logo = useComboLogo();
  return <ComboLockup logo={logo} {...props} />;
}

export function LogoSwitch() {
  const current = useComboLogo();
  return (
    <div role="group" aria-label="Logo in the samples" className="join flex-wrap">
      {COMBO_LOGOS.map((logo) => (
        <button
          key={logo.id}
          type="button"
          className={`btn join-item min-h-11 ${current.id === logo.id ? 'btn-neutral' : 'btn-outline'}`}
          aria-pressed={current.id === logo.id}
          onClick={() => setComboLogo(logo.id)}
        >
          <logo.Mark className="size-6" />
          {logo.id}
        </button>
      ))}
    </div>
  );
}
