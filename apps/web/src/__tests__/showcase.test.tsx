import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from './test-utils';
import { setRoute } from './router-mock';

vi.mock('next/router', () => import('./router-mock'));
vi.mock('../showcase/fonts', () => ({ FONT_VARIABLE_CLASSES: '' }));

const { fetchManifest, parseManifest } = await import('../showcase/assets');
const { ModeProvider } = await import('../showcase/mode');
const { bare } = await import('../showcase/bare');
const { ColorsPage } = await import('../showcase/pages/ColorsPage');
const { ComparePage } = await import('../showcase/pages/ComparePage');
const { ComponentsPage } = await import('../showcase/pages/ComponentsPage');
const { ImageryPage } = await import('../showcase/pages/ImageryPage');
const { IndexPage } = await import('../showcase/pages/IndexPage');
const { LandingPage } = await import('../showcase/pages/LandingPage');
const { LogoPage } = await import('../showcase/pages/LogoPage');
const { TypographyPage } = await import('../showcase/pages/TypographyPage');

const manifest = {
  generatedAt: '2026-10-30T10:00:00Z',
  toolsOff: 'generations',
  items: [
    {
      id: 'B2-LOGO-1',
      direction: 'B2',
      kind: 'logo-concept',
      file: 'B2/logo-1.webp',
      prompt: 'a mark',
      width: 1024,
      height: 1024,
    },
    {
      id: 'B-HERO-1',
      direction: 'B',
      kind: 'hero',
      file: 'B/hero-1.webp',
      prompt: 'warm house',
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
  it('accepts the documented shape', () => {
    expect(parseManifest(manifest).success).toBe(true);
  });

  it('rejects an unknown kind or direction', () => {
    const bad = { ...manifest, items: [{ ...manifest.items[0], kind: 'photo' }] };
    expect(parseManifest(bad).success).toBe(false);
    for (const direction of ['A', 'C', 'D']) {
      const bad2 = { ...manifest, items: [{ ...manifest.items[0], direction }] };
      expect(parseManifest(bad2).success).toBe(false);
    }
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

describe('placeholders', () => {
  it('shows "not generated yet" for every asset area when the manifest is missing', async () => {
    stubManifest(new Response('nope', { status: 404 }));
    renderPage(<ImageryPage />);
    await waitFor(() => expect(screen.getAllByText(/not generated yet/i)).toHaveLength(9));
  });

  it('shows an alert for a malformed manifest', async () => {
    stubManifest(jsonResponse(200, { nope: true }));
    renderPage(<ImageryPage />);
    expect((await screen.findAllByRole('alert'))[0]?.textContent).toMatch(/does not match/i);
  });

  it('shows a manifest image with its ID, and placeholders for the areas with none', async () => {
    stubManifest(jsonResponse(200, manifest));
    renderPage(<ImageryPage />);
    const figure = await screen.findByRole('figure', { name: /B-HERO-1/ });
    expect(within(figure).getByRole('img', { name: /warm house/ })).toBeDefined();
    expect(screen.getAllByText(/not generated yet/i).length).toBe(8);
  });

  it('swaps a broken image for the placeholder', async () => {
    stubManifest(jsonResponse(200, manifest));
    renderPage(<LogoPage />);
    const figure = await screen.findByRole('figure', { name: /B2-LOGO-1/ });
    const image = within(figure).getByRole('img');
    image.dispatchEvent(new Event('error'));
    await waitFor(() =>
      expect(within(figure).getByText(/B2\/logo-1.webp: not generated yet/)).toBeDefined(),
    );
  });
});

describe('sub-pages render their candidate IDs', () => {
  const missing = (): void => stubManifest(new Response('nope', { status: 404 }));

  it('index links to every area and explains feedback by ID', () => {
    missing();
    setRoute('/showcase');
    renderPage(<IndexPage />);
    for (const name of [
      'Colours',
      'Typography',
      'Logo',
      'Components',
      'Imagery',
      'Landing',
      'Compare',
    ]) {
      const links = screen.getAllByRole('link', { name });
      expect(
        links.some(
          (link) =>
            link.getAttribute('href') ===
            `/showcase/${name.toLowerCase().replace('colours', 'colors')}`,
        ),
      ).toBe(true);
    }
    expect(screen.getByText(/stable ID/i)).toBeDefined();
    for (const name of ['B Hearth', 'B2 Hearth Clay', 'B3 Hearth Canal']) {
      expect(screen.getByRole('heading', { name })).toBeDefined();
    }
    expect(screen.queryByText(/Ledger|Signal/)).toBeNull();
  });

  it('colors: two palettes per direction, all contrast rows passing', () => {
    missing();
    renderPage(<ColorsPage />);
    for (const id of ['B-COL-1', 'B-COL-2', 'B2-COL-1', 'B2-COL-2', 'B3-COL-1', 'B3-COL-2']) {
      expect(screen.getByRole('figure', { name: new RegExp(id) })).toBeDefined();
    }
    expect(screen.queryAllByText('Fail')).toHaveLength(0);
    expect(screen.getAllByText('Pass').length).toBeGreaterThan(100);
  });

  it('typography: scale and Dutch/English sample per direction', () => {
    missing();
    renderPage(<TypographyPage />);
    for (const id of ['B-TYPE-1', 'B-TYPE-2', 'B2-TYPE-1', 'B2-TYPE-2', 'B3-TYPE-1', 'B3-TYPE-2']) {
      expect(screen.getByRole('figure', { name: new RegExp(id) })).toBeDefined();
    }
    expect(document.querySelectorAll('article[lang="nl"]')).toHaveLength(3);
    expect(document.querySelectorAll('article[lang="en"]')).toHaveLength(3);
  });

  it('logo: two SVG candidates per direction', () => {
    missing();
    renderPage(<LogoPage />);
    for (const id of ['B-SVG-1', 'B-SVG-2', 'B2-SVG-1', 'B2-SVG-2', 'B3-SVG-1', 'B3-SVG-2']) {
      expect(screen.getByRole('figure', { name: new RegExp(id) })).toBeDefined();
    }
  });

  it('components: every block per direction, with 44 px class on buttons', () => {
    missing();
    renderPage(<ComponentsPage />);
    for (const direction of ['B', 'B2', 'B3']) {
      for (const slug of ['BTN', 'INP', 'BDG', 'ALR', 'CARD', 'EVD', 'RUN', 'CNF']) {
        expect(
          screen.getByRole('figure', { name: new RegExp(`${direction}-${slug}-1`) }),
        ).toBeDefined();
      }
    }
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('min-h-11');
    }
    expect(
      screen.getAllByRole('textbox', { name: 'Energy label' })[0]?.getAttribute('aria-invalid'),
    ).toBe('true');
  });

  it('landing: a draft per direction with a placeholder hero when assets are missing', async () => {
    missing();
    renderPage(<LandingPage />);
    for (const id of ['B-LAND-1', 'B2-LAND-1', 'B3-LAND-1']) {
      expect(screen.getByRole('figure', { name: new RegExp(id) })).toBeDefined();
    }
    await waitFor(() =>
      expect(screen.getAllByText(/Muse hero: not generated yet/)).toHaveLength(3),
    );
  });

  it('compare: the same six items for B, B2 and B3, switching IDs with the mode', () => {
    missing();
    const { unmount } = renderPage(<ComparePage />);
    for (const direction of ['B', 'B2', 'B3']) {
      for (const suffix of ['COL-1', 'TYPE-1', 'BTN-1', 'EVD-1', 'SVG-1', 'LAND-1']) {
        expect(
          screen.getByRole('figure', { name: new RegExp(`${direction}-${suffix}`) }),
        ).toBeDefined();
      }
    }
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Palette strip',
      'Type pairing',
      'Buttons',
      'Evidence card',
      'Logo',
      'Landing hero',
    ]);
    // Primary, outline, and destructive buttons per direction; all keep the 44 px class.
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(3);
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('min-h-11');
    }
    unmount();

    window.localStorage.setItem('evidomo-showcase-mode', 'dark');
    renderPage(<ComparePage />);
    expect(screen.getByRole('figure', { name: /B3-COL-2/ })).toBeDefined();
  });

  it('the mode switch applies to the next render and is remembered', () => {
    missing();
    const { container, unmount } = renderPage(<IndexPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(container.querySelector('[data-theme="evidomo-dark"]')).not.toBeNull();
    for (const theme of ['hearth-dark', 'clay-dark', 'canal-dark']) {
      expect(container.querySelector(`[data-theme="${theme}"]`)).not.toBeNull();
    }
    unmount();
    const again = renderPage(<IndexPage />);
    expect(again.container.querySelector('[data-theme="canal-dark"]')).not.toBeNull();
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
    expect(container.querySelector('[data-theme="clay-light"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(container.querySelector('[data-theme="clay-dark"]')).not.toBeNull();
  });
});
