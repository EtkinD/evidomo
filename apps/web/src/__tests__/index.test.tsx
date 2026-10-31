import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../messages/en.json';
import { DEMO_HREF } from '../components/landing/LandingPage';
import { LANDING_IMAGES, landingSrc } from '../lib/landing-images';
import { SOURCE_NOTE_IDS } from '../lib/landing-sources';
import { resetShowSources, SOURCES_STORAGE_KEY } from '../lib/sources';
import Home from '../pages/index';
import { setRoute } from './router-mock';
import { meSignedIn, meSignedOut, mockFetch, renderPage } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

beforeEach(() => {
  window.localStorage.clear();
  resetShowSources();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

/** The notes the landing page marks: the claims a visitor would doubt, and no more. */
const LANDING_NOTES = ['lede', 'stops', 'example', 'labelled', 'private', 'limits'];

async function renderLanding(route = '/'): Promise<HTMLElement> {
  setRoute(route);
  mockFetch({ 'GET /api/auth/me': meSignedOut });
  renderPage(Home);
  const main = screen.getByRole('main');
  // The secondary action appears once the session check settles.
  await within(main).findByRole('link', { name: 'Create account' });
  return main;
}

/** The switch exists twice in the DOM (masthead on desktop, hero on a phone). */
const switches = () => screen.getAllByRole('button', { name: 'Show sources' });

/** Every string the landing page shows, from the messages (what a visitor has to read). */
function bodyWords(): number {
  const landing: Record<string, unknown> = { ...en.landing };
  for (const key of [
    'images',
    'sources',
    'specimen',
    'ledger',
    'numbers',
    'boundaries',
    'photos',
  ]) {
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
        name: 'Every claim in your listing, linked to its evidence.',
      }),
    ).toBeDefined();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('has Open the sample file as the one primary action and Create account as the one secondary', async () => {
    const main = await renderLanding();
    expect(DEMO_HREF).toBe('/demo');
    const open = within(main).getAllByRole('link', { name: 'Open the sample file' });
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
    expect(within(main).getAllByRole('link', { name: 'Open the sample file' })).toHaveLength(2);
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

  it('keeps the page short: well under main’s text, within the per-block budgets', () => {
    // Main's landing had 447 words of messages; the budgets of the round 5b brief follow.
    expect(bodyWords()).toBeLessThanOrEqual(260);
    const words = (text: string): number => text.split(/\s+/).length;
    expect(words(en.landing.hero.lede)).toBeLessThanOrEqual(25);
    for (const step of Object.values(en.landing.how.steps)) {
      expect(words(step.text)).toBeLessThanOrEqual(15);
    }
    expect(
      words(en.landing.evidence.text) + words(en.landing.evidence.caption),
    ).toBeLessThanOrEqual(30);
    for (const item of Object.values(en.landing.trust.items)) {
      expect(words(item.text)).toBeLessThanOrEqual(12);
    }
    expect(words(en.landing.cta.title) + words(en.landing.cta.text)).toBeLessThanOrEqual(12);
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
    expect(text).toMatch(/No valuations, no legal advice, no publishing for you/);
    // The hero's own example says it is one.
    expect(text).toMatch(/An illustrative example, not a real listing/);
  });
});

describe('landing page: the claim example', () => {
  it('uses a real sentence of the sample run, says it is a replay, and opens one claim', async () => {
    const main = await renderLanding();
    const sentence = main.querySelector('blockquote[lang="en"]');
    // (The footnote numbers sit inside the sentence.)
    expect(sentence?.textContent).toMatch(
      /^This apartment in Zandmeer\d offers 92 m²\d of living space on floor 2\d\.$/,
    );
    expect(main.textContent).toMatch(
      /replay of recorded model responses for a synthetic apartment/,
    );
    const area = within(main).getByRole('button', { name: /Living area/ });
    expect(area.getAttribute('aria-pressed')).toBe('true');
    const evidence = within(main).getByRole('region', { name: /What “92 m²” rests on/ });
    expect(evidence.textContent).toContain('Form field');
    expect(evidence.textContent).toContain('“92 vierkante meter”');
    expect(evidence.textContent).toContain('turn at 00:19');
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
    const evidence = within(main).getByRole('region', { name: /What “floor 2” rests on/ });
    expect(evidence.textContent).toContain('“op de tweede verdieping”');
    expect(evidence.textContent).toContain('turn at 00:00');
    expect(evidence.textContent).not.toContain('Form field');
  });

  it('marks the Dutch quote as Dutch and announces only the heading', async () => {
    const main = await renderLanding();
    expect(screen.getByText('“92 vierkante meter”').getAttribute('lang')).toBe('nl');
    expect(
      within(main)
        .getByRole('region', { name: /rests on/ })
        .getAttribute('aria-live'),
    ).toBeNull();
    expect(document.getElementById('claim-evidence-title')?.getAttribute('aria-live')).toBe(
      'polite',
    );
  });

  it('has no underlined or highlighted text outside the open claim while sources are off', async () => {
    const main = await renderLanding();
    expect(main.querySelectorAll('.claim, .claim-on, mark[data-claim-source]')).toHaveLength(1);
    expect(main.querySelectorAll('[class*="underline"]')).toHaveLength(0);
    expect(main.querySelectorAll('[data-source-note]')).toHaveLength(0);
  });
});

describe('landing page: Show sources', () => {
  it('is off by default', async () => {
    await renderLanding();
    for (const button of switches()) expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('marks only the few claims a visitor would doubt, each with one compact note', async () => {
    const main = await renderLanding();
    fireEvent.click(switches()[0] as HTMLElement);
    for (const button of switches()) expect(button.getAttribute('aria-pressed')).toBe('true');

    const marks = [...main.querySelectorAll('[data-claim-source]')];
    const notes = [...main.querySelectorAll('[data-source-note]')];
    expect(marks.map((m) => m.getAttribute('data-claim-source'))).toEqual(LANDING_NOTES);
    expect(notes.map((n) => n.getAttribute('data-source-note'))).toEqual(LANDING_NOTES);
    expect(marks.length).toBeLessThanOrEqual(6);
    // The registry lists the landing's notes first, so its footnotes read 1 to 6.
    expect(SOURCE_NOTE_IDS.slice(0, LANDING_NOTES.length)).toEqual(LANDING_NOTES);
    for (const mark of marks) {
      const id = mark.getAttribute('data-claim-source') ?? '';
      expect(mark.getAttribute('aria-describedby')).toBe(`source-note-${id}`);
      expect(main.querySelector(`#source-note-${id}`)).not.toBeNull();
      expect(mark.nextElementSibling?.textContent).toMatch(/^\d+source \d+$/);
    }
    for (const note of notes) {
      expect(within(note as HTMLElement).getAllByRole('link').length).toBeGreaterThan(0);
    }
    expect(within(main).queryAllByRole('complementary')).toHaveLength(0);
  });

  it('names the source type and points code notes at GitHub on main', async () => {
    const main = await renderLanding();
    fireEvent.click(switches()[0] as HTMLElement);
    const kinds = new Set(
      [...main.querySelectorAll('[data-source-note] li > span')].map((s) => s.textContent),
    );
    expect(kinds).toEqual(new Set(['Sample run', 'Enforced in code', 'Product rule']));
    const hrefs = within(main)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href') ?? '');
    expect(hrefs).toContain(
      'https://github.com/EtkinD/evidomo/blob/main/apps/api/src/media/image.ts',
    );
    // Notes about the sample run and the rules lead to the matching section of /method.
    expect(hrefs).toContain('/method#sample-run');
    expect(hrefs).toContain('/method#sources');
    expect(hrefs).toContain('/method#limits-and-data');
  });

  it('is remembered per viewer', async () => {
    await renderLanding();
    fireEvent.click(switches()[0] as HTMLElement);
    expect(window.localStorage.getItem(SOURCES_STORAGE_KEY)).toBe('on');

    cleanup();
    resetShowSources();
    await renderLanding();
    for (const button of switches()) expect(button.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(switches()[0] as HTMLElement);
    expect(window.localStorage.getItem(SOURCES_STORAGE_KEY)).toBeNull();
  });

  it('can be turned on from the address with ?sources=on, without storing it', async () => {
    await renderLanding('/?sources=on');
    for (const button of switches()) expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem(SOURCES_STORAGE_KEY)).toBeNull();
  });

  it('works when storage is blocked: reading and writing fail, the switch still switches', async () => {
    const blocked = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      removeItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    vi.stubGlobal('localStorage', blocked);
    resetShowSources();
    const main = await renderLanding();
    expect(switches()[0]?.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(switches()[0] as HTMLElement);
    expect(switches()[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(main.querySelectorAll('[data-source-note]').length).toBeGreaterThan(0);
  });

  it('is a real button: focusable, 44 px, with the state written next to the label', async () => {
    await renderLanding();
    const button = switches()[0] as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.className).toContain('min-h-11');
    expect(button.textContent).toContain('Off');
    fireEvent.click(button);
    expect(button.textContent).toContain('On');
  });

  it('is in the masthead of the landing page only', () => {
    setRoute('/login');
    mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(() => <main />);
    expect(screen.queryByRole('button', { name: 'Show sources' })).toBeNull();
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
