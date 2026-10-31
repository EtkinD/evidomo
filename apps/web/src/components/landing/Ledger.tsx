import { useTranslations } from 'use-intl';
import { LEDGER_PARAMS, LEDGER_ROWS, type LedgerRowId } from '../../lib/sample-run';
import { Stamp } from '../Stamp';
import { SamplePhoto } from './SamplePhoto';

function RowPhotos({ kind }: { kind: 'bedroom' | 'staging' }) {
  const t = useTranslations('method.ledger');
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
                  {/* The label the pack carries on every staged image (the model's own, in English). */}
                  <Stamp tone="staged">Virtually staged</Stamp>
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

function RowText({ id }: { id: LedgerRowId }) {
  const t = useTranslations('method.ledger.rows');
  return t(id, id in LEDGER_PARAMS ? LEDGER_PARAMS[id as keyof typeof LEDGER_PARAMS] : undefined);
}

/**
 * The sample run's steps as ruled ledger lines, the two stops set heavier. Evidomo does every
 * step; the stops are where the agent decides.
 */
export function Ledger() {
  const t = useTranslations('method.ledger');
  const tSteps = useTranslations('steps');
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-base-content/70">{t('intro')}</p>
      <ol className="flex flex-col">
        {LEDGER_ROWS.map((row, index) => {
          const gate = row.kind === 'gate';
          const step = LEDGER_ROWS.slice(0, index + 1).filter((r) => r.kind === 'step').length;
          const photo = 'photo' in row ? row.photo : undefined;
          return (
            <li
              key={row.id}
              className={`flex max-w-2xl flex-col gap-3 border-t border-base-content/25 py-5 first:border-t-0 ${
                gate ? 'border-t-4 border-base-content bg-base-100 p-4 shadow-sheet' : ''
              }`}
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
              </div>
              {gate && <Stamp tone="decision">{t('stop')}</Stamp>}
              <p className="max-w-prose">
                <RowText id={row.id} />
              </p>
              {row.id === 'gate1' && (
                <p className="text-sm text-base-content/70 italic">{t('scripted')}</p>
              )}
              {photo !== undefined && <RowPhotos kind={photo} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
