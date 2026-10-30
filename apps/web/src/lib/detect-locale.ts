import { DEFAULT_LOCALE, isLocale, type AppLocale } from './i18n';

/** The cookie the language switcher writes, and Next's own name for it. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

interface Preference {
  tag: string;
  quality: number;
}

/** `tr-TR,tr;q=0.9,en;q=0.8` as tags in the order the browser prefers them (ties keep their order). */
function preferences(acceptLanguage: string): Preference[] {
  const found: Preference[] = [];
  for (const part of acceptLanguage.split(',')) {
    const [rawTag, ...params] = part.trim().split(';');
    const tag = rawTag?.trim().toLowerCase() ?? '';
    if (tag === '' || tag === '*') continue;
    const q = params.map((param) => /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(param)?.[1]).find(Boolean);
    const quality = q === undefined ? 1 : Number(q);
    if (Number.isFinite(quality) && quality > 0) found.push({ tag, quality });
  }
  return found
    .map((preference, index) => ({ preference, index }))
    .sort((a, b) => b.preference.quality - a.preference.quality || a.index - b.index)
    .map(({ preference }) => preference);
}

/**
 * Which locale a first visit to `/` should land on. A choice made with the language switcher
 * (the cookie) wins. Otherwise the first language in the browser's list that the app offers: a
 * regional tag counts as its language (`tr-TR`, which Safari sends on its own, is Turkish; Next's
 * built-in detection only matches the bare `tr`). Anything unsupported is English.
 */
export function detectLocale(
  cookieValue: string | undefined,
  acceptLanguage: string | null | undefined,
): AppLocale {
  if (isLocale(cookieValue)) return cookieValue;
  for (const { tag } of preferences(acceptLanguage ?? '')) {
    if (isLocale(tag)) return tag;
    const language = tag.split('-')[0];
    if (isLocale(language)) return language;
  }
  return DEFAULT_LOCALE;
}
