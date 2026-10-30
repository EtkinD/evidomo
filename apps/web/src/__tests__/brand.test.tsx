import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import Home from '../pages/index';
import { setRoute } from './router-mock';
import { meSignedOut, mockFetch, renderPage } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

const { Logo } = await import('../components/brand/Logo');

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const read = (name: string) => readFileSync(join(publicDir, name));

function pngSize(name: string): { width: number; height: number } {
  const data = read(name);
  expect(data.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(data.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

describe('Logo', () => {
  it('lockup: the live wordmark is the name and the mark is decorative', () => {
    const { container } = render(<Logo />);
    expect(screen.getByText('Evidomo').className).toContain('font-display');
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('wordmark: text only', () => {
    const { container } = render(<Logo variant="wordmark" />);
    expect(screen.getByText('Evidomo')).toBeDefined();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('mark: carries the accessible name itself', () => {
    render(<Logo variant="mark" size="lg" />);
    const mark = screen.getByRole('img', { name: 'Evidomo' });
    expect(mark.getAttribute('class')).toContain('size-12');
  });

  it('uses theme tokens only, so it follows light and dark', () => {
    const { container } = render(<Logo />);
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}|rgb\(|style=/i);
    expect(container.querySelector('.stroke-primary')).not.toBeNull();
    expect(container.querySelector('.fill-secondary')).not.toBeNull();
  });
});

describe('AppShell home link', () => {
  it('is the logo lockup with a 44 px target', () => {
    setRoute('/');
    mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(Home);
    const home = screen.getAllByRole('link', { name: 'Evidomo' })[0];
    expect(home?.getAttribute('href')).toBe('/');
    expect(home?.className).toContain('min-h-11');
    expect(home?.querySelector('svg')).not.toBeNull();
  });
});

describe('committed brand files', () => {
  it.each([
    ['apple-touch-icon.png', 180, 180],
    ['icon-192.png', 192, 192],
    ['icon-512.png', 512, 512],
    ['icon-maskable-512.png', 512, 512],
    ['og.png', 1200, 630],
  ])('%s is %i by %i pixels', (name, width, height) => {
    expect(pngSize(name)).toEqual({ width, height });
  });

  it('favicon.ico holds 16 and 32 pixel PNG images', () => {
    const ico = read('favicon.ico');
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const at = 6 + 16 * i;
      const size = ico.readUInt8(at);
      sizes.push(size);
      const offset = ico.readUInt32LE(at + 12);
      expect(ico.subarray(offset + 1, offset + 4).toString('latin1')).toBe('PNG');
      expect(ico.readUInt32BE(offset + 16)).toBe(size);
    }
    expect(sizes).toEqual([16, 32]);
  });

  it('SVG files exist; the favicon adapts to dark and the wordmark is outlined', () => {
    expect(read('favicon.svg').toString()).toContain('prefers-color-scheme:dark');
    for (const name of [
      'brand/evidomo-mark.svg',
      'brand/evidomo-lockup-light.svg',
      'brand/evidomo-lockup-dark.svg',
    ]) {
      const svg = read(name).toString();
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).not.toContain('<text');
    }
  });

  it('site.webmanifest lists the icons and the theme colours', () => {
    const manifest = JSON.parse(read('site.webmanifest').toString()) as {
      name: string;
      short_name: string;
      theme_color: string;
      background_color: string;
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };
    expect(manifest.name).toBe('Evidomo');
    expect(manifest.short_name).toBe('Evidomo');
    expect(manifest.theme_color).toBe('#fefbf5');
    expect(manifest.background_color).toBe('#f8f3e9');
    expect(manifest.icons.map((i) => [i.src, i.sizes, i.purpose ?? 'any'])).toEqual([
      ['/icon-192.png', '192x192', 'any'],
      ['/icon-512.png', '512x512', 'any'],
      ['/icon-maskable-512.png', '512x512', 'maskable'],
    ]);
    for (const icon of manifest.icons) expect(icon.type).toBe('image/png');
  });
});
