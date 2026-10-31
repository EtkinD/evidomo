import { useTranslations } from 'use-intl';
import { BOUNDARY_IDS } from '../../lib/sample-run';

/**
 * What Evidomo will not do and what it removes, as a plain numbered list in a narrow column, like
 * the closing clauses of a file. It doubles as the site's short data-handling statement.
 */
export function Boundaries() {
  const t = useTranslations('method.boundaries');
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="text-base-content/70">{t('lead')}</p>
      <ol className="flex flex-col">
        {BOUNDARY_IDS.map((id, index) => (
          <li key={id} className="flex gap-3 border-t border-base-content/25 py-3 first:border-t-0">
            <span aria-hidden className="font-mono text-sm text-primary">
              {index + 1}.
            </span>
            <span>{t(`items.${id}`)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
