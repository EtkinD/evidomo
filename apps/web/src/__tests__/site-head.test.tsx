import { render } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import tr from '../../messages/tr.json';
import { SiteHead } from '../components/SiteHead';
import { LOCALES, type AppLocale } from '../lib/i18n';
import { setRoute } from './router-mock';

vi.mock('next/router', () => import('./router-mock'));
// Next's Head renders into document.head through its own manager; render the children in place.
vi.mock('next/head', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const MESSAGES = { en, tr, es } as const;

function renderHead(locale: 'en' | 'tr' | 'es') {
  return render(
    <IntlProvider locale={locale} messages={MESSAGES[locale]}>
      <SiteHead />
    </IntlProvider>,
  );
}

// React 19 hoists <meta> and <link> into document.head, so that is where they are read.
const meta = (_container: HTMLElement, property: string): string[] =>
  [...document.head.querySelectorAll(`meta[property="${property}"]`)].map(
    (node) => node.getAttribute('content') ?? '',
  );

afterEach(() => vi.unstubAllEnvs());

describe('site head per locale', () => {
  it.each(['en', 'tr', 'es'] as const)('%s points at its own Open Graph image', (locale) => {
    setRoute('/');
    const { container } = renderHead(locale);
    expect(meta(container, 'og:image')).toEqual([`/og-${locale}.png`]);
    expect(meta(container, 'og:image:width')).toEqual(['1200']);
    expect(meta(container, 'og:image:height')).toEqual(['630']);
    expect(document.head.querySelector('meta[name="twitter:image"]')?.getAttribute('content')).toBe(
      `/og-${locale}.png`,
    );
    expect(meta(container, 'og:description')).toEqual([MESSAGES[locale].meta.tagline]);
    expect(meta(container, 'og:image:alt')).toEqual([MESSAGES[locale].meta.ogImageAlt]);
  });

  it('names the locale and lists the other four as alternates', () => {
    setRoute('/');
    const { container } = renderHead('tr');
    expect(meta(container, 'og:locale')).toEqual(['tr_TR']);
    expect(meta(container, 'og:locale:alternate').sort()).toEqual([
      'en_US',
      'es_ES',
      'it_IT',
      'nl_NL',
    ]);
  });

  it('links every language and x-default, absolute when the site origin is set', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_ORIGIN', 'https://evidomo.example/');
    setRoute('/demo');
    const { container } = renderHead('es');
    const alternates: Record<string, string> = {};
    for (const link of document.head.querySelectorAll('link[rel="alternate"]')) {
      alternates[link.getAttribute('hreflang') ?? ''] = link.getAttribute('href') ?? '';
    }
    expect(alternates).toEqual({
      en: 'https://evidomo.example/demo',
      tr: 'https://evidomo.example/tr/demo',
      nl: 'https://evidomo.example/nl/demo',
      it: 'https://evidomo.example/it/demo',
      es: 'https://evidomo.example/es/demo',
      'x-default': 'https://evidomo.example/demo',
    });
    expect(meta(container, 'og:image')).toEqual(['https://evidomo.example/og-es.png']);
  });
});

describe('Open Graph image files', () => {
  it('exist for every locale', () => {
    for (const locale of LOCALES satisfies readonly AppLocale[]) {
      expect(existsSync(resolve(__dirname, `../../public/og-${locale}.png`)), locale).toBe(true);
    }
  });
});
