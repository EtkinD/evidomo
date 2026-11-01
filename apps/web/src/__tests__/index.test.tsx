import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../messages/en.json';
import { DEMO_HREF } from '../components/landing/LandingPage';
import { LANDING_IMAGES, landingSrc } from '../lib/landing-images';
import { REPOSITORY_URL } from '../lib/repository';
import Home from '../pages/index';
import { setRoute } from './router-mock';
import { meSignedIn, meSignedOut, mockFetch, renderPage } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

afterEach(() => {
  cleanup();
});

async function renderLanding(route = '/'): Promise<HTMLElement> {
  setRoute(route);
  mockFetch({ 'GET /api/auth/me': meSignedOut });
  renderPage(Home);
  const main = screen.getByRole('main');
  // The secondary action appears once the session check settles.
  await within(main).findByRole('link', { name: 'Create account' });
  return main;
}

/** Every string the landing page shows, from the messages (what a visitor has to read). */
function bodyWords(): number {
  const landing: Record<string, unknown> = { ...en.landing };
  for (const key of ['images', 'specimen', 'ledger', 'numbers', 'boundaries', 'photos']) {
    delete landing[key];
  }
  const text = JSON.stringify(landing).replace(/"[A-Za-z_]+":/g, ' ');
  return text.split(/\s+/).filter((word) => /\w/.test(word)).length;
}

