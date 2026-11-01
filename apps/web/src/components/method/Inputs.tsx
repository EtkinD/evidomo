import { useTranslations } from 'use-intl';

const INPUTS = ['photos', 'voice', 'form'] as const;

/**
 * What goes in and what comes out, in plain words: photos (never video), a voice walkthrough, and
 * a short form. The numbers are the service definition's (photos 10 to 30, voice up to 10 minutes).
 */
export function Inputs() {
  const t = useTranslations('method.inputs');
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <ul className="flex flex-col">
        {INPUTS.map((key) => (
          <li
            key={key}
            className="flex flex-col gap-1 border-t border-base-content/25 py-4 first:border-t-0 first:pt-0"
          >
            <h3 className="text-xl leading-tight font-medium">{t(`items.${key}.title`)}</h3>
            <p>{t(`items.${key}.text`)}</p>
          </li>
        ))}
      </ul>
      <p className="border-l-4 border-secondary bg-base-100 p-3 shadow-sheet">{t('noVideo')}</p>
      <div className="flex flex-col gap-1 border-t border-base-content/25 pt-4">
        <h3 className="text-xl leading-tight font-medium">{t('outputTitle')}</h3>
        <p>{t('outputText')}</p>
      </div>
    </div>
  );
}
