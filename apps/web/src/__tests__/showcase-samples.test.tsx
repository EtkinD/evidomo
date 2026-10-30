import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setRoute } from './router-mock';
import { jsonResponse } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

const { ModeProvider } = await import('../showcase/mode');
const { APPROVED_IMAGE_IDS } = await import('../showcase/assets');
const { SAMPLE_PAGES } = await import('../showcase/samples/parts');
const { SampleAuthPage } = await import('../showcase/pages/samples/AuthSamples');
const { SamplesIndexPage } = await import('../showcase/pages/samples/SamplesIndexPage');
const { SampleLandingPage } = await import('../showcase/pages/samples/LandingSamples');
const { SampleProjectPage } = await import('../showcase/pages/samples/ProjectSamples');
const { SampleProjectsPage } = await import('../showcase/pages/samples/ProjectsSamples');
const { SampleReviewPage } = await import('../showcase/pages/samples/ReviewSamples');
const { SampleRunPage } = await import('../showcase/pages/samples/RunSamples');

const item = (id: string, direction: string, kind: string, file: string, size = 1536) => ({
  id,
  direction,
  kind,
  file,
  prompt: `prompt of ${id}`,
  width: size,
  height: kind === 'hero' || kind === 'interior' ? Math.round(size * 0.667) : size,
});

const manifest = {
  generatedAt: '2026-10-30T10:00:00Z',
  toolsOff: 'generations',
  items: [
    item('B2-HERO-1', 'B2', 'hero', 'B2/hero-1.webp'),
    item('B2-INT-1', 'B2', 'interior', 'B2/interior-1.webp'),
    item('B2-INT-2', 'B2', 'interior', 'B2/interior-2.webp'),
    item('B2-ILL-1', 'B2', 'illustration', 'B2/illustration-1.webp'),
  ],
};

const realFetch = vi.fn<typeof fetch>();

function stubFetch(withManifest: boolean): void {
  realFetch.mockImplementation((input) => {
    const path =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    if (path === '/showcase-assets/manifest.json') {
      return Promise.resolve(
        withManifest ? jsonResponse(200, manifest) : new Response('nope', { status: 404 }),
      );
    }
    return Promise.reject(new Error(`Unexpected request: ${path}`));
  });
  vi.stubGlobal('fetch', realFetch);
}

function renderPage(page: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ModeProvider>{page}</ModeProvider>
    </QueryClientProvider>,
  );
}

const sampleIds = (): string[] =>
  screen
    .getAllByRole('region')
    .map((region) => /^(H-[A-Z0-9-]+)/.exec(region.getAttribute('aria-label') ?? '')?.[1])
    .filter((id): id is string => id !== undefined);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  setRoute('/');
});

