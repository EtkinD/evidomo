import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectsPage from '../pages/projects';
import { PROJECT_ID, RUN_ID, projectDetail, run } from './project-fixtures';
import { setRoute } from './router-mock';
import { jsonResponse, meSignedIn, mockFetch, renderPage } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

function summary(overrides: Record<string, unknown> = {}) {
  const { project } = projectDetail();
  return {
    ...project,
    photoCount: 4,
    hasVoiceMemo: true,
    latestRun: run('completed'),
    ...overrides,
  };
}

describe('projects page', () => {
  beforeEach(() => setRoute('/projects'));

  it('lists projects with market, counts, and the latest run linking to the run monitor', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      'GET /api/projects': () =>
        jsonResponse(200, {
          projects: [
            summary(),
            summary({
              id: '11111111-2222-4333-8444-555555555555',
              title: 'Mill Pond 3',
              photoCount: 1,
              hasVoiceMemo: false,
              latestRun: null,
              market: { id: 'germany', version: 1, name: null },
            }),
          ],
        }),
    });
    renderPage(ProjectsPage);

    // The footer's language list is a list too: wait for the projects before reading items.
    await screen.findByRole('link', { name: 'Alder Falls Cottage 4' });
    const items = screen.getAllByRole('listitem');
    const first = items.find((item) =>
      within(item).queryByRole('link', { name: 'Alder Falls Cottage 4' }),
    );
    expect(first).toBeDefined();
    const firstScope = within(first as HTMLElement);
    expect(firstScope.getByText('Germany · German')).toBeDefined();
    expect(firstScope.getByText('4 photos')).toBeDefined();
    expect(firstScope.getByText('Voice memo: yes')).toBeDefined();
    expect(firstScope.getByText('Completed')).toBeDefined();
    expect(
      firstScope
        .getByRole('link', { name: 'View run for Alder Falls Cottage 4' })
        .getAttribute('href'),
    ).toBe(`/runs/${RUN_ID}`);
    expect(
      firstScope.getByRole('link', { name: 'Alder Falls Cottage 4' }).getAttribute('href'),
    ).toBe(`/projects/${PROJECT_ID}`);

    // A degraded entry (unknown market version) and a project without a run still render.
    expect(screen.getByText('Unknown market · German')).toBeDefined();
    expect(screen.getByText('1 photo')).toBeDefined();
    expect(screen.getByText('Voice memo: no')).toBeDefined();
    expect(screen.getByText('No run yet')).toBeDefined();
    expect(screen.getByRole('link', { name: 'New project' }).getAttribute('href')).toBe(
      '/projects/new',
    );
  });

  it('shows the empty state with a New project call to action', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      'GET /api/projects': () => jsonResponse(200, { projects: [] }),
    });
    renderPage(ProjectsPage);

    expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'New project' }).getAttribute('href')).toBe(
      '/projects/new',
    );
  });

  it('reports a load failure and retries', async () => {
    let attempts = 0;
    mockFetch({
      'GET /api/auth/me': meSignedIn,
      'GET /api/projects': () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(500, { error: 'internal_error' })
          : jsonResponse(200, { projects: [] });
      },
    });
    renderPage(ProjectsPage);

    const alert = await screen.findByText(/could not load your projects/);
    expect(alert).toBeDefined();
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeDefined();
  });
});
