import Head from 'next/head';
import { useRouter } from 'next/router';
import { useLocale, useTranslations } from 'use-intl';
import { DEFAULT_LOCALE, LOCALES, OG_LOCALES, type AppLocale } from '../lib/i18n';

/**
 * Optional production origin (non-secret, inlined at build time). Open Graph images and hreflang
 * alternates should be absolute URLs; without it the paths stay relative.
 */
export function siteOrigin(): string {
  return (process.env['NEXT_PUBLIC_SITE_ORIGIN'] ?? '').replace(/\/+$/, '');
}

/** The Open Graph image of a locale (1200 x 630, tagline outlined in that language). */
export function ogImagePath(locale: AppLocale): string {
  return `/og-${locale}.png`;
}

/** The URL path of the current page in another locale: English has no prefix. */
export function localePath(locale: AppLocale, asPath: string): string {
  const path = asPath.split(/[?#]/, 1)[0] ?? '/';
  if (locale === DEFAULT_LOCALE) return path;
  return path === '/' ? `/${locale}` : `/${locale}${path}`;
}

/**
 * Site-wide head defaults. Keyed, so a page's own `<Head>` can replace any of them. Each locale's
 * pages carry their own Open Graph image and language alternates.
 */
export function SiteHead() {
  const t = useTranslations('meta');
  const locale = useLocale();
  const { asPath } = useRouter();
  const origin = siteOrigin();
  const image = `${origin}${ogImagePath(locale)}`;

  return (
    <Head>
      <meta key="og:site_name" property="og:site_name" content="Evidomo" />
      <meta key="og:type" property="og:type" content="website" />
      <meta key="og:title" property="og:title" content="Evidomo" />
      <meta key="og:description" property="og:description" content={t('tagline')} />
      <meta key="og:locale" property="og:locale" content={OG_LOCALES[locale]} />
      {LOCALES.filter((other) => other !== locale).map((other) => (
        <meta
          key={`og:locale:alternate:${other}`}
          property="og:locale:alternate"
          content={OG_LOCALES[other]}
        />
      ))}
      <meta key="og:image" property="og:image" content={image} />
      <meta key="og:image:width" property="og:image:width" content="1200" />
      <meta key="og:image:height" property="og:image:height" content="630" />
      <meta key="og:image:alt" property="og:image:alt" content={t('ogImageAlt')} />
      <meta key="twitter:card" name="twitter:card" content="summary_large_image" />
      <meta key="twitter:image" name="twitter:image" content={image} />
      {LOCALES.map((other) => (
        <link
          key={`alternate:${other}`}
          rel="alternate"
          hrefLang={other}
          href={`${origin}${localePath(other, asPath)}`}
        />
      ))}
      <link
        key="alternate:x-default"
        rel="alternate"
        hrefLang="x-default"
        href={`${origin}${localePath(DEFAULT_LOCALE, asPath)}`}
      />
    </Head>
  );
}
