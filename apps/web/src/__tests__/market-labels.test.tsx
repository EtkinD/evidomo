import { marketFormResponseSchema } from '@evidomo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createTranslator, IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import nl from '../../messages/nl.json';
import tr from '../../messages/tr.json';
import { FactForm } from '../components/FactForm';
import { labelsFor } from '../components/FactConflicts';
import { marketName, readinessMessage } from '../lib/project-view';
import { PROJECT_ID } from './project-fixtures';

// A profile with Turkish and Dutch translations; Italian and Spanish are deliberately missing.
const { market } = marketFormResponseSchema.parse({
  market: {
    id: 'germany',
    version: 1,
    name: 'Germany',
    names: { tr: 'Almanya', nl: 'Duitsland' },
    outputLanguages: ['de'],
    defaultOutputLanguage: 'de',
    currency: 'EUR',
    units: { area: 'm2', volume: 'm3' },
    areaBases: [
      {
        id: 'wohnflaeche',
        label: 'Living area (Wohnfläche)',
        labels: { tr: 'Yaşam alanı (Wohnfläche)' },
      },
    ],
    facts: [
      {
        key: 'living_area',
        label: 'Living area',
        labels: { tr: 'Yaşam alanı', nl: 'Woonoppervlak' },
        required: true,
        type: 'area',
        unit: 'm2',
        basis: {
          id: 'wohnflaeche',
          label: 'Living area (Wohnfläche)',
          labels: { tr: 'Yaşam alanı (Wohnfläche)' },
        },
      },
      {
        key: 'heating_type',
        label: 'Heating type',
        labels: { tr: 'Isıtma türü', nl: 'Verwarming' },
        required: false,
        type: 'enum',
        values: ['central_heating', 'district_heating'],
        options: [
          { value: 'central_heating', label: 'Central heating', labels: { tr: 'Merkezi ısıtma' } },
          {
            value: 'district_heating',
            label: 'District heating',
            labels: { tr: 'Bölgesel ısıtma' },
          },
        ],
      },
    ],
  },
});

function renderForm(locale: 'tr' | 'nl' | 'en', messages: typeof en): void {
  const client = new QueryClient();
  const wrap = (children: ReactNode) => (
    <IntlProvider locale={locale} messages={messages} timeZone="UTC">
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </IntlProvider>
  );
  render(wrap(<FactForm projectId={PROJECT_ID} market={market} values={{}} locked={false} />));
}

describe('translated market profile labels', () => {
  it('Turkish: field label, enum options, and the area basis hint', () => {
    renderForm('tr', tr);
    expect(screen.getByLabelText(/Yaşam alanı/)).toBeDefined();
    expect(screen.getByRole('option', { name: 'Merkezi ısıtma' })).toBeDefined();
    expect(screen.getByLabelText('Isıtma türü')).toBeDefined();
    expect(screen.getByText(/Wohnfläche/).textContent).toContain('Yaşam alanı (Wohnfläche)');
  });

  it('Dutch: translated field label; an option without a Dutch label falls back to English', () => {
    renderForm('nl', nl);
    expect(screen.getByLabelText(/Woonoppervlak/)).toBeDefined();
    expect(screen.getByRole('option', { name: 'Central heating' })).toBeDefined();
  });

  it('English keeps the source labels', () => {
    renderForm('en', en);
    expect(screen.getByLabelText(/Living area/)).toBeDefined();
    expect(screen.getByRole('option', { name: 'District heating' })).toBeDefined();
  });

  it('Gate 1 labels: fact title, enum value, and basis follow the locale, English as fallback', () => {
    const t = createTranslator({ locale: 'en', messages: en, namespace: 'common' });
    const turkish = labelsFor(t, market, 'tr');
    expect(turkish.fact('living_area')).toBe('Yaşam alanı');
    expect(turkish.value('central_heating', null, null, 'heating_type')).toBe('Merkezi ısıtma');
    expect(turkish.value(92, 'm2', 'wohnflaeche', 'living_area')).toContain(
      'Yaşam alanı (Wohnfläche)',
    );
    const italian = labelsFor(t, market, 'it');
    expect(italian.fact('living_area')).toBe('Living area');
    expect(italian.value('central_heating', null, null, 'heating_type')).toBe('Central heating');
    // A key the profile does not know is humanised, as before.
    expect(turkish.fact('other:station_distance')).toBe('Station distance');
  });

  it('market names come from the names map, with English as the fallback', () => {
    expect(marketName(market, 'tr')).toBe('Almanya');
    expect(marketName(market, 'nl-NL')).toBe('Duitsland');
    expect(marketName(market, 'es')).toBe('Germany');
    // The project view has no map at all: English.
    expect(marketName({ name: 'Germany' }, 'tr')).toBe('Germany');
  });

  it('readiness lists name the missing fact in the interface language', () => {
    const t = createTranslator({ locale: 'en', messages: en, namespace: 'readiness' });
    const item = { kind: 'fact', key: 'living_area', problem: 'missing' } as const;
    expect(readinessMessage(t, item, market, 'nl')).toContain('Woonoppervlak');
    expect(readinessMessage(t, item, market, 'es')).toContain('Living area');
  });
});
