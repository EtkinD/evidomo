import { screen, within } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEMO_HREF } from '../components/landing/LandingPage';
import { LANDING_IMAGES, landingSrc } from '../lib/landing-images';
import Home from '../pages/index';
import { setRoute } from './router-mock';
import { meSignedIn, meSignedOut, mockFetch, renderPage } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

async function renderSignedOut(): Promise<HTMLElement> {
  setRoute('/');
  mockFetch({ 'GET /api/auth/me': meSignedOut });
  renderPage(Home);
  const main = screen.getByRole('main');
  // The calls to action appear once the session check settles.
  await within(main).findAllByRole('link', { name: 'Create account' });
  return main;
}

describe('landing page, signed out', () => {
  it('leads with the product promise as the only h1', async () => {
    await renderSignedOut();
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Every claim in your listing, linked to its evidence.',
      }),
    ).toBeDefined();
  });

  it('offers Create account (primary) and Log in in the hero and the closing band', async () => {
    const main = await renderSignedOut();

    const create = within(main).getAllByRole('link', { name: 'Create account' });
    const login = within(main).getAllByRole('link', { name: 'Log in' });
    expect(create).toHaveLength(2);
    expect(login).toHaveLength(2);
    for (const link of create) expect(link.getAttribute('href')).toBe('/register');
    for (const link of login) expect(link.getAttribute('href')).toBe('/login');
    expect(create[0]?.className).toContain('btn-primary');
    // One primary button in the page body; the closing band uses a light button on clay.
    expect(main.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('links to the public demo from the hero and the closing band', async () => {
    const main = await renderSignedOut();

    expect(DEMO_HREF).toBe('/demo');
    const demo = within(main).getAllByRole('link', { name: 'See a finished run' });
    expect(demo).toHaveLength(2);
    for (const link of demo) expect(link.getAttribute('href')).toBe('/demo');
    for (const link of within(main).getAllByRole('link')) {
      expect(['/register', '/login', '/demo']).toContain(link.getAttribute('href'));
    }
  });
});

describe('landing page, signed in', () => {
  it('sends the signed-in agent to the projects and hides sign-up', async () => {
    setRoute('/');
    mockFetch({ 'GET /api/auth/me': meSignedIn });
    renderPage(Home);
    const main = screen.getByRole('main');

    const links = await within(main).findAllByRole('link', { name: 'Go to your projects' });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.getAttribute('href')).toBe('/projects');
    expect(within(main).queryByRole('link', { name: 'Create account' })).toBeNull();
    expect(within(main).queryByRole('link', { name: 'Log in' })).toBeNull();
    expect(main.querySelectorAll('.btn-primary')).toHaveLength(1);
  });
});

describe('landing page content', () => {
  it('orders headings: one h1, then h2 sections with h3 items, no skipped level', async () => {
    const main = await renderSignedOut();

    const headings = within(main).getAllByRole('heading');
    expect(headings.filter((h) => h.tagName === 'H1')).toHaveLength(1);
    expect(headings[0]?.tagName).toBe('H1');
    const levels = headings.map((h) => Number(h.tagName.slice(1)));
    levels.forEach((level, i) => {
      if (i > 0) expect(level - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1);
    });
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual([
      'From a walk-through to a pack you can defend',
      'Every claim has a source',
      'Built to be checked',
      'Ready for your next listing?',
    ]);
    expect(
      within(main)
        .getAllByRole('heading', { level: 3 })
        .slice(0, 3)
        .map((h) => h.textContent),
    ).toEqual(['Capture', 'Verify', 'Pack']);
  });

  it('gives every image alt text and intrinsic size, and loads only the hero eagerly', async () => {
    const main = await renderSignedOut();

    const images = within(main).getAllByRole('img');
    const photos = images.filter((img) => img.tagName === 'IMG');
    expect(photos).toHaveLength(5);
    for (const img of photos) {
      expect(img.getAttribute('alt')?.length ?? 0).toBeGreaterThan(20);
      expect(Number(img.getAttribute('width'))).toBeGreaterThan(0);
      expect(Number(img.getAttribute('height'))).toBeGreaterThan(0);
      expect(img.getAttribute('srcset')).toContain('640w');
      expect(img.getAttribute('sizes')).toBeTruthy();
    }
    const [hero, ...rest] = photos;
    expect(hero?.getAttribute('loading')).toBe('eager');
    expect(hero?.getAttribute('fetchpriority')).toBe('high');
    for (const img of rest) expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('references only files that exist in public/images/landing', () => {
    for (const image of Object.values(LANDING_IMAGES)) {
      for (const width of image.widths) {
        expect(existsSync(resolve(__dirname, '../../public', `.${landingSrc(image, width)}`))).toBe(
          true,
        );
      }
    }
  });

  it('makes no claim the product does not back', async () => {
    const main = await renderSignedOut();
    const text = main.textContent ?? '';

    // Hosting is not deployed yet.
    expect(text).not.toMatch(/\bEU\b|\bGDPR\b|Europe/);
    // No performance figures, prices, or percentages: none are published or sourced.
    expect(text).not.toMatch(/\d+\s*%|\bminutes?\b|\bhours?\b|\$|€|£/i);
    // No social proof or guarantees.
    expect(text).not.toMatch(/testimonial|trusted by|customers|award|guarantee|100%|never wrong/i);
    // The product never promises compliance, valuations, or portal publishing.
    expect(text).toMatch(/does not certify legal compliance/);
  });
});
