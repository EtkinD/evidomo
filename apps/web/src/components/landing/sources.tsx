import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import {
  noteNumber,
  SOURCE_NOTES,
  sourceHref,
  type SourceNoteId,
  type SourceRef,
} from '../../lib/landing-sources';
import { EVAL_RUN } from '../../lib/sample-run';
import { setShowSources, useShowSources } from '../../lib/sources';

const LINK = 'inline-flex min-h-11 items-center underline underline-offset-4 break-all';

/**
 * The "Show sources" switch: a real toggle button (`aria-pressed`, keyboard operable, 44 px). The
 * state is also written as On/Off, so it is never shown by the knob's position or colour alone.
 */
export function SourcesSwitch({ className = '' }: { className?: string }) {
  const t = useTranslations('landing.sources');
  const on = useShowSources();
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => setShowSources(!on)}
      className={`btn btn-outline min-h-11 gap-2 px-3 ${className}`}
    >
      <span
        aria-hidden
        className={`relative inline-block h-5 w-9 shrink-0 rounded-full border-2 ${on ? 'border-primary bg-primary' : 'border-base-content/60 bg-base-100'}`}
      >
        <span
          className={`absolute top-0.5 size-3 rounded-full transition-[left] motion-reduce:transition-none ${on ? 'left-4.5 bg-primary-content' : 'left-0.5 bg-base-content/70'}`}
        />
      </span>
      {t('switch')}
      <span aria-hidden className="text-xs font-semibold tracking-wider uppercase">
        {on ? t('on') : t('off')}
      </span>
    </button>
  );
}

function RefLine({ refItem }: { refItem: SourceRef }) {
  const t = useTranslations('landing.sources');
  const format = useFormatter();
  const href = sourceHref(refItem);
  const external = href.startsWith('http');
  let label: string;
  switch (refItem.kind) {
    case 'sample':
      label = `${t(`screens.${refItem.screen}`)}${refItem.detail === undefined ? '' : `, ${refItem.detail}`}`;
      break;
    case 'sampleFile':
    case 'code':
      label = refItem.path;
      break;
    case 'eval':
      label = t('evalRef', {
        date: format.dateTime(new Date(EVAL_RUN.date), {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        }),
      });
      break;
    case 'rule':
      label = t('ruleRef', { section: refItem.section });
      break;
  }
  const kind = refItem.kind === 'sampleFile' ? 'sample' : refItem.kind;
  return (
    <li className="flex flex-col">
      <span className="text-xs font-semibold tracking-wider text-base-content/70 uppercase">
        {t(`kinds.${kind}`)}
      </span>
      {external ? (
        <a href={href} rel="noreferrer" className={LINK}>
          {label}
        </a>
      ) : (
        <Link href={href} className={LINK}>
          {label}
        </Link>
      )}
    </li>
  );
}

/** Margin notes for the claims of one block; nothing unless "Show sources" is on. */
export function SourceNotes({ ids }: { ids: readonly SourceNoteId[] }) {
  const t = useTranslations('landing.sources');
  const on = useShowSources();
  if (!on) return null;
  return (
    <div className="flex flex-col gap-2 text-sm">
      {ids.map((id, index) => (
        <div
          key={id}
          data-source-note={id}
          id={`source-note-${id}`}
          className="source-in flex gap-2 bg-base-100 p-2 text-base-content shadow-sheet"
          style={{ '--i': index } as CSSProperties}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-content">
            <span aria-hidden>{noteNumber(id)}</span>
            <span className="sr-only">{t('number', { n: noteNumber(id) })}</span>
          </span>
          <ul className="flex min-w-0 flex-col gap-1">
            {SOURCE_NOTES[id].map((refItem, i) => (
              <RefLine key={i} refItem={refItem} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** A claim in running text: highlighted and numbered while "Show sources" is on. */
export function Sourced({ id, children }: { id: SourceNoteId; children: ReactNode }) {
  const t = useTranslations('landing.sources');
  const on = useShowSources();
  if (!on) return <>{children}</>;
  return (
    <>
      <mark
        data-claim-source={id}
        aria-describedby={`source-note-${id}`}
        className="claim-on bg-transparent"
      >
        {children}
      </mark>
      {/* The number is read as "source 3", and the claim points at its note. */}
      <sup className="ml-0.5 text-[0.7em] font-semibold">
        <span aria-hidden>{noteNumber(id)}</span>
        <span className="sr-only">{t('number', { n: noteNumber(id) })}</span>
      </sup>
    </>
  );
}
