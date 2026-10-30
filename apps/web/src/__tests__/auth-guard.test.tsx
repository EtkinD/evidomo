import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { meQueryKey } from '../lib/auth';
import Home from '../pages/index';
import LoginPage from '../pages/login';
import ProjectsPage from '../pages/projects';
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

const PROTECTED_HEADING = { level: 1, name: 'Your projects' } as const;

describe('protected pages', () => {
  beforeEach(() => {
    setRoute('/projects?tab=recent');
  });

  it('shows a session check, never the content, while loading', () => {
    mockFetch({ 'GET /api/auth/me': () => new Promise<Response>(() => undefined) });
    renderPage(ProjectsPage);

    expect(screen.getByRole('status').textContent).toContain('Checking your session');
    expect(screen.queryByRole('heading', PROTECTED_HEADING)).toBeNull();
  });

  it('redirects a signed-out visitor to login with next set to the current path', async () => {
    mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(ProjectsPage);

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/login?next=%2Fprojects%3Ftab%3Drecent');
    });
    expect(screen.queryByRole('heading', PROTECTED_HEADING)).toBeNull();
  });

  it('waits for the router before redirecting', async () => {
    mockRouter.isReady = false;
    mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(ProjectsPage);

    // The header switches to signed-out controls once the session check has settled.
    await screen.findByRole('link', { name: 'Log in' });
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('renders the content for a signed-in user', async () => {
    mockFetch({ 'GET /api/auth/me': meSignedIn });
    renderPage(ProjectsPage);

    expect(await screen.findByRole('heading', PROTECTED_HEADING)).toBeDefined();
    expect(screen.getByText(`Signed in as ${TEST_USER.email}`)).toBeDefined();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('offers a retry when the session check fails, without redirecting', async () => {
    let calls = 0;
    mockFetch({
      'GET /api/auth/me': () => {
        calls += 1;
        return calls === 1 ? jsonResponse(500, { error: 'internal_error' }) : meSignedIn();
      },
    });
    renderPage(ProjectsPage);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'could not check your session',
    );
    expect(mockRouter.replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', PROTECTED_HEADING)).toBeDefined();
  });
});

describe('guest pages', () => {
  it('send a signed-in user to the validated next path', async () => {
    setRoute('/login?next=%2Fprojects');
    mockFetch({ 'GET /api/auth/me': meSignedIn });
    renderPage(LoginPage);

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/projects');
    });
    expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull();
  });

  it('send a signed-in user home when next points off-site', async () => {
    setRoute(`/login?next=${encodeURIComponent('https://evil.example/')}`);
    mockFetch({ 'GET /api/auth/me': meSignedIn });
    renderPage(LoginPage);

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/');
    });
  });
});

describe('public pages and the header', () => {
  it('render a public page without waiting for the session check', () => {
    setRoute('/');
    mockFetch({ 'GET /api/auth/me': () => new Promise<Response>(() => undefined) });
    renderPage(Home);

    expect(screen.getByRole('heading', { level: 1, name: /linked to its evidence/ })).toBeDefined();
  });

  it('log out: leave the page, then forget the user', async () => {
    setRoute('/projects');
    const fetchMock = mockFetch({
      'GET /api/auth/me': meSignedIn,
      'GET /api/projects': () => jsonResponse(200, { projects: [] }),
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });
    const { queryClient } = renderPage(ProjectsPage);
    // The mock router does not unmount the page, so record what the cache held at the moment
    // of navigation instead: the user must still be there, or the protected page's guard would
    // redirect to login with `next` pointing back at it.
    let userWhenLeaving: unknown = 'not navigated';
    mockRouter.replace.mockImplementationOnce((url) => {
      userWhenLeaving = { url, user: queryClient.getQueryData(meQueryKey) };
      return Promise.resolve(true);
    });

    fireEvent.click(await screen.findByRole('button', { name: /Account menu/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    await waitFor(() => {
      expect(queryClient.getQueryData(meQueryKey)).toBeNull();
    });
    expect(userWhenLeaving).toEqual({ url: '/', user: TEST_USER });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
  });

  it('keep the user signed in and say so when logout fails', async () => {
    setRoute('/projects');
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      'GET /api/projects': () => jsonResponse(200, { projects: [] }),
      'POST /api/auth/logout': () => jsonResponse(500, { error: 'internal_error' }),
    });
    renderPage(ProjectsPage);

    fireEvent.click(await screen.findByRole('button', { name: /Account menu/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Could not log out. Try again.');
    expect(screen.getByRole('heading', PROTECTED_HEADING)).toBeDefined();
  });
});
