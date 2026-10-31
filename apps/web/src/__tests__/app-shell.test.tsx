import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOSITORY_URL } from '../components/shell/AppFooter';
import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from '../lib/theme';
import Home from '../pages/index';
import { mockRouter, setRoute } from './router-mock';
import {
  jsonResponse,
  meSignedIn,
  meSignedOut,
  mockFetch,
  renderPage,
  TEST_USER,
} from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

const accountButton = () => screen.findByRole('button', { name: /Account menu/ });

describe('header, signed out', () => {
  it('offers Log in and Create account, no account menu, and no dead links', async () => {
    setRoute('/');
    mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(Home);

    const nav = await screen.findByRole('navigation', { name: 'Account' });
    expect(within(nav).getByRole('link', { name: 'Log in' }).getAttribute('href')).toBe('/login');
    expect(within(nav).getByRole('link', { name: 'Create account' }).getAttribute('href')).toBe(
      '/register',
    );
    expect(within(nav).getByRole('link', { name: 'Demo' }).getAttribute('href')).toBe('/demo');
    expect(within(nav).getAllByRole('link')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /Account menu/ })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('keeps the logo as the home link', async () => {
    setRoute('/');
    mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(Home);
    await screen.findByRole('navigation', { name: 'Account' });
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: 'Evidomo' }).getAttribute('href')).toBe('/');
  });
});

