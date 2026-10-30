import type { useFormatter, useTranslations } from 'use-intl';
import type en from '../../messages/en.json';

export const LOCALES = ['en', 'tr', 'nl', 'it', 'es'] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = 'en';

/** The messages of the source locale; every other locale has exactly these keys (a test checks). */
export type Messages = typeof en;

// BCP 47 tags for formatting and Open Graph (`og:locale` wants language_TERRITORY).
export const OG_LOCALES: Record<AppLocale, string> = {
  en: 'en_US',
  tr: 'tr_TR',
  nl: 'nl_NL',
  it: 'it_IT',
  es: 'es_ES',
};

/** The name of each language in itself, for the language switcher. */
export const LOCALE_NAMES: Record<AppLocale, string> = {
  en: 'English',
  tr: 'Türkçe',
  nl: 'Nederlands',
  it: 'Italiano',
  es: 'Español',
};

export function isLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** An unknown or missing locale (a Next fallback, a stale cookie) is English. */
export function resolveLocale(value: unknown): AppLocale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** A translator scoped to one top-level namespace, for helpers outside React components. */
export type Translator<NS extends Extract<keyof Messages, string>> = ReturnType<
  typeof useTranslations<NS>
>;

/** The number and date formatter from `useFormatter`, for helpers outside components. */
export type Formatter = ReturnType<typeof useFormatter>;
