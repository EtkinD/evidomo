import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from './test-utils';
import { setRoute } from './router-mock';

vi.mock('next/router', () => import('./router-mock'));

const { fetchManifest, parseManifest } = await import('../showcase/assets');
const { ModeProvider } = await import('../showcase/mode');
const { bare } = await import('../showcase/bare');
const { ColorsPage } = await import('../showcase/pages/ColorsPage');
const { ComponentsPage } = await import('../showcase/pages/ComponentsPage');
const { ImageryPage } = await import('../showcase/pages/ImageryPage');
const { IndexPage } = await import('../showcase/pages/IndexPage');
const { LogoPage } = await import('../showcase/pages/LogoPage');
const { TypographyPage } = await import('../showcase/pages/TypographyPage');

const manifest = {
  generatedAt: '2026-10-30T10:00:00Z',
  toolsOff: 'generations',
  items: [
    {
      id: 'B2-HERO-1',
      direction: 'B2',
      kind: 'hero',
      file: 'B2/hero-1.webp',
      prompt: 'warm house',
      width: 1536,
      height: 1024,
    },
    {
      id: 'B2-LOGO-1',
      direction: 'B2',
      kind: 'logo-concept',
      file: 'B2/logo-1.webp',
      prompt: 'a rejected mark',
      width: 1024,
      height: 1024,
    },
    {
      id: 'B-HERO-1',
      direction: 'B',
      kind: 'hero',
      file: 'B/hero-1.webp',
      prompt: 'a rejected hero',
      width: 1536,
      height: 1024,
    },
  ],
};

function stubManifest(response: Response | Error): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response))),
  );
}

function renderPage(page: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ModeProvider>{page}</ModeProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  window.localStorage.clear();
  setRoute('/');
});

describe('asset manifest', () => {
  it('keeps only the approved images, and does not validate the rest', () => {
    const parsed = parseManifest(manifest);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.items.map((item) => item.id)).toEqual(['B2-HERO-1']);
    const withJunk = { ...manifest, items: [...manifest.items, { id: 'B3-LOGO-2', kind: 42 }] };
    expect(parseManifest(withJunk).success).toBe(true);
  });

  it('rejects an approved image of an unknown kind', () => {
    const bad = { ...manifest, items: [{ ...manifest.items[0], kind: 'photo' }] };
    expect(parseManifest(bad).success).toBe(false);
  });

  it('reports missing for a 404 and for a non-JSON body', async () => {
    stubManifest(new Response('nope', { status: 404 }));
    expect(await fetchManifest()).toEqual({ status: 'missing' });
    stubManifest(new Response('<html></html>', { status: 200 }));
    expect(await fetchManifest()).toEqual({ status: 'missing' });
  });

  it('reports invalid, not missing, for JSON of the wrong shape', async () => {
    stubManifest(jsonResponse(200, { items: 'x' }));
    expect((await fetchManifest()).status).toBe('invalid');
  });
});

describe('imagery', () => {
  it('shows a placeholder for each of the four approved images when the manifest is missing', async () => {
    stubManifest(new Response('nope', { status: 404 }));
    renderPage(<ImageryPage />);
    await waitFor(() => expect(screen.getAllByText(/not generated yet/i)).toHaveLength(4));
  });

  it('shows an alert for a malformed manifest', async () => {
    stubManifest(jsonResponse(200, { nope: true }));
    renderPage(<ImageryPage />);
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toMatch(/does not match/i);
  });

  it('shows an approved image with its ID, never an unapproved one', async () => {
    stubManifest(jsonResponse(200, manifest));
    renderPage(<ImageryPage />);
    const figure = await screen.findByRole('figure', { name: /B2-HERO-1/ });
    expect(within(figure).getByRole('img', { name: /warm house/ })).toBeDefined();
    expect(screen.queryByRole('figure', { name: /B2-LOGO-1|B-HERO-1/ })).toBeNull();
    expect(screen.getAllByText(/not generated yet/i)).toHaveLength(3);
  });

  it('swaps a broken image for the placeholder', async () => {
    stubManifest(jsonResponse(200, manifest));
    renderPage(<ImageryPage />);
    const figure = await screen.findByRole('figure', { name: /B2-HERO-1/ });
    within(figure).getByRole('img').dispatchEvent(new Event('error'));
    await waitFor(() =>
      expect(within(figure).getByText(/B2\/hero-1.webp: not generated yet/)).toBeDefined(),
    );
  });
});

