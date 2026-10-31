import { useFormatter, useTranslations } from 'use-intl';
import { EVAL_ROWS, EVAL_RUN } from '../../lib/sample-run';

const LIMITS = ['blatant', 'oneApartment', 'freeform', 'audio'] as const;

/** The eval table, dated, and its limits. No big-number row. */
export function Numbers() {
  const t = useTranslations('method.numbers');
  const format = useFormatter();
  const date = format.dateTime(new Date(EVAL_RUN.date), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return (
    <div className="flex flex-col gap-8">
      <p className="max-w-prose">{t('intro', { date, sets: EVAL_RUN.sets })}</p>
      <table className="table max-w-2xl">
        <caption className="sr-only">{t('caption')}</caption>
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
      <div className="flex flex-col gap-4">
        <h3 className="text-xl font-medium">{t('limitsTitle')}</h3>
        <ul className="flex max-w-2xl flex-col gap-3">
          {LIMITS.map((id) => (
            <li
              key={id}
              className="border-l-4 border-secondary bg-base-100 p-3 text-sm shadow-sheet"
            >
              {t(`limits.${id}`)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
