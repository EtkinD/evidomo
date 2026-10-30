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
const { ColorsPage } = await import('../showcase/pages/ColorsPage');
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
      id: 'A-LOGO-1',
      direction: 'A',
      kind: 'logo-concept',
      file: 'A/logo-1.webp',
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
    const bad2 = { ...manifest, items: [{ ...manifest.items[0], direction: 'D' }] };
    expect(parseManifest(bad2).success).toBe(false);
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

  it('shows a manifest image with its ID, and a placeholder for a direction with none', async () => {
    stubManifest(jsonResponse(200, manifest));
    renderPage(<ImageryPage />);
    const figure = await screen.findByRole('figure', { name: /B-HERO-1/ });
    expect(within(figure).getByRole('img', { name: /warm house/ })).toBeDefined();
    expect(screen.getAllByText(/not generated yet/i).length).toBe(8);
  });

  it('swaps a broken image for the placeholder', async () => {
    stubManifest(jsonResponse(200, manifest));
    renderPage(<LogoPage />);
    const figure = await screen.findByRole('figure', { name: /A-LOGO-1/ });
    const image = within(figure).getByRole('img');
    image.dispatchEvent(new Event('error'));
    await waitFor(() =>
      expect(within(figure).getByText(/A\/logo-1.webp: not generated yet/)).toBeDefined(),
    );
  });
});

describe('sub-pages render their candidate IDs', () => {
  const missing = (): void => stubManifest(new Response('nope', { status: 404 }));

  it('index links to every area and explains feedback by ID', () => {
    missing();
    setRoute('/showcase');
    renderPage(<IndexPage />);
    for (const name of ['Colours', 'Typography', 'Logo', 'Components', 'Imagery', 'Landing']) {
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
    for (const name of ['Ledger', 'Hearth', 'Signal']) {
      expect(screen.getByRole('heading', { name: new RegExp(name) })).toBeDefined();
    }
  });

  it('colors: two palettes per direction, all contrast rows passing', () => {
    missing();
    renderPage(<ColorsPage />);
    for (const id of ['A-COL-1', 'A-COL-2', 'B-COL-1', 'B-COL-2', 'C-COL-1', 'C-COL-2']) {
      expect(screen.getByRole('figure', { name: new RegExp(id) })).toBeDefined();
    }
    expect(screen.queryAllByText('Fail')).toHaveLength(0);
    expect(screen.getAllByText('Pass').length).toBeGreaterThan(100);
  });

  it('typography: scale and Dutch/English sample per direction', () => {
    missing();
    renderPage(<TypographyPage />);
    for (const id of ['A-TYPE-1', 'A-TYPE-2', 'B-TYPE-1', 'B-TYPE-2', 'C-TYPE-1', 'C-TYPE-2']) {
      expect(screen.getByRole('figure', { name: new RegExp(id) })).toBeDefined();
    }
    expect(document.querySelectorAll('article[lang="nl"]')).toHaveLength(3);
    expect(document.querySelectorAll('article[lang="en"]')).toHaveLength(3);
  });

  it('logo: two SVG candidates per direction', () => {
    missing();
    renderPage(<LogoPage />);
    for (const id of ['A-SVG-1', 'A-SVG-2', 'B-SVG-1', 'B-SVG-2', 'C-SVG-1', 'C-SVG-2']) {
      expect(screen.getByRole('figure', { name: new RegExp(id) })).toBeDefined();
    }
  });

  it('components: every block per direction, with 44 px class on buttons', () => {
    missing();
    renderPage(<ComponentsPage />);
    for (const direction of ['A', 'B', 'C']) {
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
    for (const id of ['A-LAND-1', 'B-LAND-1', 'C-LAND-1']) {
      expect(screen.getByRole('figure', { name: new RegExp(id) })).toBeDefined();
    }
    await waitFor(() =>
      expect(screen.getAllByText(/Muse hero: not generated yet/)).toHaveLength(3),
    );
  });

  it('the mode switch applies to the next render and is remembered', () => {
    missing();
    const { container, unmount } = renderPage(<IndexPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(container.querySelector('[data-theme="evidomo-dark"]')).not.toBeNull();
    expect(container.querySelector('[data-theme="ledger-dark"]')).not.toBeNull();
    unmount();
    const again = renderPage(<IndexPage />);
    expect(again.container.querySelector('[data-theme="hearth-dark"]')).not.toBeNull();
  });
});
