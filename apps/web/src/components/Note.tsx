import type { ReactNode } from 'react';

export type NoteTone = 'info' | 'success' | 'warning' | 'error';

// The rule carries the status colour; the icon and the text carry the meaning, so colour is never
// the only cue. Icons are base-content: `warning` is a background-only token as text.
const TONES = {
  info: { rule: 'border-info', icon: 'i' },
  success: { rule: 'border-success', icon: '✓' },
  warning: { rule: 'border-warning', icon: '!' },
  error: { rule: 'border-error', icon: '×' },
} as const satisfies Record<NoteTone, { rule: string; icon: string }>;

/**
 * A dossier note: a margin note on the desk, with a left rule in the status colour, a small icon,
 * and text. It replaces daisyUI's coloured alert boxes. `split` puts a short action beside the
 * text from `sm` up (a button after the message); otherwise the content stacks.
 */
export function Note({
  tone,
  role,
  label,
  split = false,
  className = '',
  children,
}: {
  tone: NoteTone;
  role: 'alert' | 'status' | 'note' | 'region';
  /** The accessible name of a `region` note. */
  label?: string;
  split?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { rule, icon } = TONES[tone];
  return (
    <div
      role={role}
      aria-label={label}
      data-tone={tone}
      className={`flex items-start gap-3 border-l-4 bg-base-200 p-4 text-base-content ${rule} ${className}`}
    >
      {/* The icon is generated content: it is decoration, so it stays out of the text. */}
      <span
        aria-hidden
        data-icon={icon}
        className="flex size-6 shrink-0 items-center justify-center rounded-full border border-base-content/50 text-sm leading-none font-semibold before:content-[attr(data-icon)]"
      />
      <div
        className={`flex min-w-0 flex-1 flex-col gap-2 ${split ? 'sm:flex-row sm:items-center sm:justify-between sm:gap-4' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}
