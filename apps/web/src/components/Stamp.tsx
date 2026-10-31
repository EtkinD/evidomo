import type { ReactNode } from 'react';

export type StampTone = 'verified' | 'decision' | 'kept' | 'removed' | 'staged' | 'sample';

// An ink stamp: outlined, small, letter-spaced capitals. The mark and the words say the state;
// the colour only agrees with them. Tokens that are text-safe only (never `warning` or `accent`).
const TONES = {
  verified: { ink: 'border-success text-success', mark: '✓' },
  decision: { ink: 'border-secondary text-secondary', mark: '!' },
  kept: { ink: 'border-success text-success', mark: '✓' },
  removed: { ink: 'border-error text-error', mark: '×' },
  staged: { ink: 'border-secondary text-secondary', mark: '' },
  sample: { ink: 'border-base-content/60 text-base-content/70', mark: '' },
} as const satisfies Record<StampTone, { ink: string; mark: string }>;

/**
 * A state of the evidence as a stamp (Verified, Needs your decision, Kept, Removed, Virtually
 * staged, Sample file). Run status badges stay badges: in the step ledger a stamp would crowd.
 */
export function Stamp({
  tone,
  as: Tag = 'span',
  className = '',
  children,
}: {
  tone: StampTone;
  /** `figcaption` when the stamp is the caption of a figure (the staged image's label). */
  as?: 'span' | 'figcaption';
  className?: string;
  children: ReactNode;
}) {
  const { ink, mark } = TONES[tone];
  return (
    // The mark is generated content, so the element's text is just the words.
    <Tag
      data-stamp={tone}
      data-mark={mark}
      className={`inline-flex w-fit max-w-full items-center gap-1 border-2 px-2 py-0.5 text-xs leading-tight font-semibold tracking-[0.12em] break-words uppercase ${mark === '' ? '' : 'before:content-[attr(data-mark)]'} ${ink} ${className}`}
    >
      {children}
    </Tag>
  );
}
