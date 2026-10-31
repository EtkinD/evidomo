import { useTranslations } from 'use-intl';
import { Stamp } from '../Stamp';

/** The top line of every demo sheet: what the visitor is looking at, said before anything else. */
export function DemoRunningHead() {
  const t = useTranslations('demo');
  const tStamps = useTranslations('stamps');
  return (
    <section
      aria-label={t('bannerLabel')}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-base-content/40 pb-3"
    >
      <Stamp tone="sample">{tStamps('sample')}</Stamp>
      <p className="min-w-0 flex-1 text-sm text-base-content/70">{t('runningHead')}</p>
    </section>
  );
}
