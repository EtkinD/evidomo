import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import { AppShell } from '../components/AppShell';
import { AuthGate } from '../components/AuthGate';
import type { NextPageWithAuth } from '../lib/page-auth';

export const TEST_USER = {
  id: '6f1c2a9e-4b7d-4c1a-9e2f-0a1b2c3d4e5f',
  email: 'agent@example.test',
} as const;

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export interface FetchCall {
  method: string;
  path: string;
  init: RequestInit | undefined;
  body: unknown;
}

type Handler = (call: FetchCall) => Response | Promise<Response>;

/** Replaces `fetch` (the network boundary) with a handler keyed on "METHOD /path". */
export function mockFetch(routes: Record<string, Handler>): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const path =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? 'GET';
    const handler = routes[`${method} ${path}`];
    if (handler === undefined) {
      return Promise.reject(new Error(`Unexpected request: ${method} ${path}`));
    }
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return Promise.resolve(handler({ method, path, init, body }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export const meSignedOut = (): Response => jsonResponse(401, { error: 'unauthenticated' });
export const meSignedIn = (): Response => jsonResponse(200, { user: TEST_USER });

/** Renders a page the way `_app` does: shell, per-page auth gate, a fresh query cache. */
export function renderPage(Page: NextPageWithAuth): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AppShell>
        <AuthGate mode={Page.auth}>
          <Page />
        </AuthGate>
      </AppShell>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}
