export type LogoSize = 'sm' | 'md' | 'lg';
export type LogoVariant = 'mark' | 'wordmark' | 'lockup';

// Mark edge and wordmark size per step; the wordmark is 1.5x smaller than the mark, as in the
// static lockup files (apps/web/public/brand).
const MARK_CLASS: Record<LogoSize, string> = { sm: 'size-8', md: 'size-9', lg: 'size-12' };
const TEXT_CLASS: Record<LogoSize, string> = { sm: 'text-xl', md: 'text-2xl', lg: 'text-3xl' };

/**
 * H-LOGO-1: a clay roof over a sage window with a check mark (the evidence promise). Geometry
 * and colours match `public/brand/evidomo-mark.svg`; here the colours are theme tokens, so the
 * mark follows `evidomo-light` and `evidomo-dark`.
 */
function Mark({ className, label }: { className: string; label: string | null }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      fill="none"
      focusable="false"
      {...(label === null ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
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
    </svg>
  );
}

/**
 * The Evidomo logo. The wordmark is live text in the display face (Newsreader), so it is the
 * accessible name; in the lockup the mark beside it is decorative. A mark on its own carries the
 * name itself. The static files use outlined text because they cannot load fonts.
 */
export function Logo({
  variant = 'lockup',
  size = 'md',
  className = '',
}: {
  variant?: LogoVariant;
  size?: LogoSize;
  className?: string;
}) {
  if (variant === 'mark') {
    return <Mark className={`${MARK_CLASS[size]} ${className}`.trim()} label="Evidomo" />;
  }

  const wordmark = (
    <span className={`font-display font-bold tracking-tight text-base-content ${TEXT_CLASS[size]}`}>
      Evidomo
    </span>
  );
  if (variant === 'wordmark') {
    return <span className={className || undefined}>{wordmark}</span>;
  }

  return (
    <span className={`inline-flex items-center gap-2 ${className}`.trim()}>
      <Mark className={MARK_CLASS[size]} label={null} />
      {wordmark}
    </span>
  );
}
