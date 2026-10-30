import { z } from 'zod';

// Translated labels for market profile text (docs/architecture.md §7, "Translated labels").
// The profile's `label` (or `name`) stays the English source; an optional `labels` map carries
// the other UI languages. A missing translation falls back to English, so a half-translated
// profile still renders. The pipeline never reads the maps: prompts, claim checks, and the
// fact sheet keep using the English source, so adding or fixing a translation changes no run.

/** The UI languages besides English, which is the source text. */
export const LABEL_LOCALES = ['tr', 'nl', 'it', 'es'] as const;
export type LabelLocale = (typeof LABEL_LOCALES)[number];

/** Every language the web app ships (`apps/web/messages/*.json`). */
export const UI_LOCALES = ['en', ...LABEL_LOCALES] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

/** One translated label: trimmed, non-empty, the same length bound as the English source. */
const translatedLabelSchema = z.string().trim().min(1).max(200);

/**
 * Translations by language. A strict object, so an unknown language (`de`) or `en` (the source
 * text is `label`, never a translation of itself) is an error instead of a silently unused key.
 * Every language is optional: a missing one falls back to English.
 */
export const labelTranslationsSchema = z.strictObject({
  tr: translatedLabelSchema.optional(),
  nl: translatedLabelSchema.optional(),
  it: translatedLabelSchema.optional(),
  es: translatedLabelSchema.optional(),
});
export type LabelTranslations = z.infer<typeof labelTranslationsSchema>;

/** Anything that carries an English label and its translations (a form field, an option). */
export interface LabelSource {
  readonly label: string;
  readonly labels?: LabelTranslations | undefined;
}

function isLabelLocale(language: string): language is LabelLocale {
  return (LABEL_LOCALES as readonly string[]).includes(language);
}

/**
 * The label in `locale`, or the English source when the locale is English, unsupported, or has
 * no translation for this label. Accepts a language tag (`tr-TR`, `nl_NL`, `TR`): only the
 * language part counts.
 */
export function localizedLabel(source: LabelSource, locale: string): string {
  const language = locale.split(/[-_]/, 1)[0]?.toLowerCase() ?? '';
  if (!isLabelLocale(language)) return source.label;
  return source.labels?.[language] ?? source.label;
}
