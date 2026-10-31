import { useFormatter, useTranslations } from 'use-intl';
import { EVAL_ROWS, EVAL_RUN } from '../../lib/sample-run';
import { Section } from './Section';
import { SourceNotes, Sourced } from './sources';
import type { SourceNoteId } from '../../lib/landing-sources';

const LIMITS = [
  { id: 'blatant', note: 'limitBlatant' },
  { id: 'oneApartment', note: 'limitOneApartment' },
  { id: 'freeform', note: 'limitFreeform' },
  { id: 'audio', note: 'limitAudio' },
] as const satisfies readonly { id: string; note: SourceNoteId }[];

/** Section 3: the eval table, dated, with its limits as margin notes. No big-number row. */
export function Numbers() {
  const t = useTranslations('landing.numbers');
  const format = useFormatter();
  const date = format.dateTime(new Date(EVAL_RUN.date), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return (
    <Section n={3} id="landing-numbers" title={t('title')}>
      <div className="grid gap-x-8 gap-y-10 lg:grid-cols-9">
        <div className="flex flex-col gap-4 lg:col-span-5">
          <p className="max-w-prose">
            <Sourced id="evalTable">{t('intro', { date, sets: EVAL_RUN.sets })}</Sourced>
          </p>
          <table className="table">
            <caption className="sr-only">{t('title')}</caption>
            <thead>
              <tr className="border-base-content/40">
                <th scope="col" className="pl-0 text-base-content">
                  {t('measure')}
                </th>
                <th scope="col" className="text-right text-base-content">
                  {t('result')}
                </th>
              </tr>
            </thead>
            <tbody>
              {EVAL_ROWS.map((row) => (
                <tr key={row.id} className="border-base-content/25">
                  <th scope="row" className="pl-0 font-normal whitespace-normal">
                    {t(`rows.${row.id}`)}
                  </th>
                  <td className="text-right font-mono whitespace-nowrap">{row.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <SourceNotes ids={['evalTable']} />
        </div>
        <div className="flex flex-col gap-4 lg:col-span-4">
          <h3 className="text-xl font-medium">{t('limitsTitle')}</h3>
          <ul className="flex flex-col gap-4">
            {LIMITS.map((limit) => (
              <li key={limit.id} className="flex flex-col gap-2">
                <p className="border-l-4 border-secondary bg-base-100 p-3 text-sm shadow-sheet">
                  <Sourced id={limit.note}>{t(`limits.${limit.id}`)}</Sourced>
                </p>
                <SourceNotes ids={[limit.note]} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}