describe('sample pages', () => {
  const pages: [string, () => ReactElement, string[]][] = [
    [
      'landing',
      () => <SampleLandingPage />,
      ['H-NAV-1', 'H-HERO-1', 'H-HOW-1', 'H-EVID-1', 'H-TRUST-1', 'H-CTA-1', 'H-FOOT-1'],
    ],
    ['projects', () => <SampleProjectsPage />, ['H-SHELL-1', 'H-LIST-1', 'H-EMPTY-1']],
    ['project', () => <SampleProjectPage />, ['H-MAT-1', 'H-FORM-1', 'H-READY-1']],
    ['run', () => <SampleRunPage />, ['H-RUN-1']],
    ['auth', () => <SampleAuthPage />, ['H-AUTH-1']],
  ];

  it('the overview links to every sample page', () => {
    stubFetch(false);
    renderPage(<SamplesIndexPage />);
    for (const { slug, label } of SAMPLE_PAGES) {
      const link = screen.getAllByRole('link', { name: label }).find((candidate) => {
        return candidate.getAttribute('href') === `/showcase/samples/${slug}`;
      });
      expect(link).toBeDefined();
    }
  });

  it.each(pages)('%s renders its H- IDs', (_name, page, ids) => {
    stubFetch(false);
    renderPage(page());
    for (const id of ids) expect(sampleIds()).toContain(id);
  });

  it.each(pages)(
    '%s: at most one primary button per themed view, and 44 px on every button',
    (_n, page) => {
      stubFetch(false);
      renderPage(page());
      // Each themed surface is one view.
      for (const scope of document.querySelectorAll('[data-sample]')) {
        const own = [...scope.querySelectorAll('.btn-primary')].filter(
          (button) => button.closest('[data-sample]') === scope,
        );
        expect(own.length).toBeLessThanOrEqual(1);
      }
      for (const control of document.querySelectorAll('.btn')) {
        expect(control.className).toContain('min-h-11');
      }
    },
  );

  it('shows the H-LOGO-1 lockup in the samples', () => {
    stubFetch(false);
    renderPage(<SampleAuthPage />);
    expect(screen.getAllByText('Evidomo').length).toBeGreaterThan(0);
    expect(screen.queryByRole('group', { name: /Logo in the samples/ })).toBeNull();
  });

  it('uses the product theme in light and dark, and no candidate theme', () => {
    stubFetch(false);
    const { container, unmount } = renderPage(<SampleRunPage />);
    expect(container.querySelector('[data-sample][data-theme="evidomo-light"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(container.querySelector('[data-sample][data-theme="evidomo-dark"]')).not.toBeNull();
    expect(container.querySelector('[data-direction]')).toBeNull();
    unmount();
  });

  it('run monitor: readable step names, no internal step IDs, cost against the cap', () => {
    stubFetch(false);
    renderPage(<SampleRunPage />);
    expect(screen.getByText('Reading the walkthrough')).toBeDefined();
    expect(document.body.textContent).not.toMatch(
      /extract_facts|[a-z]+_[a-z]+_?[a-z]*\b(?=.*step)/,
    );
    const cost = screen.getByRole('region', { name: 'Cost so far' });
    expect(within(cost).getByText('Visible in development only')).toBeDefined();
    expect(within(cost).getByRole('progressbar', { name: 'Cost against the cap' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Resolve conflicts' })).toBeDefined();
  });

  it('project page: the field error is linked to its input', () => {
    stubFetch(false);
    renderPage(<SampleProjectPage />);
    const input = screen.getByRole('textbox', { name: 'Energy label' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const message = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(message?.textContent).toContain('Use a label from A to G.');
  });

  it('images: approved ones render from the manifest, and placeholders when it is missing', async () => {
    stubFetch(true);
    const { unmount } = renderPage(<SampleLandingPage />);
    await waitFor(() =>
      expect(document.querySelectorAll('img[data-asset-id]').length).toBeGreaterThan(0),
    );
    for (const img of document.querySelectorAll('img[data-asset-id]')) {
      expect(APPROVED_IMAGE_IDS).toContain(img.getAttribute('data-asset-id'));
    }
    unmount();

    stubFetch(false);
    renderPage(<SampleLandingPage />);
    await waitFor(() => expect(screen.getAllByText(/not generated yet/).length).toBeGreaterThan(0));
  });
});

describe('review gates (the real views on sample data)', () => {
  it('gate 1: one conflict with form, voice turn and photo evidence, and a decision that sticks', async () => {
    stubFetch(true);
    renderPage(<SampleReviewPage />);
    const card = await screen.findByRole('group', { name: 'Rooms' });
    expect(within(card).getAllByText(/4 rooms|^4$/).length).toBeGreaterThan(0);
    // The three evidence kinds of the one card.
    expect(within(card).getAllByText('Form field').length).toBeGreaterThan(0);
    expect(within(card).getByText(/Four rooms, and a small study at the back\./)).toBeDefined();
    expect(within(card).getAllByRole('button', { name: /Play/ }).length).toBeGreaterThan(0);
    expect(
      within(card)
        .getByRole('img', { name: /Photo evidence for/ })
        .getAttribute('src'),
    ).toBe('/showcase-assets/B2/interior-1.webp');

    fireEvent.click(within(card).getByRole('button', { name: /Use this value: 5/ }));
    await waitFor(() => expect(screen.getByText(/You kept 5/)).toBeDefined());
    // No request left the sample.
    expect(
      realFetch.mock.calls.every(
        ([input]) => typeof input === 'string' && input.startsWith('/showcase-assets'),
      ),
    ).toBe(true);
  });

  it('gate 2: one flagged claim with evidence, edit and remove, decided in memory', async () => {
    stubFetch(true);
    renderPage(<SampleReviewPage />);
    const claim = await screen.findByRole('group', {
      name: /It has 4 rooms that are bright and quiet/,
    });
    expect(within(claim).getByRole('button', { name: /Approve as written/ })).toBeDefined();
    expect(within(claim).getByRole('button', { name: /Edit/ })).toBeDefined();
    expect(within(claim).getByRole('button', { name: /Remove/ })).toBeDefined();
    expect(screen.getByText(/Nothing in the facts says the rooms are quiet/)).toBeDefined();

    fireEvent.click(within(claim).getByRole('button', { name: /Approve as written/ }));
    await waitFor(() => expect(screen.getByText('Approved as written.')).toBeDefined());
  });

  it('restores fetch when the page unmounts', async () => {
    stubFetch(true);
    const { unmount } = renderPage(<SampleReviewPage />);
    await screen.findByRole('group', { name: 'Rooms' });
    expect(globalThis.fetch).not.toBe(realFetch);
    unmount();
    expect(globalThis.fetch).toBe(realFetch);
  });
});
