import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { meQueryKey } from '../lib/auth';
import LoginPage from '../pages/login';
import RegisterPage from '../pages/register';
import { mockRouter, setRoute } from './router-mock';
import {
  jsonResponse,
  meSignedOut,
  mockFetch,
  renderPage,
  TEST_USER,
  type FetchCall,
} from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

const VALID_PASSWORD = 'correct horse battery';

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function findSubmit(name: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name });
}

describe('login page', () => {
  beforeEach(() => {
    setRoute('/login?next=%2Fprojects');
  });

  it('labels its fields with the right autocomplete hints', async () => {
    mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(LoginPage);

    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'Email' }).getAttribute('autocomplete')).toBe(
      'email',
    );
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
    expect(screen.getByRole('link', { name: 'Create an account' }).getAttribute('href')).toBe(
      '/register?next=%2Fprojects',
    );
  });

  it('validates on the client and focuses the first invalid field without calling the API', async () => {
    const fetchMock = mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(LoginPage);

    fireEvent.click(await findSubmit('Log in'));

    const email = screen.getByRole('textbox', { name: 'Email' });
    expect(document.activeElement).toBe(email);
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter your email address.')).toBeDefined();
    expect(screen.getByText('Enter your password.')).toBeDefined();
    // Only the session check went out.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fill('Email', 'agent@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Password'));
    expect(screen.getByLabelText('Password').getAttribute('aria-describedby')).toBe(
      screen.getByText('Enter your password.').id,
    );
  });

  it('rejects a malformed email with a specific message', async () => {
    mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(LoginPage);
    await findSubmit('Log in');

    fill('Email', 'not-an-email');
    fill('Password', VALID_PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(
      screen.getByText('Enter a valid email address, such as name@example.com.'),
    ).toBeDefined();
  });

  it('shows a generic message for invalid credentials', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      'POST /api/auth/login': () => jsonResponse(401, { error: 'invalid_credentials' }),
    });
    renderPage(LoginPage);
    await findSubmit('Log in');

    fill('Email', 'agent@example.test');
    fill('Password', 'wrong password');
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Email or password is incorrect.');
  });

  it('shows the wait time from Retry-After when rate limited', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      'POST /api/auth/login': () =>
        jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '540' }),
    });
    renderPage(LoginPage);
    await findSubmit('Log in');

    fill('Email', 'agent@example.test');
    fill('Password', VALID_PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many attempts. Try again in 9 minutes.',
    );
  });

  it('reports a network failure', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      'POST /api/auth/login': () => Promise.reject(new TypeError('Failed to fetch')),
    });
    renderPage(LoginPage);
    await findSubmit('Log in');

    fill('Email', 'agent@example.test');
    fill('Password', VALID_PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not reach Evidomo. Check your connection and try again.',
    );
  });

  it('sends the normalized email, disables submit while pending, then goes to next', async () => {
    let release: (response: Response) => void = () => undefined;
    const sent: FetchCall[] = [];
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      'POST /api/auth/login': (call) => {
        sent.push(call);
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      },
    });
    const { queryClient } = renderPage(LoginPage);
    await findSubmit('Log in');

    fill('Email', '  Agent@Example.TEST ');
    fill('Password', VALID_PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Log in' }).hasAttribute('disabled')).toBe(true);
    });
    expect(sent[0]?.body).toEqual({ email: 'agent@example.test', password: VALID_PASSWORD });

    release(jsonResponse(200, { user: TEST_USER }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/projects');
    });
    expect(queryClient.getQueryData(meQueryKey)).toEqual(TEST_USER);
  });

  it('ignores an unsafe next and goes home after login', async () => {
    setRoute('/login?next=%2F%2Fevil.example');
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      'POST /api/auth/login': () => jsonResponse(200, { user: TEST_USER }),
    });
    renderPage(LoginPage);
    await findSubmit('Log in');
    expect(screen.getByRole('link', { name: 'Create an account' }).getAttribute('href')).toBe(
      '/register',
    );

    fill('Email', 'agent@example.test');
    fill('Password', VALID_PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/');
    });
  });
});

describe('register page', () => {
  beforeEach(() => {
    setRoute('/register?next=%2Fprojects');
  });

  it('asks for a new password of the minimum length', async () => {
    const fetchMock = mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(RegisterPage);
    await findSubmit('Create account');

    const password = screen.getByLabelText('Password');
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    expect(screen.getByText('At least 12 characters.')).toBeDefined();

    fill('Email', 'agent@example.test');
    fill('Password', 'short');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(document.activeElement).toBe(password);
    expect(screen.getByText('Use at least 12 characters.')).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows email_taken next to the email field with a link to log in', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      'POST /api/auth/register': () => jsonResponse(409, { error: 'email_taken' }),
    });
    renderPage(RegisterPage);
    await findSubmit('Create account');

    fill('Email', 'agent@example.test');
    fill('Password', VALID_PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    const link = await screen.findByRole('link', { name: 'Log in instead' });
    expect(link.getAttribute('href')).toBe('/login?next=%2Fprojects');
    const email = screen.getByRole('textbox', { name: 'Email' });
    expect(document.activeElement).toBe(email);
    expect(email.getAttribute('aria-invalid')).toBe('true');
  });

  it('maps validation_failed issues from the API to fields', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      'POST /api/auth/register': () =>
        jsonResponse(400, {
          error: 'validation_failed',
          issues: [
            { path: ['password'], message: 'Too small: expected string to have >=12 characters' },
          ],
        }),
    });
    renderPage(RegisterPage);
    await findSubmit('Create account');

    fill('Email', 'agent@example.test');
    fill('Password', VALID_PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Use 12 to 256 characters.')).toBeDefined();
    expect(document.activeElement).toBe(screen.getByLabelText('Password'));
  });

  it('signs the user in and goes to next', async () => {
    mockFetch({
      'GET /api/auth/me': meSignedOut,
      'POST /api/auth/register': () => jsonResponse(201, { user: TEST_USER }),
    });
    const { queryClient } = renderPage(RegisterPage);
    await findSubmit('Create account');

    fill('Email', 'agent@example.test');
    fill('Password', VALID_PASSWORD);
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/projects');
    });
    expect(queryClient.getQueryData(meQueryKey)).toEqual(TEST_USER);
  });
});
