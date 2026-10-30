import { LABEL_LOCALES, localizedLabel, type LabelTranslations } from '@evidomo/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDefinitions } from './loader.ts';
import type { MarketProfile } from '@evidomo/shared';

// Parity of the shipped profiles' translations (docs/architecture.md §7, "Translated labels"):
// the schema allows a missing translation (it falls back to English), but the profiles we ship
// must be complete, so a Turkish, Dutch, Italian, or Spanish UI never shows an English label.

interface TranslatableLabel {
  readonly where: string;
  readonly label: string;
  readonly labels: LabelTranslations | undefined;
}

function translatable(market: MarketProfile): TranslatableLabel[] {
  const found: TranslatableLabel[] = [
    { where: 'name', label: market.name, labels: market.names },
    ...market.area_bases.map((basis) => ({
      where: `area_bases.${basis.id}`,
      label: basis.label,
      labels: basis.labels,
    })),
    ...market.publication_checklist.map((item) => ({
      where: `publication_checklist.${item.id}`,
      label: item.label,
      labels: item.labels,
    })),
  ];
  for (const fact of market.facts) {
    found.push({ where: `facts.${fact.key}`, label: fact.label, labels: fact.labels });
    if (fact.type !== 'enum') continue;
    for (const [value, option] of Object.entries(fact.option_labels ?? {})) {
      found.push({
        where: `facts.${fact.key}.option_labels.${value}`,
        label: option.label,
        labels: option.labels,
      });
    }
  }
  return found;
}

let markets: readonly MarketProfile[];

beforeAll(async () => {
  markets = (await loadDefinitions()).markets;
});

describe('the shipped market profiles', () => {
  it('translate every label into tr, nl, it, and es', () => {
    expect(markets.map((market) => market.id)).toEqual(['international', 'nl']);
    const missing: string[] = [];
    for (const market of markets) {
      for (const item of translatable(market)) {
        for (const locale of LABEL_LOCALES) {
          if (item.labels?.[locale] === undefined)
            missing.push(`${market.id}: ${item.where}.${locale}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('label every slug-like enum option (codes such as A++ need no label)', () => {
    const unlabeled: string[] = [];
    for (const market of markets) {
      for (const fact of market.facts) {
        if (fact.type !== 'enum') continue;
        for (const value of fact.values) {
          if (/^[a-z][a-z_]*$/.test(value) && fact.option_labels?.[value] === undefined) {
            unlabeled.push(`${market.id}: ${fact.key}.${value}`);
          }
        }
      }
    }
    expect(unlabeled).toEqual([]);
  });

  it('keep the official names recognisable in every language', () => {
    const nl = markets.find((market) => market.id === 'nl');
    const nen = nl?.area_bases.find((basis) => basis.id === 'NEN2580');
    const cadastral = nl?.area_bases.find((basis) => basis.id === 'cadastral');
    for (const locale of LABEL_LOCALES) {
      expect(localizedLabel(nen ?? { label: '' }, locale)).toContain('NEN 2580');
      expect(localizedLabel(cadastral ?? { label: '' }, locale)).toContain('Kadaster');
    }
  });

  it('keep English as the source: a locale without a translation reads the English label', () => {
    for (const market of markets) {
      for (const item of translatable(market)) {
        expect(localizedLabel({ label: item.label }, 'tr')).toBe(item.label);
        expect(localizedLabel(item, 'en')).toBe(item.label);
      }
    }
  });
});
