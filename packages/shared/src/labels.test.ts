import { describe, expect, it } from 'vitest';
import { LABEL_LOCALES, UI_LOCALES, labelTranslationsSchema, localizedLabel } from './labels.ts';

describe('labelTranslationsSchema', () => {
  it('accepts any subset of tr, nl, it, es and trims the text', () => {
    expect(labelTranslationsSchema.parse({})).toEqual({});
    expect(labelTranslationsSchema.parse({ tr: ' Yaşam alanı ', nl: 'Woonoppervlakte' })).toEqual({
      tr: 'Yaşam alanı',
      nl: 'Woonoppervlakte',
    });
  });

  it('rejects a language the web does not ship, and "en", which is the source label itself', () => {
    expect(labelTranslationsSchema.safeParse({ de: 'Wohnfläche' }).success).toBe(false);
    expect(labelTranslationsSchema.safeParse({ en: 'Living area' }).success).toBe(false);
  });

  it('rejects non-string, empty, blank, and over-long text', () => {
    for (const bad of [92, null, '', '   ', 'x'.repeat(201)]) {
      expect(labelTranslationsSchema.safeParse({ nl: bad }).success).toBe(false);
    }
  });

  it('covers exactly the web locales besides English', () => {
    expect(UI_LOCALES).toEqual(['en', 'tr', 'nl', 'it', 'es']);
    expect(LABEL_LOCALES).toEqual(['tr', 'nl', 'it', 'es']);
  });
});

describe('localizedLabel', () => {
  const source = { label: 'Living area', labels: { tr: 'Yaşam alanı', nl: 'Woonoppervlakte' } };

  it('returns the translation for a supported locale', () => {
    expect(localizedLabel(source, 'tr')).toBe('Yaşam alanı');
    expect(localizedLabel(source, 'nl')).toBe('Woonoppervlakte');
  });

  it('falls back to English for English, a missing translation, an unsupported locale, and junk', () => {
    expect(localizedLabel(source, 'en')).toBe('Living area');
    expect(localizedLabel(source, 'it')).toBe('Living area');
    expect(localizedLabel(source, 'de')).toBe('Living area');
    expect(localizedLabel(source, '')).toBe('Living area');
    expect(localizedLabel(source, 'toString')).toBe('Living area');
    expect(localizedLabel({ label: 'Living area' }, 'tr')).toBe('Living area');
  });

  it('reads the language part of a tag, case-insensitively', () => {
    expect(localizedLabel(source, 'tr-TR')).toBe('Yaşam alanı');
    expect(localizedLabel(source, 'NL_nl')).toBe('Woonoppervlakte');
  });
});