describe('pages render their specimen IDs in the product theme', () => {
  const missing = (): void => stubManifest(new Response('nope', { status: 404 }));

  it('index links to every area, shows the theme specimen, and names no candidate', () => {
    missing();
    setRoute('/showcase');
    renderPage(<IndexPage />);
    for (const [name, slug] of [
      ['Colours', 'colors'],
      ['Typography', 'typography'],
      ['Logo', 'logo'],
      ['Components', 'components'],
      ['Imagery', 'imagery'],
      ['Samples', 'samples'],
    ] as const) {
      const links = screen.getAllByRole('link', { name });
      expect(links.some((link) => link.getAttribute('href') === `/showcase/${slug}`)).toBe(true);
    }
    expect(screen.getByRole('figure', { name: /H-THEME-1/ })).toBeDefined();
    expect(screen.queryByRole('link', { name: 'Compare' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Ledger|Signal|B3 Hearth|candidate/i);
  });

  it('colors: light and dark palettes with every contrast row passing', () => {
    missing();
    renderPage(<ColorsPage />);
    for (const id of ['H-COL-1', 'H-COL-2', 'H-SHAPE-1']) {
      expect(screen.getByRole('figure', { name: new RegExp(id) })).toBeDefined();
    }
    expect(screen.queryAllByText('Fail')).toHaveLength(0);
    // 23 pairs per palette, two palettes.
    expect(screen.getAllByText('Pass')).toHaveLength(46);
  });

  it('typography: scale and Dutch/English sample', () => {
    missing();
    renderPage(<TypographyPage />);
    for (const id of ['H-TYPE-1', 'H-TYPE-2']) {
      expect(screen.getByRole('figure', { name: new RegExp(id) })).toBeDefined();
    }
    expect(document.querySelectorAll('article[lang="nl"]')).toHaveLength(1);
    expect(document.querySelectorAll('article[lang="en"]')).toHaveLength(1);
  });

  it('logo: H-LOGO-1 as the product component and the committed static files', () => {
    missing();
    renderPage(<LogoPage />);
    const figure = screen.getByRole('figure', { name: /H-LOGO-1/ });
    expect(figure.querySelectorAll('[data-theme="evidomo-light"]').length).toBeGreaterThan(0);
    expect(figure.querySelectorAll('[data-theme="evidomo-dark"]').length).toBeGreaterThan(0);
    // The product component: the lockup text is live, the mark alone has the name.
    expect(within(figure).getAllByText('Evidomo').length).toBeGreaterThanOrEqual(4);
    expect(within(figure).getAllByRole('img', { name: 'Evidomo' })).toHaveLength(2);
    for (const px of ['16 px', '24 px', '32 px', '48 px']) {
      expect(within(figure).getByText(px)).toBeDefined();
    }
    const sources = within(figure)
      .getAllByRole('img')
      .map((img) => img.getAttribute('src'))
      .filter((src) => src !== null);
    for (const file of [
      '/favicon.svg',
      '/favicon.ico',
      '/apple-touch-icon.png',
      '/icon-192.png',
      '/icon-512.png',
      '/icon-maskable-512.png',
      '/brand/evidomo-lockup-light.svg',
      '/brand/evidomo-lockup-dark.svg',
      '/og.png',
    ]) {
      expect(sources).toContain(file);
    }
    expect(screen.queryByText(/H-LOGO-[23]|B3-LOGO/)).toBeNull();
  });

  it('components: every block, with the 44 px class on buttons', () => {
    missing();
    renderPage(<ComponentsPage />);
    for (const slug of ['BTN', 'INP', 'BDG', 'ALR', 'CARD', 'EVD', 'RUN', 'CNF']) {
      expect(screen.getByRole('figure', { name: new RegExp(`H-${slug}-1`) })).toBeDefined();
    }
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('min-h-11');
    }
    expect(screen.getByRole('textbox', { name: 'Energy label' }).getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('the mode switch applies to the next render and is remembered', () => {
    missing();
    const { container, unmount } = renderPage(<IndexPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(container.querySelector('[data-theme="evidomo-dark"]')).not.toBeNull();
    expect(container.querySelector('[data-theme="evidomo-light"]')).not.toBeNull(); // the specimen
    unmount();
    const again = renderPage(<IndexPage />);
    expect(
      again.container.querySelector('div[data-theme="evidomo-dark"].min-h-dvh'),
    ).not.toBeNull();
  });

  it('a route page wrapped by bare() mounts its own mode provider, so the switch works', () => {
    missing();
    const Route = bare(IndexPage);
    expect(Route.bare).toBe(true);
    const queryClient = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <Route />
      </QueryClientProvider>,
    );
    // The module-level fallback keeps an earlier test's choice, so start from an explicit one.
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(container.querySelector('.min-h-dvh')?.getAttribute('data-theme')).toBe('evidomo-light');
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(container.querySelector('.min-h-dvh')?.getAttribute('data-theme')).toBe('evidomo-dark');
  });
});