describe('landing page: structure', () => {
  it('leads with the product promise as the only h1', async () => {
    await renderLanding();
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'A listing where every sentence shows where it came from.',
      }),
    ).toBeDefined();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('has See a finished example as the one primary action and Create account as the one secondary', async () => {
    const main = await renderLanding();
    expect(DEMO_HREF).toBe('/demo');
    const open = within(main).getAllByRole('link', { name: 'See a finished example' });
    expect(open).toHaveLength(2); // the hero and the closing band
    for (const link of open) expect(link.getAttribute('href')).toBe('/demo');
    const create = within(main).getAllByRole('link', { name: 'Create account' });
    expect(create).toHaveLength(1);
    expect(create[0]?.getAttribute('href')).toBe('/register');
    expect(main.querySelectorAll('.btn-primary')).toHaveLength(1);
    // Log in is in the masthead only.
    expect(within(main).queryByRole('link', { name: 'Log in' })).toBeNull();
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Log in' })).toBeDefined();
  });

  it('offers a signed-in agent the projects instead of an account', async () => {
    setRoute('/');
    mockFetch({ 'GET /api/auth/me': meSignedIn });
    renderPage(Home);
    const main = screen.getByRole('main');
    const link = await within(main).findByRole('link', { name: 'Go to your projects' });
    expect(link.getAttribute('href')).toBe('/projects');
    expect(within(main).queryByRole('link', { name: 'Create account' })).toBeNull();
    expect(within(main).getAllByRole('link', { name: 'See a finished example' })).toHaveLength(2);
  });

  it('orders headings: one h1, then h2 sections with h3 items, no skipped level', async () => {
    const main = await renderLanding();
    const headings = within(main).getAllByRole('heading');
    const levels = headings.map((h) => Number(h.tagName.slice(1)));
    levels.forEach((level, i) => {
      if (i > 0) expect(level - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1);
    });
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual([
      'How it works',
      'See where a sentence comes from',
      'You stay in charge',
      'Ready to try it?',
    ]);
    expect(
      within(main)
        .getAllByRole('heading', { level: 3 })
        .slice(0, 3)
        .map((h) => h.textContent),
    ).toEqual(['Take photos and talk', 'Check', 'Get the listing']);
  });

  it('keeps the page short: within the per-block budgets', () => {
    expect(bodyWords()).toBeLessThanOrEqual(295);
    const words = (text: string): number => text.split(/\s+/).length;
    expect(words(en.landing.hero.lede)).toBeLessThanOrEqual(30);
    for (const step of Object.values(en.landing.how.steps)) {
      expect(words(step.text)).toBeLessThanOrEqual(25);
    }
    expect(
      words(en.landing.evidence.text) + words(en.landing.evidence.caption),
    ).toBeLessThanOrEqual(30);
    for (const item of Object.values(en.landing.trust.items)) {
      expect(words(item.text)).toBeLessThanOrEqual(12);
    }
    expect(words(en.landing.cta.title) + words(en.landing.cta.text)).toBeLessThanOrEqual(14);
  });

  it('says what goes in: 10 to 30 photos and a voice walkthrough, and that video is not used', async () => {
    const main = await renderLanding();
    const how = main.querySelector('#how-it-works') as HTMLElement;
    expect(how.textContent).toContain('10 to 30 photos');
    expect(how.textContent).toMatch(/2 to 10 minutes/);
    expect(how.textContent).toMatch(/record in your browser or upload audio/);
    expect(how.textContent).toMatch(/No video/);
    expect(within(main).getByRole('heading', { level: 1 }).textContent).toBeTruthy();
    expect(main.textContent).toContain('Take 10 to 30 photos of the home and talk through it');
  });

  it('shows no round 5 detail section: no ledger, eval table, or boundaries list', async () => {
    const main = await renderLanding();
    const text = main.textContent ?? '';
    expect(text).not.toMatch(/What happened to this listing|The numbers, and their limits/);
    expect(text).not.toMatch(/What it will not do|Review 1 of 2/);
    expect(main.querySelector('table')).toBeNull();
  });

  it('gives every image alt text and intrinsic size, and loads only the hero eagerly', async () => {
    const main = await renderLanding();
    const photos = within(main)
      .getAllByRole('img')
      .filter((img) => img.tagName === 'IMG');
    expect(photos).toHaveLength(4);
    for (const img of photos) {
      expect(img.getAttribute('alt')?.length ?? 0).toBeGreaterThan(20);
      expect(Number(img.getAttribute('width'))).toBeGreaterThan(0);
      expect(Number(img.getAttribute('height'))).toBeGreaterThan(0);
      expect(img.getAttribute('srcset')).toContain('640w');
    }
    const [hero, ...rest] = photos;
    expect(hero?.getAttribute('loading')).toBe('eager');
    for (const img of rest) expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('keeps clear of claims the product does not back', async () => {
    const text = (await renderLanding()).textContent ?? '';
    expect(text).not.toMatch(/\bEU\b|\bGDPR\b|Europe/);
    expect(text).not.toMatch(/testimonial|trusted by|customers|award|guarantee|100%|never wrong/i);
    // It says what it does not do, in a few words.
    expect(text).toMatch(/does not value homes, give legal advice, or publish for you/);
    // The hero's own example says it is one.
    expect(text).toMatch(/An example to show the idea, not a real listing/);
  });
});

describe('landing page: the claim example', () => {
  it('uses a real sentence of the sample run, says it is a replay, and opens one claim', async () => {
    const main = await renderLanding();
    const sentence = main.querySelector('blockquote[lang="en"]');
    // (Each footnote marker is bracketed and spaced, with a screen-reader name.)
    expect(sentence?.textContent).toMatch(
      /^This apartment in Zandmeer\[1\], Note 1 offers 92 m²\[2\], Note 2 of living space on floor 2\[3\], Note 3\.$/,
    );
    const markers = [...(sentence?.querySelectorAll('sup') ?? [])];
    expect(markers).toHaveLength(3);
    for (const marker of markers) {
      expect(marker.querySelector('[aria-hidden]')?.textContent).toMatch(/^\[\d\]$/);
      expect(marker.querySelector('.sr-only')?.textContent).toMatch(/^, Note \d$/);
    }
    expect(main.textContent).toMatch(/made-up apartment, replayed from saved results/);
    const area = within(main).getByRole('button', { name: /Living area/ });
    expect(area.getAttribute('aria-pressed')).toBe('true');
    const evidence = within(main).getByRole('region', { name: /What “92 m²” is based on/ });
    expect(evidence.textContent).toContain('Your form');
    expect(evidence.textContent).toContain('“92 vierkante meter”');
    expect(evidence.textContent).toContain('at 00:19');
    expect(within(evidence).getByText('Verified')).toBeDefined();
  });

  it('highlights only the open claim and moves the evidence with the selection', async () => {
    const main = await renderLanding();
    expect(main.querySelectorAll('mark.claim')).toHaveLength(1);
    fireEvent.click(within(main).getByRole('button', { name: /Floor/ }));
    expect(main.querySelectorAll('mark.claim')).toHaveLength(1);
    expect(main.querySelector('mark.claim')?.textContent).toBe('floor 2');
    expect(within(main).getByRole('button', { name: /Floor/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(
      within(main)
        .getByRole('button', { name: /Living area/ })
        .getAttribute('aria-pressed'),
    ).toBe('false');
    const evidence = within(main).getByRole('region', { name: /What “floor 2” is based on/ });
    expect(evidence.textContent).toContain('“op de tweede verdieping”');
    expect(evidence.textContent).toContain('at 00:00');
    expect(evidence.textContent).not.toContain('Your form');
  });

  it('marks the Dutch quote as Dutch and announces only the heading', async () => {
    const main = await renderLanding();
    expect(screen.getByText('“92 vierkante meter”').getAttribute('lang')).toBe('nl');
    expect(
      within(main)
        .getByRole('region', { name: /is based on/ })
        .getAttribute('aria-live'),
    ).toBeNull();
    expect(document.getElementById('claim-evidence-title')?.getAttribute('aria-live')).toBe(
      'polite',
    );
  });

  it('has no underlined or highlighted text outside the open claim', async () => {
    const main = await renderLanding();
    expect(main.querySelectorAll('.claim')).toHaveLength(1);
    expect(main.querySelectorAll('[class*="underline"]')).toHaveLength(0);
  });
});

describe('landing page: no source switch and no GitHub links', () => {
  it('has no Show sources switch, and ?sources=on changes nothing', async () => {
    const main = await renderLanding('/?sources=on');
    expect(screen.queryByRole('button', { name: /sources/i })).toBeNull();
    expect(main.querySelectorAll('mark.claim')).toHaveLength(1);
    expect(main.querySelectorAll('[data-source-note], [data-claim-source]')).toHaveLength(0);
    expect(window.localStorage.getItem('evidomo-sources')).toBeNull();
  });

  it('links to GitHub only from the footer', async () => {
    await renderLanding();
    const github = [...document.querySelectorAll('a[href]')].filter((a) =>
      (a.getAttribute('href') ?? '').includes('github.com'),
    );
    expect(github).toHaveLength(1);
    expect(github[0]?.getAttribute('href')).toBe(REPOSITORY_URL);
    expect(github[0]?.closest('footer')).not.toBeNull();
  });
});

describe('the landing images', () => {
  it('references only files that exist in public/images/landing', () => {
    for (const image of Object.values(LANDING_IMAGES)) {
      for (const width of image.widths) {
        expect(existsSync(resolve(__dirname, '../../public', `.${landingSrc(image, width)}`))).toBe(
          true,
        );
      }
    }
  });
});
