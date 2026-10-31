import { useRouter } from 'next/router';
import { useLocale, useTranslations } from 'use-intl';
import { DEFAULT_LOCALE, LOCALES, LOCALE_NAMES, type AppLocale } from '../../lib/i18n';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// The locale proxy reads this cookie on a visit to `/`, so the choice sticks. It is not personal
// data and holds only a locale code.
function rememberLocale(locale: AppLocale): void {
  document.cookie = `NEXT_LOCALE=${locale}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}

/** The same page in `locale`: English stays unprefixed, the others get `/tr`, `/nl`, ... */
export function localizedHref(locale: AppLocale, path: string): string {
  if (locale === DEFAULT_LOCALE) return path;
  return path === '/' || path.startsWith('/?') ? `/${locale}${path.slice(1)}` : `/${locale}${path}`;
}

/**
 * The five languages as links to the same page in another locale. Each name is written in its own
 * language (`lang`/`hreflang`), so a visitor who landed in the wrong one can still find theirs.
 *
 * Plain links with a full page load, not Next's `Link`: the router prefetches a link's data on
 * hover (even with `prefetch={false}`), which runs the locale proxy before the click has set the
 * cookie, and the click would then follow that redirect back to the browser's language. A full
 * load sends the cookie the click just wrote; the page loads its own messages anyway.
 */
export function LanguageSwitch() {
  const t = useTranslations('shell');
  const current = useLocale();
  const { asPath, pathname, isReady } = useRouter();
  // A prerendered page has no query string until the router is ready; using the path before that
  // keeps the first client render identical to the server's HTML.
  const path = isReady ? asPath : pathname;

  return (
    <nav aria-label={t('language')} className="flex flex-col gap-1">
      <p aria-hidden className="mb-1 text-sm text-base-content/70">
        {t('language')}
      </p>
      <ul className="flex flex-wrap gap-x-1">
        {LOCALES.map((locale) => (
          <li key={locale}>
            <a
              href={localizedHref(locale, path)}
              lang={locale}
              hrefLang={locale}
              aria-current={locale === current ? 'true' : undefined}
              onClick={() => rememberLocale(locale)}
              className={`inline-flex min-h-11 items-center px-2 text-sm underline-offset-8 hover:underline ${locale === current ? 'font-semibold underline decoration-accent decoration-4' : ''}`}
            >
              {LOCALE_NAMES[locale]}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
