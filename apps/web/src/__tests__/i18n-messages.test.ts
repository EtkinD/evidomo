import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { createTranslator } from 'use-intl';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import { LOCALES, type AppLocale } from '../lib/i18n';

type Tree = { [key: string]: string | Tree };

const MESSAGES_DIR = resolve(__dirname, '../../messages');
const load = (locale: AppLocale): Tree =>
  JSON.parse(readFileSync(resolve(MESSAGES_DIR, `${locale}.json`), 'utf8')) as Tree;

/** Flattens a nested catalogue to `a.b.c` keys. */
function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') flat[path] = value;
    else Object.assign(flat, flatten(value, path));
  }
  return flat;
}

/**
 * The argument names of an ICU message (`{name}`, `{count, plural, ...}`, `<tag>`). The text in a
 * plural branch (`one {conflict}`) is not an argument, so a brace after a selector is skipped.
 */
function placeholders(message: string): string[] {
  const names = new Set<string>();
  for (const match of message.matchAll(
    /(?<!(?:\bone|\bother|\bzero|\btwo|\bfew|\bmany|=\d+)\s*)\{\s*([A-Za-z][A-Za-z0-9_]*)\s*[,}]/g,
  )) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  for (const match of message.matchAll(/<([a-z][a-z0-9]*)>/g)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return [...names].sort();
}

const source = flatten(en);

describe('message catalogues', () => {
  it('has one file per supported locale and no other', () => {
    expect(readdirSync(MESSAGES_DIR).sort()).toEqual(LOCALES.map((l) => `${l}.json`).sort());
  });

  it.each(LOCALES.filter((locale) => locale !== 'en'))(
    '%s has exactly the keys of en.json',
    (locale) => {
      const keys = Object.keys(flatten(load(locale)));
      expect(keys.filter((key) => !(key in source))).toEqual([]);
      expect(Object.keys(source).filter((key) => !keys.includes(key))).toEqual([]);
    },
  );

  it.each(LOCALES)('%s has no empty message', (locale) => {
    const empty = Object.entries(flatten(load(locale))).filter(([, text]) => text.trim() === '');
    expect(empty).toEqual([]);
  });

  it.each(LOCALES)('%s uses the same placeholders as en.json in every message', (locale) => {
    const flat = flatten(load(locale));
    const mismatched = Object.entries(source)
      .filter(([key, text]) => placeholders(flat[key] ?? '').join() !== placeholders(text).join())
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });

  it.each(LOCALES)('%s: every ICU message parses and formats', (locale) => {
    const errors: string[] = [];
    const translator = createTranslator({
      locale,
      messages: load(locale) as never,
      onError: (error) => errors.push(error.message),
      getMessageFallback: ({ namespace, key }) => `${namespace ?? ''}.${key}`,
    });
    // Every argument gets a number: plural and number arguments need one, and text accepts it.
    for (const [key, text] of Object.entries(flatten(load(locale)))) {
      const values: Record<string, unknown> = {};
      for (const name of placeholders(text)) {
        values[name] = /^c\d$/.test(name)
          ? (chunks: ReactNode) => createElement('b', {}, chunks)
          : 2;
      }
      const result = (translator as unknown as { rich: (k: string, v: unknown) => unknown }).rich(
        key,
        values,
      );
      expect(result, key).toBeDefined();
    }
    expect(errors).toEqual([]);
  });

  it('keeps the Open Graph taglines in step with meta.tagline', () => {
    const outlines = JSON.parse(
      readFileSync(resolve(__dirname, '../../scripts/brand-og-outlines.json'), 'utf8'),
    ) as { taglines: Record<string, { text: string }[]> };
    for (const locale of LOCALES) {
      const lines = outlines.taglines[locale]?.map((line) => line.text).join(' ');
      expect(lines, locale).toBe(flatten(load(locale))['meta.tagline']);
    }
  });
});
