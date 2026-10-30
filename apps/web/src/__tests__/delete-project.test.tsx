import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFlash } from '../lib/flash';
import ProjectPage from '../pages/projects/[projectId]';
import ProjectsPage from '../pages/projects';
import { PROJECT_ID, RUN_ID, marketForm, projectDetail } from './project-fixtures';
import { mockRouter, setRoute } from './router-mock';
import { jsonResponse, meSignedIn, mockFetch, renderPage, type FetchCall } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

type Handler = (call: FetchCall) => Response;

// jsdom has no modal <dialog>: model the two methods the component uses.
beforeEach(() => {
  clearFlash();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function openPage(del: Handler, detail = projectDetail()) {
  setRoute(`/projects/${PROJECT_ID}`);
  mockRouter.query = { projectId: PROJECT_ID };
  mockRouter.push.mockClear();
  mockFetch({
    'GET /api/auth/me': meSignedIn,
    [`GET /api/projects/${PROJECT_ID}`]: () => jsonResponse(200, detail),
    'GET /api/markets/germany/1': () => jsonResponse(200, marketForm),
    [`DELETE /api/projects/${PROJECT_ID}`]: del,
  });
  renderPage(ProjectPage);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete project…' }));
  return screen.getByRole('dialog', { name: /Delete “Alder Falls Cottage 4”\?/ });
}

describe('delete project', () => {
  it('names the project, lists what goes, and starts on the safe button', async () => {
    const dialog = await openPage(() => new Response(null, { status: 204 }));
    expect(within(dialog).getByText('all of its photos')).toBeDefined();
    expect(within(dialog).getByText('the voice memo')).toBeDefined();
    expect(within(dialog).getByText(/every run and every listing pack/)).toBeDefined();
    expect(within(dialog).getByText(/Records of what the runs cost stay with/)).toBeDefined();
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Keep project' }),
    );
  });

  it('Keep project closes the dialog and deletes nothing', async () => {
    const calls: string[] = [];
    const dialog = await openPage((call) => {
      calls.push(call.method);
      return new Response(null, { status: 204 });
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep project' }));
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('deletes, goes to the projects list, and the list says so', async () => {
    const dialog = await openPage(() => new Response(null, { status: 204 }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => {
      expect(mockRouter.push).toHaveBeenCalledWith('/projects');
    });

    mockFetch({
      'GET /api/auth/me': meSignedIn,
      'GET /api/projects': () => jsonResponse(200, { projects: [] }),
    });
    renderPage(ProjectsPage);
    expect(await screen.findByText('“Alder Falls Cottage 4” was deleted.')).toBeDefined();
  });

  it('409 run_in_progress: explains and offers the run monitor, keeps the project', async () => {
    const dialog = await openPage(
      () => jsonResponse(409, { error: 'run_in_progress' }),
      projectDetail({ activeRunId: RUN_ID }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('A run is in progress for this project');
    expect(
      within(alert).getByRole('link', { name: 'Open the run monitor' }).getAttribute('href'),
    ).toBe(`/runs/${RUN_ID}`);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Delete permanently' })
        .disabled,
    ).toBe(false);
  });

  it('404: says the project was already deleted and links to the list', async () => {
    const dialog = await openPage(() => jsonResponse(404, { error: 'not_found' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    expect(await within(dialog).findByText('This project was already deleted.')).toBeDefined();
    expect(
      within(dialog).getByRole('link', { name: 'Go to your projects' }).getAttribute('href'),
    ).toBe('/projects');
  });

  it('a network failure keeps the dialog open with a message', async () => {
    const dialog = await openPage(() => {
      throw new TypeError('Failed to fetch');
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Could not reach');
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});
