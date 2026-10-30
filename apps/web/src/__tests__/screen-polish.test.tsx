import { UNIT_DISPLAY } from '@evidomo/shared';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_COLORS, THEME_INIT_SCRIPT, THEME_STORAGE_KEY, applyTheme } from '../lib/theme';
import { areaUnitLabel, volumeUnitLabel } from '../lib/project-view';
import CapturePage from '../pages/projects/[projectId]/capture';
import ProjectPage from '../pages/projects/[projectId]';
import ProjectsPage from '../pages/projects';
import LoginPage from '../pages/login';
import RegisterPage from '../pages/register';
import { runInNewContext } from 'node:vm';
import { PROJECT_ID, RUN_ID, marketForm, projectDetail, run } from './project-fixtures';
import { mockRouter, setRoute } from './router-mock';
import { jsonResponse, meSignedIn, meSignedOut, mockFetch, renderPage } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

// mockFetch awaits whatever a handler returns, so a pending promise keeps the query loading.
const neverResolves = (() => new Promise<Response>(() => undefined)) as unknown as () => Response;

describe('projects list states', () => {
  beforeEach(() => setRoute('/projects'));

  it('shows a status line with skeleton cards while loading', async () => {
    mockFetch({ 'GET /api/auth/me': meSignedIn, 'GET /api/projects': neverResolves });
    renderPage(ProjectsPage);

    const status = (await screen.findByText('Loading your projects…')).closest('[role=status]');
    if (status === null) throw new Error('No status region around the loading text');
    expect(status.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });

  it('shows the illustration, as decoration, in the empty state', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      'GET /api/projects': () => jsonResponse(200, { projects: [] }),
    });
    renderPage(ProjectsPage);

    await screen.findByRole('heading', { name: 'No projects yet' });
    const image = document.querySelector('img[src*="illustration"]');
    expect(image?.getAttribute('alt')).toBe('');
    expect(screen.getAllByRole('link', { name: 'New project' })).toHaveLength(1);
  });

  it('sends a signed-out session to the log-in page instead of offering a retry', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      'GET /api/projects': () => jsonResponse(401, { error: 'unauthenticated' }),
    });
    renderPage(ProjectsPage);

    const alert = await screen.findByRole('alert');
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(within(alert).getByRole('link', { name: 'Log in' }).getAttribute('href')).toBe(
      '/login?next=%2Fprojects',
    );
  });

  it('gives every row a 44 px title target and a status badge with text', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      'GET /api/projects': () =>
        jsonResponse(200, {
          projects: [
            {
              ...projectDetail().project,
              photoCount: 2,
              hasVoiceMemo: false,
              latestRun: { ...run('running'), status: 'awaiting_gate', gate: 'fact_conflicts' },
            },
          ],
        }),
    });
    renderPage(ProjectsPage);

    const title = await screen.findByRole('link', { name: 'Alder Falls Cottage 4' });
    expect(title.className).toContain('min-h-11');
    expect(screen.getByText('Waiting for your review')).toBeDefined();
    const runLink = screen.getByRole('link', { name: 'View run for Alder Falls Cottage 4' });
    expect(runLink.className).toContain('min-h-11');
    expect(runLink.getAttribute('href')).toBe(`/runs/${RUN_ID}`);
  });
});

describe('project and capture page states', () => {
  beforeEach(() => {
    setRoute(`/projects/${PROJECT_ID}`);
    mockRouter.query = { projectId: PROJECT_ID };
  });

  it.each([
    ['project page', ProjectPage],
    ['capture page', CapturePage],
  ])('%s: loading, then a retryable error', async (_name, Page) => {
    let attempts = 0;
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET /api/projects/${PROJECT_ID}`]: () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(500, { error: 'internal_error' })
          : jsonResponse(200, projectDetail());
      },
      'GET /api/markets/germany/1': () => jsonResponse(200, marketForm),
    });
    renderPage(Page);

    expect(await screen.findByText(/could not load this project/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: /Alder Falls Cottage 4|Capture/ }),
    ).toBeDefined();
  });

  it('project page: shows a skeleton status while the project loads', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET /api/projects/${PROJECT_ID}`]: neverResolves,
    });
    renderPage(ProjectPage);

    const status = (await screen.findByText('Loading the project…')).closest('[role=status]');
    if (status === null) throw new Error('No status region around the loading text');
    expect(status.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });

  it('project page: an ended session offers Log in with a way back here', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(401, { error: 'unauthenticated' }),
    });
    renderPage(ProjectPage);

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: 'Log in' }).getAttribute('href')).toBe(
      `/login?next=${encodeURIComponent(`/projects/${PROJECT_ID}`)}`,
    );
  });

  it('project page: previews the stored photos in the materials card', async () => {
    const detail = projectDetail();
    const photo = {
      id: '99999999-9999-4999-8999-999999999999',
      kind: 'photo',
      status: 'ready',
      position: 1,
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      width: 100,
      height: 100,
      durationMs: null,
      failureReason: null,
      createdAt: detail.project.createdAt,
    };
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      [`GET /api/projects/${PROJECT_ID}`]: () =>
        jsonResponse(200, { ...detail, materials: [photo] }),
      'GET /api/markets/germany/1': () => jsonResponse(200, marketForm),
    });
    renderPage(ProjectPage);

    const materials = await screen.findByRole('region', { name: 'Materials' });
    const preview = within(materials).getByRole('img', { name: 'Photo 1' });
    expect(preview.getAttribute('src')).toContain(photo.id);
  });
});

