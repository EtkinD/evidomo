import { useTranslations } from 'use-intl';

/** On every demo page: what the visitor is looking at, said before anything else. */
export function DemoBanner() {
  const t = useTranslations('demo');
  return (
    <section aria-label={t('bannerLabel')} className="alert alert-info alert-vertical items-start">
      <div className="flex flex-col gap-1">
        <p className="font-semibold">
          <span aria-hidden>ⓘ </span>
          {t('bannerTitle')}
        </p>
        <p className="text-sm">{t('bannerText')}</p>
      </div>
    </section>
  );
}
