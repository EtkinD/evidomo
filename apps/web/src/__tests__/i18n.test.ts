import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import tr from '../../messages/tr.json';
import { I18N } from '../../next.config';
import { localePath, ogImagePath } from '../components/SiteHead';
import { DEFAULT_LOCALE, LOCALES, OG_LOCALES, isLocale, resolveLocale } from '../lib/i18n';
import { loadMessages } from '../lib/i18n-server';

describe('locale routing config', () => {
  it('lists the same locales as the app, English first and unprefixed', () => {
    expect([...I18N.locales]).toEqual([...LOCALES]);
    expect(I18N.defaultLocale).toBe(DEFAULT_LOCALE);
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('has an Open Graph locale for every language', () => {
    expect(Object.keys(OG_LOCALES).sort()).toEqual([...LOCALES].sort());
  });
});

describe('locale fallback', () => {
  it('accepts exactly the supported locales', () => {
    for (const locale of LOCALES) expect(isLocale(locale)).toBe(true);
    for (const other of ['de', 'EN', 'en-US', '', undefined, null, 3]) {
      expect(isLocale(other)).toBe(false);
    }
  });

  it('falls back to English for an unknown or missing locale', () => {
    expect(resolveLocale('tr')).toBe('tr');
    expect(resolveLocale('de')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });

  it('loads the messages of one locale, and English for an unknown one', async () => {
    expect((await loadMessages('tr')).meta.tagline).toBe(tr.meta.tagline);
    expect((await loadMessages('de')).meta.tagline).toBe(en.meta.tagline);
    expect((await loadMessages(undefined)).meta.tagline).toBe(en.meta.tagline);
  });
});

describe('locale paths', () => {
  it('keeps English unprefixed and prefixes the others', () => {
    expect(localePath('en', '/')).toBe('/');
    expect(localePath('tr', '/')).toBe('/tr');
    expect(localePath('nl', '/projects')).toBe('/nl/projects');
    expect(localePath('es', '/demo?x=1#top')).toBe('/es/demo');
  });

  it('gives every locale its own Open Graph image', () => {
    expect(LOCALES.map(ogImagePath)).toEqual([
      '/og-en.png',
      '/og-tr.png',
      '/og-nl.png',
      '/og-it.png',
      '/og-es.png',
    ]);
  });
});
