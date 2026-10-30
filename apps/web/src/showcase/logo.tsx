import type { ReactNode } from 'react';

/**
 * H-LOGO-1, the approved mark: a clay roof over a sage window with a check mark (the evidence
 * promise). It uses theme tokens only (`stroke-*`, `fill-*`), so it follows `evidomo-light` and
 * `evidomo-dark`. The final SVG assets, favicon, and app icons are P4B-03.
 */
function Svg({ className, children }: { className: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 64 64" className={className} fill="none" aria-hidden focusable="false">
      {children}
    </svg>
  );
}

export function LogoMark({ className = 'size-10' }: { className?: string }) {
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

/** The mark and the "Evidomo" wordmark in the display face (Newsreader). */
export function Lockup({
  markClass = 'size-9',
  textClass = 'text-2xl',
}: {
  markClass?: string;
  textClass?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark className={markClass} />
      <span className={`font-display font-bold tracking-tight text-base-content ${textClass}`}>
        Evidomo
      </span>
    </span>
  );
}
