import { fireEvent, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import tr from '../../messages/tr.json';
import { LanguageSwitch, localizedHref } from '../components/shell/LanguageSwitch';
import { setRoute } from './router-mock';

vi.mock('next/router', () => import('./router-mock'));

afterEach(() => {
  document.cookie = 'NEXT_LOCALE=; path=/; max-age=0';
});

describe('language switcher', () => {
  it('lists the five languages by their own names, with the current one marked', () => {
    setRoute('/projects');
    render(
      <IntlProvider locale="tr" messages={tr}>
        <LanguageSwitch />
      </IntlProvider>,
    );

    const nav = screen.getByRole('navigation', { name: 'Dil' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'English',
      'Türkçe',
      'Nederlands',
      'Italiano',
      'Español',
    ]);
    expect(links.map((link) => link.getAttribute('lang'))).toEqual(['en', 'tr', 'nl', 'it', 'es']);
    expect(links.filter((link) => link.getAttribute('aria-current') === 'true')).toEqual([
      within(nav).getByRole('link', { name: 'Türkçe' }),
    ]);
    // 44 px targets.
    for (const link of links) expect(link.className).toContain('min-h-11');
  });

  it('remembers the choice in the NEXT_LOCALE cookie so the next visit to / follows it', () => {
    setRoute('/');
    render(
      <IntlProvider locale="tr" messages={tr}>
        <LanguageSwitch />
      </IntlProvider>,
    );
    // The click is a full page load; only the cookie is under test, not the navigation.
    fireEvent.click(screen.getByRole('link', { name: 'Nederlands' }));
    expect(document.cookie).toContain('NEXT_LOCALE=nl');
  });

  it('links to the same page in each locale, English unprefixed', () => {
    setRoute('/projects');
    render(
      <IntlProvider locale="tr" messages={tr}>
        <LanguageSwitch />
      </IntlProvider>,
    );
    const nav = screen.getByRole('navigation', { name: 'Dil' });
    expect(within(nav).getByRole('link', { name: 'English' }).getAttribute('href')).toBe(
      '/projects',
    );
    expect(within(nav).getByRole('link', { name: 'Nederlands' }).getAttribute('href')).toBe(
      '/nl/projects',
    );
  });

  it('builds locale hrefs for the root and for query strings', () => {
    expect(localizedHref('en', '/')).toBe('/');
    expect(localizedHref('tr', '/')).toBe('/tr');
    expect(localizedHref('es', '/?x=1')).toBe('/es?x=1');
    expect(localizedHref('it', '/runs/abc/review')).toBe('/it/runs/abc/review');
  });
});