describe('auth screens tap targets', () => {
  beforeEach(() => setRoute('/login'));

  it('login: inputs, submit, and the text link are at least 44 px', async () => {
    mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(LoginPage);

    await screen.findByRole('heading', { level: 1, name: 'Log in' });
    for (const input of [
      screen.getByRole('textbox', { name: 'Email' }),
      screen.getByLabelText('Password'),
    ]) {
      expect(input.className).toContain('min-h-11');
    }
    const link = screen.getByRole('link', { name: 'Create an account' });
    expect(link.className).toContain('inline-flex');
    expect(link.className).toContain('min-h-11');
  });

  it('register: the log-in text link is at least 44 px', async () => {
    mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(RegisterPage);

    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Create your account');
    const link = screen
      .getAllByRole('link', { name: 'Log in' })
      .find((candidate) => candidate.className.includes('inline-flex'));
    expect(link?.className).toContain('min-h-11');
  });
});

describe('unit labels', () => {
  it('render exactly what the shared display table says', () => {
    expect(areaUnitLabel('m2')).toBe(UNIT_DISPLAY.m2);
    expect(areaUnitLabel('sq_ft')).toBe(UNIT_DISPLAY.sq_ft);
    expect(volumeUnitLabel('m3')).toBe(UNIT_DISPLAY.m3);
    expect(volumeUnitLabel('cu_ft')).toBe(UNIT_DISPLAY.cu_ft);
    expect([UNIT_DISPLAY.m2, UNIT_DISPLAY.sq_ft, UNIT_DISPLAY.m3, UNIT_DISPLAY.cu_ft]).toEqual([
      'm²',
      'sq ft',
      'm³',
      'cu ft',
    ]);
  });
});

describe('browser theme-color follows the theme choice', () => {
  const metas = (): HTMLMetaElement[] => [
    ...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
  ];
  const contents = (): (string | null)[] => metas().map((meta) => meta.getAttribute('content'));

  beforeEach(() => {
    for (const [content, media] of [
      [THEME_COLORS.light, '(prefers-color-scheme: light)'],
      [THEME_COLORS.dark, '(prefers-color-scheme: dark)'],
    ] as const) {
      const meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      meta.setAttribute('content', content);
      meta.setAttribute('media', media);
      document.head.append(meta);
    }
  });
  afterEach(() => {
    metas().forEach((meta) => meta.remove());
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
  });

  it('points both tags at the chosen theme, and System restores the media pair', () => {
    applyTheme('dark');
    expect(contents()).toEqual([THEME_COLORS.dark, THEME_COLORS.dark]);
    applyTheme('light');
    expect(contents()).toEqual([THEME_COLORS.light, THEME_COLORS.light]);
    applyTheme('system');
    expect(contents()).toEqual([THEME_COLORS.light, THEME_COLORS.dark]);
  });

  it('is applied by the init script for a stored choice, before first paint', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    runInNewContext(THEME_INIT_SCRIPT, { localStorage, document });
    expect(contents()).toEqual([THEME_COLORS.dark, THEME_COLORS.dark]);
  });

  it('does nothing without a stored choice', () => {
    runInNewContext(THEME_INIT_SCRIPT, { localStorage, document });
    expect(contents()).toEqual([THEME_COLORS.light, THEME_COLORS.dark]);
  });
});
