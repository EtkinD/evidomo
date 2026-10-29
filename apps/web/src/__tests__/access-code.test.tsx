import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { humanizeWait } from '../lib/access-code';
import ProjectPage from '../pages/projects/[projectId]';
import { PROJECT_ID, RUN_ID, marketForm, projectDetail, run } from './project-fixtures';
import { mockRouter, setRoute } from './router-mock';
import { jsonResponse, meSignedIn, mockFetch, renderPage, type FetchCall } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

const START = `POST /api/projects/${PROJECT_ID}/runs`;
const STORAGE_KEY = 'evidomo.liveRunAccessCode';

async function openReady(handler: (call: FetchCall) => Response): Promise<void> {
  setRoute(`/projects/${PROJECT_ID}`);
  mockRouter.query = { projectId: PROJECT_ID };
  mockFetch({
    'GET /api/auth/me': meSignedIn,
    [`GET /api/projects/${PROJECT_ID}`]: () =>
      jsonResponse(200, projectDetail({ canStartRun: true, missing: [] })),
    'GET /api/markets/germany/1': () => jsonResponse(200, marketForm),
    [START]: handler,
  });
  renderPage(ProjectPage);
  await screen.findByLabelText(/Living area/);
}

const codeField = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>('Access code');
const type = (value: string): void => {
  fireEvent.change(codeField(), { target: { value } });
};
const start = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
};

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('access code on Start run', () => {
  it('is a password field with a show toggle', async () => {
    await openReady(() => jsonResponse(201, { run: run('running') }));

    expect(codeField().type).toBe('password');
    const toggle = screen.getByRole('button', { name: 'Show access code' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(codeField().type).toBe('text');
    expect(
      screen.getByRole('button', { name: 'Hide access code' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('sends the trimmed code, remembers it for the session, and opens the run', async () => {
    let sent: unknown;
    await openReady((call) => {
      sent = call.body;
      return jsonResponse(201, { run: run('running') });
    });

    type('  open sesame ');
    start();

    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(`/runs/${RUN_ID}`));
    expect(sent).toEqual({ accessCode: 'open sesame' });
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('open sesame');
  });

  it('sends an empty body when no code was entered', async () => {
    let sent: unknown;
    await openReady((call) => {
      sent = call.body;
      return jsonResponse(201, { run: run('running') });
    });

    start();

    await waitFor(() => expect(mockRouter.push).toHaveBeenCalled());
    expect(sent).toEqual({});
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('prefills the field from the session', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'remembered');
    await openReady(() => jsonResponse(201, { run: run('running') }));

    await waitFor(() => expect(codeField().value).toBe('remembered'));
  });

  it('still starts the run when sessionStorage throws', async () => {
    const blocked = new DOMException('blocked', 'SecurityError');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw blocked;
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw blocked;
    });
    let sent: unknown;
    await openReady((call) => {
      sent = call.body;
      return jsonResponse(201, { run: run('running') });
    });

    expect(codeField().value).toBe('');
    type('code-1');
    start();

    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(`/runs/${RUN_ID}`));
    expect(sent).toEqual({ accessCode: 'code-1' });
    vi.restoreAllMocks();
  });

  it('shows a field error on access_code_invalid and forgets the stored code', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'stale');
    await openReady(() => jsonResponse(403, { error: 'access_code_invalid' }));
    await waitFor(() => expect(codeField().value).toBe('stale'));

    start();

    const message = await screen.findByText('This access code is not valid.');
    expect(codeField().getAttribute('aria-invalid')).toBe('true');
    expect(codeField().getAttribute('aria-describedby')).toContain(message.id);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(mockRouter.push).not.toHaveBeenCalled();
    // Editing the code clears the error, and the run can be retried.
    type('fresh');
    expect(screen.queryByText('This access code is not valid.')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Start run' }).disabled).toBe(
      false,
    );
  });

  it('explains rate_limited as too many wrong codes', async () => {
    await openReady(() => jsonResponse(429, { error: 'rate_limited' }));

    start();

    expect(await screen.findByText('Too many wrong codes, try again later.')).toBeDefined();
  });

  it('explains run_limit_reached with the humanized Retry-After', async () => {
    await openReady(() =>
      jsonResponse(429, { error: 'run_limit_reached' }, { 'Retry-After': '7200' }),
    );

    start();

    expect(await screen.findByText(/You have reached today.s live run limit\./)).toBeDefined();
    expect(screen.getByText(/in about 2 hours\./)).toBeDefined();
  });

  it('explains run_limit_reached without a usable Retry-After', async () => {
    await openReady(() => jsonResponse(429, { error: 'run_limit_reached' }));

    start();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("You have reached today's live run limit.");
  });

  it('keeps the existing error states', async () => {
    await openReady(() => jsonResponse(409, { error: 'daily_budget_reached' }));

    start();

    expect(await screen.findByText(/run budget has been used up/)).toBeDefined();
  });
});

describe('humanizeWait', () => {
  it.each([
    [30, 'a minute'],
    [300, '5 minutes'],
    [3000, '50 minutes'],
    [3600, 'about an hour'],
    [3601, 'about 2 hours'],
    [10_800, 'about 3 hours'],
    [90_000, 'about 2 days'],
  ])('%i seconds -> %s', (seconds, text) => {
    expect(humanizeWait(seconds)).toBe(text);
  });
});
