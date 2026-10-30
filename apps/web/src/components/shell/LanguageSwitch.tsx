import Link from 'next/link';
import { useRouter } from 'next/router';
import { useLocale, useTranslations } from 'use-intl';
import { LOCALES, LOCALE_NAMES, type AppLocale } from '../../lib/i18n';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// Next's own detection reads this cookie on a visit to `/`, so the choice sticks. It is not
// personal data and holds only a locale code.
function rememberLocale(locale: AppLocale): void {
  document.cookie = `NEXT_LOCALE=${locale}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}

/**
 * The five languages as links to the same page in another locale. Each name is written in its own
 * language (`lang`/`hreflang`), so a visitor who landed in the wrong one can still find theirs.
 */
export function LanguageSwitch() {
  const t = useTranslations('shell');
  const current = useLocale();
  const { asPath, pathname, isReady } = useRouter();
  // A prerendered page has no query string until the router is ready; using the path before that
  // keeps the first client render identical to the server's HTML.
  const href = isReady ? asPath : pathname;

  return (
    <nav aria-label={t('language')} className="flex flex-col gap-1">
      <p aria-hidden className="mb-1 text-sm text-base-content/70">
        {t('language')}
      </p>
      <ul className="flex flex-wrap gap-x-1">
        {LOCALES.map((locale) => (
          <li key={locale}>
            <Link
              href={href}
              locale={locale}
              lang={locale}
              hrefLang={locale}
              aria-current={locale === current ? 'true' : undefined}
              onClick={() => rememberLocale(locale)}
              className={`inline-flex min-h-11 items-center px-2 text-sm underline-offset-8 hover:underline ${locale === current ? 'font-semibold underline decoration-accent decoration-4' : ''}`}
            >
              {LOCALE_NAMES[locale]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
