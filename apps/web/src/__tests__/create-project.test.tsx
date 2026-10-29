import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NewProjectPage from '../pages/projects/new';
import { PROJECT_ID, marketList, projectDetail } from './project-fixtures';
import { mockRouter, setRoute } from './router-mock';
import { jsonResponse, meSignedIn, mockFetch, renderPage, type FetchCall } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function renderForm(extra: Record<string, (call: FetchCall) => Response> = {}) {
  const fetchMock = mockFetch({
    'GET /api/auth/me': meSignedIn,
    'GET /api/markets': () => jsonResponse(200, marketList),
    ...extra,
  });
  renderPage(NewProjectPage);
  await screen.findByRole('button', { name: 'Create project' });
  return fetchMock;
}

describe('new project page', () => {
  beforeEach(() => setRoute('/projects/new'));

  it('limits the output language to the market and defaults to its default language', async () => {
    await renderForm();

    const market = screen.getByRole('combobox', { name: /Market/ });
    const language = screen.getByRole('combobox', { name: /Output language/ });
    expect((market as HTMLSelectElement).value).toBe('germany@1');
    expect((language as HTMLSelectElement).value).toBe('de');
    expect(Array.from((language as HTMLSelectElement).options).map((o) => o.text)).toEqual([
      'German',
      'English',
    ]);

    // Picking another language sticks until the market changes.
    fireEvent.change(language, { target: { value: 'en' } });
    expect((language as HTMLSelectElement).value).toBe('en');

    fireEvent.change(market, { target: { value: 'uk@1' } });
    expect(Array.from((language as HTMLSelectElement).options).map((o) => o.text)).toEqual([
      'English',
    ]);
    expect((language as HTMLSelectElement).value).toBe('en');

    // Back to a market whose default differs: the earlier override ('en') is still offered.
    fireEvent.change(market, { target: { value: 'germany@1' } });
    expect((language as HTMLSelectElement).value).toBe('en');
  });

  it('validates on the client, focuses the first invalid field, and sends nothing', async () => {
    const fetchMock = await renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    const title = screen.getByLabelText(/Project title/);
    expect(document.activeElement).toBe(title);
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter a project title.')).toBeDefined();
    expect(screen.getByText('Enter your agency name.')).toBeDefined();
    expect(title.getAttribute('aria-describedby')).toBe(
      screen.getByText('Enter a project title.').id,
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('rejects an over-long contact block', async () => {
    await renderForm();
    fill('Project title (required)', 'Alder Falls Cottage 4');
    fill('Agency name (required)', 'Fictional Realty Co');
    fill('Contact block', 'x'.repeat(2001));

    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    expect(screen.getByText('Use at most 2000 characters for the contact block.')).toBeDefined();
  });

  it('creates the project with the trimmed profile and goes to the project page', async () => {
    let sent: unknown;
    await renderForm({
      'POST /api/projects': (call) => {
        sent = call.body;
        return jsonResponse(201, projectDetail());
      },
    });

    fill('Project title (required)', '  Alder Falls Cottage 4 ');
    fill('Agency name (required)', 'Fictional Realty Co');
    fill('Contact block', '1 Example Row\nAlder Falls\nhello@example.invalid');
    fill('Tone', '   ');
    fireEvent.change(screen.getByLabelText(/Output language/), { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(`/projects/${PROJECT_ID}`));
    expect(sent).toEqual({
      title: 'Alder Falls Cottage 4',
      officeProfile: {
        agencyName: 'Fictional Realty Co',
        contactBlock: '1 Example Row\nAlder Falls\nhello@example.invalid',
      },
      market: { id: 'germany', version: 1 },
      outputLanguage: 'en',
    });
  });

  it('maps server validation issues onto the fields', async () => {
    await renderForm({
      'POST /api/projects': () =>
        jsonResponse(400, {
          error: 'validation_failed',
          issues: [
            { path: ['officeProfile', 'tone'], message: 'Too long' },
            { path: ['outputLanguage'], message: 'Not offered' },
          ],
        }),
    });
    fill('Project title (required)', 'Alder Falls Cottage 4');
    fill('Agency name (required)', 'Fictional Realty Co');
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByText('Use at most 200 characters for the tone.')).toBeDefined();
    expect(screen.getByText('Choose one of the languages this market offers.')).toBeDefined();
    expect(screen.getByLabelText('Tone').getAttribute('aria-invalid')).toBe('true');
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('shows a form-level message for other failures', async () => {
    await renderForm({
      'POST /api/projects': () => jsonResponse(500, { error: 'internal_error' }),
    });
    fill('Project title (required)', 'Alder Falls Cottage 4');
    fill('Agency name (required)', 'Fictional Realty Co');
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    expect(
      (await screen.findByText(/Something went wrong on our side/)).closest('[role=alert]'),
    ).not.toBeNull();
  });
});

describe('new project page: double submit', () => {
  beforeEach(() => setRoute('/projects/new'));

  it('sends one request when the form is submitted twice', async () => {
    const fetchMock = await renderForm({
      'POST /api/projects': () => jsonResponse(201, projectDetail()),
    });
    fill('Project title (required)', 'Alder Falls Cottage 4');
    fill('Agency name (required)', 'Fictional Realty Co');

    const form = screen.getByLabelText('Agency name (required)').closest('form') as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledTimes(1));
    fireEvent.submit(form);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('clears a field error when that field changes', async () => {
    await renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    const title = screen.getByLabelText(/Project title/);
    expect(title.getAttribute('aria-invalid')).toBe('true');

    fill('Project title (required)', 'A');

    expect(title.getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByText('Enter a project title.')).toBeNull();
    expect(screen.getByText('Enter your agency name.')).toBeDefined();
  });
});
