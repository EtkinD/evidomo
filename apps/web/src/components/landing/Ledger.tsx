import { useTranslations } from 'use-intl';
import type { SourceNoteId } from '../../lib/landing-sources';
import { LEDGER_PARAMS, LEDGER_ROWS, type LedgerRowId } from '../../lib/sample-run';
import { Stamp } from '../Stamp';
import { SamplePhoto } from './SamplePhoto';
import { Section } from './Section';
import { SourceNotes, Sourced } from './sources';

const NOTE_OF: Record<LedgerRowId, SourceNoteId> = {
  intake: 'intake',
  fact_extraction: 'facts',
  vision_inventory: 'photos',
  reconciliation: 'conflicts',
  gate1: 'gate1',
  creative: 'creative',
  qa_cards: 'qa',
  staging: 'staging',
  integrity: 'integrity',
  verification: 'verification',
  gate2: 'gate2',
  export: 'export',
};

function RowPhotos({ kind }: { kind: 'bedroom' | 'staging' }) {
  const t = useTranslations('landing.ledger');
  if (kind === 'bedroom') {
    return (
      <figure className="flex w-full max-w-xs -rotate-1 flex-col gap-2 bg-base-100 p-1.5 pb-3 shadow-sheet">
        <SamplePhoto id="bedroom" sizes="(min-width: 640px) 320px, 100vw" />
        <figcaption className="px-1 text-sm text-base-content/70 italic">
          {t('bedroomCaption')}
        </figcaption>
      </figure>
    );
  }
  return (
    <figure className="flex flex-col gap-2">
      <div className="grid max-w-xl grid-cols-2 gap-3">
        {(['stagingBefore', 'stagingAfter'] as const).map((id, index) => (
          <div
            key={id}
            className={`flex flex-col gap-2 bg-base-100 p-1.5 pb-2 shadow-sheet ${index === 0 ? '-rotate-1' : 'rotate-1'}`}
          >
            <SamplePhoto id={id} sizes="(min-width: 640px) 240px, 45vw" />
            <p className="flex flex-wrap items-center gap-2 px-1 text-sm">
              {index === 0 ? (
                t('stagingBefore')
              ) : (
                <>
                  {t('stagingAfter')}
                  <StagedStamp />
                </>
              )}
            </p>
          </div>
        ))}
      </div>
      <figcaption className="max-w-xl text-sm text-base-content/70 italic">
        {t('stagingCaption')}
      </figcaption>
    </figure>
  );
}

function StagedStamp() {
  // The label the pack carries on every staged image (the model's disclosure label, in English).
  return <Stamp tone="staged">Virtually staged</Stamp>;
}

function RowText({ id }: { id: LedgerRowId }) {
  const t = useTranslations('landing.ledger.rows');
  return t(id, id in LEDGER_PARAMS ? LEDGER_PARAMS[id as keyof typeof LEDGER_PARAMS] : undefined);
}

/** Section 2: the sample run's steps as ruled ledger lines, the two stops set heavier. */
export function Ledger() {
  const t = useTranslations('landing.ledger');
  const tSteps = useTranslations('steps');
  return (
    <Section
      n={2}
      id="landing-ledger"
      title={t('title')}
      intro={<p className="text-base-content/70">{t('intro')}</p>}
    >
      <ol className="flex flex-col">
        {LEDGER_ROWS.map((row, index) => {
          const gate = row.kind === 'gate';
          const step = LEDGER_ROWS.slice(0, index + 1).filter((r) => r.kind === 'step').length;
          const photo = 'photo' in row ? row.photo : undefined;
          return (
            <li
              key={row.id}
              className="grid gap-x-8 gap-y-3 border-t border-base-content/25 py-5 first:border-t-0 lg:grid-cols-9"
            >
              <div
                className={`flex flex-col gap-3 lg:col-span-6 ${gate ? 'border-t-4 border-base-content bg-base-100 p-4 shadow-sheet' : ''}`}
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {!gate && (
                    <span aria-hidden className="font-mono text-sm text-primary">
                      {String(step).padStart(2, '0')}
                    </span>
                  )}
                  <h3 className="text-xl leading-tight font-medium">
                    {row.id === 'gate1' || row.id === 'gate2'
                      ? t(`gateTitles.${row.id}`)
                      : tSteps(`${row.id}.label`)}
                  </h3>
                  <span
                    aria-hidden
                    className="hidden min-w-8 flex-1 self-end border-b border-dotted border-base-content/40 sm:block"
                  />
                  <span className="text-sm text-base-content/70">
                    {t('decidedBy')}{' '}
                    <span className="font-semibold text-base-content">
                      {gate ? t('you') : t('evidomo')}
                    </span>
                  </span>
                </div>
                {gate && <Stamp tone="decision">{t('stop')}</Stamp>}
                <p className="max-w-prose">
                  <Sourced id={NOTE_OF[row.id]}>
                    <RowText id={row.id} />
                  </Sourced>
                </p>
                {row.id === 'gate1' && (
                  <p className="text-sm text-base-content/70 italic">{t('scripted')}</p>
                )}
                {photo !== undefined && <RowPhotos kind={photo} />}
              </div>
              <div className="lg:col-span-3">
                <SourceNotes ids={[NOTE_OF[row.id]]} />
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