describe('header, signed in', () => {
  beforeEach(() => {
    mockFetch({ 'GET /api/auth/me': meSignedIn });
  });

  it.each([
    ['/projects', 'page'],
    ['/projects/abc', 'true'],
    ['/', null],
  ])('marks Projects on %s with aria-current=%s', async (path, expected) => {
    setRoute(path);
    renderPage(Home);
    const link = await screen.findByRole('link', { name: 'Projects' });
    expect(link.getAttribute('href')).toBe('/projects');
    expect(link.getAttribute('aria-current')).toBe(expected);
    const main = within(screen.getByRole('navigation', { name: 'Main' }));
    expect(main.getAllByRole('link')).toHaveLength(2);
    expect(main.getByRole('link', { name: 'Demo' }).getAttribute('href')).toBe('/demo');
  });

  it('marks Demo on the demo pages', async () => {
    setRoute('/demo/runs/abc');
    renderPage(Home);
    const link = await screen.findByRole('link', { name: 'Demo' });
    expect(link.getAttribute('aria-current')).toBe('true');
  });

  it('hides the sign-in actions', async () => {
    setRoute('/');
    renderPage(Home);
    await accountButton();
    expect(screen.queryByRole('link', { name: 'Log in' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Create account' })).toBeNull();
  });
});

describe('account menu', () => {
  beforeEach(() => {
    setRoute('/');
  });

  it('is closed at first and shows the email and Log out when opened', async () => {
    mockFetch({ 'GET /api/auth/me': meSignedIn });
    renderPage(Home);
    const button = await accountButton();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();

    fireEvent.click(button);

    expect(button.getAttribute('aria-expanded')).toBe('true');
    const menuId = button.getAttribute('aria-controls') ?? '';
    const menu = document.getElementById(menuId);
    expect(menu?.textContent).toContain(TEST_USER.email);
    expect(within(menu as HTMLElement).getByRole('button', { name: 'Log out' })).toBeDefined();
  });

  it('closes on Escape and returns focus to the button', async () => {
    mockFetch({ 'GET /api/auth/me': meSignedIn });
    renderPage(Home);
    const button = await accountButton();
    fireEvent.click(button);
    const logOut = screen.getByRole('button', { name: 'Log out' });
    logOut.focus();

    fireEvent.keyDown(logOut, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('closes on an outside tap, and toggles closed on a second press', async () => {
    mockFetch({ 'GET /api/auth/me': meSignedIn });
    renderPage(Home);
    const button = await accountButton();
    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();

    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
  });

  it('stays open for a tap inside the menu', async () => {
    mockFetch({ 'GET /api/auth/me': meSignedIn });
    renderPage(Home);
    fireEvent.click(await accountButton());
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Log out' }));
    expect(screen.getByRole('button', { name: 'Log out' })).toBeDefined();
  });

  it('closes when focus tabs out of it', async () => {
    mockFetch({ 'GET /api/auth/me': meSignedIn });
    renderPage(Home);
    const button = await accountButton();
    fireEvent.click(button);
    const logOut = screen.getByRole('button', { name: 'Log out' });
    fireEvent.blur(logOut, { relatedTarget: document.body });
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
  });

  it('Log out calls the API and leaves for the landing page', async () => {
    const fetchMock = mockFetch({
      'GET /api/auth/me': meSignedIn,
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });
    renderPage(Home);
    fireEvent.click(await accountButton());
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('says so inside the menu when logout fails', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      'POST /api/auth/logout': () => jsonResponse(500, { error: 'internal_error' }),
    });
    renderPage(Home);
    fireEvent.click(await accountButton());
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not log out. Try again.');
  });
});

describe('footer', () => {
  it('has the brand, the hackathon line, the repository link, and the language links', async () => {
    setRoute('/');
    mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(Home);
    const footer = await screen.findByRole('contentinfo');

    expect(within(footer).getByText('Evidomo')).toBeDefined();
    expect(
      within(footer).getByText(/Built during the Meta hackathon, Oct 26 – Nov 4, 2026/),
    ).toBeDefined();
    // The repository link, then the five languages (the language switcher).
    const links = within(footer).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      REPOSITORY_URL,
      '/',
      '/tr',
      '/nl',
      '/it',
      '/es',
    ]);
    expect(links.slice(1).map((link) => link.textContent)).toEqual([
      'English',
      'Türkçe',
      'Nederlands',
      'Italiano',
      'Español',
    ]);
    expect(REPOSITORY_URL).toBe('https://github.com/EtkinD/evidomo');
  });
});

describe('theme switch', () => {
  const root = document.documentElement;
  const radio = (name: string) => screen.getByRole('radio', { name });

  beforeEach(() => {
    setRoute('/');
    localStorage.clear();
    root.removeAttribute('data-theme');
    mockFetch({ 'GET /api/auth/me': meSignedOut });
  });
  afterEach(() => {
    root.removeAttribute('data-theme');
    localStorage.clear();
  });

  it('is a labelled group of System / Light / Dark with the current choice checked', async () => {
    renderPage(Home);
    await screen.findByRole('contentinfo');
    expect(screen.getByRole('group', { name: 'Theme' })).toBeDefined();
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual([
      'System',
      'Light',
      'Dark',
    ]);
    expect((radio('System') as HTMLInputElement).checked).toBe(true);
  });

  it('applies and stores Dark, then Light, and System removes data-theme and the key', async () => {
    renderPage(Home);
    await screen.findByRole('contentinfo');

    fireEvent.click(radio('Dark'));
    expect(root.getAttribute('data-theme')).toBe('evidomo-dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    await waitFor(() => expect((radio('Dark') as HTMLInputElement).checked).toBe(true));

    fireEvent.click(radio('Light'));
    expect(root.getAttribute('data-theme')).toBe('evidomo-light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    fireEvent.click(radio('System'));
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    await waitFor(() => expect((radio('System') as HTMLInputElement).checked).toBe(true));
  });

  it('shows the theme the page already has after load', async () => {
    root.setAttribute('data-theme', 'evidomo-dark');
    renderPage(Home);
    await screen.findByRole('contentinfo');
    await waitFor(() => expect((radio('Dark') as HTMLInputElement).checked).toBe(true));
  });

  it('follows a change made in another tab', async () => {
    renderPage(Home);
    await screen.findByRole('contentinfo');
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }));
    });
    expect(root.getAttribute('data-theme')).toBe('evidomo-dark');
    await waitFor(() => expect((radio('Dark') as HTMLInputElement).checked).toBe(true));
  });

  it('still switches for this page view when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    renderPage(Home);
    await screen.findByRole('contentinfo');
    fireEvent.click(radio('Dark'));
    expect(root.getAttribute('data-theme')).toBe('evidomo-dark');
    await waitFor(() => expect((radio('Dark') as HTMLInputElement).checked).toBe(true));
    fireEvent.click(radio('System'));
    expect(root.hasAttribute('data-theme')).toBe(false);
    vi.restoreAllMocks();
  });
});

describe('theme init script (runs from <head> before first paint)', () => {
  const root = document.documentElement;
  // Same globals the browser gives the inline script, in an isolated context.
  const run = (): void => {
    runInNewContext(THEME_INIT_SCRIPT, { localStorage, document });
  };

  afterEach(() => {
    root.removeAttribute('data-theme');
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it.each([
    ['dark', 'evidomo-dark'],
    ['light', 'evidomo-light'],
  ])('sets data-theme for the stored %s choice', (stored, theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, stored);
    run();
    expect(root.getAttribute('data-theme')).toBe(theme);
  });

  it('leaves System alone for no value or an unknown value', () => {
    run();
    expect(root.hasAttribute('data-theme')).toBe(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'evidomo-pink');
    run();
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('does not throw when reading storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(run).not.toThrow();
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});
