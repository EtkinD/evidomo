import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_HREF } from '../components/landing/LandingPage';
import { SOURCE_NOTE_IDS } from '../lib/landing-sources';
import { SAMPLE_PHOTOS, samplePhotoSrc } from '../lib/sample-run';
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

function renderLanding(route = '/'): HTMLElement {
  setRoute(route);
  mockFetch({ 'GET /api/auth/me': meSignedOut });
  renderPage(Home);
  return screen.getByRole('main');
}

/** The switch exists twice in the DOM (masthead on desktop, sticky bar on a phone). */
const switches = () => screen.getAllByRole('button', { name: 'Show sources' });

describe('landing page: structure', () => {
  it('leads with the product promise as the only h1', () => {
    renderLanding();
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Every claim in your listing, linked to its evidence.',
      }),
    ).toBeDefined();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('has one action, Open the sample file, and no account buttons in the page body', async () => {
    const main = renderLanding();
    expect(DEMO_HREF).toBe('/demo');
    // The action is in the first screen (desktop) and in the sticky bar (phone), one visible each.
    const open = within(main).getAllByRole('link', { name: 'Open the sample file' });
    expect(open.length).toBeGreaterThanOrEqual(2);
    for (const link of open) expect(link.getAttribute('href')).toBe('/demo');
    expect(within(main).queryByRole('link', { name: 'Create account' })).toBeNull();
    expect(within(main).queryByRole('link', { name: 'Log in' })).toBeNull();
    // Accounts live in the masthead.
    expect(
      await within(screen.getByRole('banner')).findByRole('link', { name: 'Create account' }),
    ).toBeDefined();
  });

  it('shows Projects in the masthead for a signed-in agent, with the same page body', async () => {
    setRoute('/');
    mockFetch({ 'GET /api/auth/me': meSignedIn });
    renderPage(Home);
    expect(
      await within(screen.getByRole('banner')).findByRole('link', { name: 'Projects' }),
    ).toBeDefined();
    expect(
      within(screen.getByRole('main')).queryByRole('link', { name: 'Create account' }),
    ).toBeNull();
  });

  it('orders headings: one h1, h2 sections for the ledger, numbers, and boundaries', () => {
    const main = renderLanding();
    const levels = within(main)
      .getAllByRole('heading')
      .map((h) => Number(h.tagName.slice(1)));
    levels.forEach((level, i) => {
      if (i > 0) expect(level - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1);
    });
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual([
      'What happened to this listing',
      'The numbers, and their limits',
      'What it will not do',
    ]);
    // The ledger lists the run's ten steps and its two stops.
    expect(
      within(main).getByRole('heading', { name: 'Review 1 of 2: fact conflicts' }),
    ).toBeDefined();
    expect(within(main).getByRole('heading', { name: 'Checking every claim' })).toBeDefined();
  });

  it('removed the template sections', () => {
    const main = renderLanding();
    const text = main.textContent ?? '';
    expect(text).not.toMatch(
      /Ready for your next listing|Built to be checked|Capture.*Verify.*Pack/,
    );
  });

  it('lazy-loads every sample photo, with alt text, intrinsic size, and files that exist', () => {
    const main = renderLanding();
    const photos = within(main).getAllByRole('img');
    expect(photos.length).toBeGreaterThanOrEqual(3);
    for (const img of photos) {
      expect(img.getAttribute('alt')?.length ?? 0).toBeGreaterThan(20);
      expect(Number(img.getAttribute('width'))).toBeGreaterThan(0);
      expect(Number(img.getAttribute('height'))).toBeGreaterThan(0);
      expect(img.getAttribute('srcset')).toContain('480w');
      expect(img.getAttribute('loading')).toBe('lazy');
    }
    for (const photo of Object.values(SAMPLE_PHOTOS)) {
      for (const width of photo.widths) {
        expect(
          existsSync(resolve(__dirname, '../../public', `.${samplePhotoSrc(photo, width)}`)),
        ).toBe(true);
      }
    }
  });

  it('keeps clear of claims the product does not back', () => {
    const text = renderLanding().textContent ?? '';
    expect(text).not.toMatch(/\bEU\b|\bGDPR\b|Europe/);
    // (No "guarantee" here: the page says that only market facts are guaranteed by code, a limit.)
    expect(text).not.toMatch(/testimonial|trusted by|customers|award|100%|never wrong/i);
    expect(text).toMatch(/does not certify legal compliance/);
    // The limits are stated on the page, not only in the README.
    expect(text).toMatch(/one synthetic apartment/);
  });
});

describe('landing page: the specimen', () => {
  it('opens the first claim on load, with its voice turn and the form value it replaced', () => {
    renderLanding();
    const year = screen.getByRole('button', { name: /Build year/ });
    expect(year.getAttribute('aria-pressed')).toBe('true');
    const evidence = screen.getByRole('region', { name: /What “1987” rests on/ });
    expect(evidence.textContent).toContain('Voice walkthrough, turn at 00:11');
    expect(evidence.textContent).toContain('“in 1987 gebouwd”');
    expect(evidence.textContent).toContain('Build year: 1986');
    expect(evidence.textContent).toContain('the spoken 1987 was kept');
    expect(within(evidence).getByText('Verified')).toBeDefined();
    expect(within(evidence).getByText('Not used')).toBeDefined();
  });

  it('moves the evidence with the selected claim', () => {
    renderLanding();
    fireEvent.click(screen.getByRole('button', { name: /Energy label/ }));
    expect(screen.getByRole('button', { name: /Energy label/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: /Build year/ }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    const evidence = screen.getByRole('region', { name: /energy label B/ });
    expect(evidence.textContent).toContain('Energy label: B');
    expect(evidence.textContent).toContain('“Het energielabel is B”');
    expect(evidence.textContent).toContain('turn at 02:37');
    expect(evidence.textContent).not.toContain('1986');
  });

  it('keeps the model sentence in English and marks the Dutch quotes', () => {
    const main = renderLanding();
    const sentence = main.querySelector('blockquote[lang="en"]');
    expect(sentence?.textContent).toContain('The building dates from 1987');
    expect(screen.getByText('“in 1987 gebouwd”').getAttribute('lang')).toBe('nl');
  });
});

describe('landing page: Show sources', () => {
  it('is off by default: no notes, no highlights outside the specimen', () => {
    const main = renderLanding();
    for (const button of switches()) expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(main.querySelectorAll('[data-source-note]')).toHaveLength(0);
    expect(main.querySelectorAll('[data-claim-source]')).toHaveLength(0);
  });

  it('turns every claim into a numbered, highlighted claim with a source note', () => {
    const main = renderLanding();
    fireEvent.click(switches()[0] as HTMLElement);
    for (const button of switches()) expect(button.getAttribute('aria-pressed')).toBe('true');

    const notes = main.querySelectorAll('[data-source-note]');
    const marks = main.querySelectorAll('[data-claim-source]');
    expect(marks.length).toBeGreaterThanOrEqual(20);
    // Every highlighted claim has its note, and the other way round.
    expect([...notes].map((n) => n.getAttribute('data-source-note')).sort()).toEqual(
      [...marks].map((m) => m.getAttribute('data-claim-source')).sort(),
    );
    // The page marks exactly the claims the registry knows: no claim without an entry, and no
    // entry nobody uses (an orphan note would be a source for nothing).
    const marked = [...marks].map((m) => m.getAttribute('data-claim-source') ?? '').sort();
    expect(marked).toEqual([...SOURCE_NOTE_IDS].sort());
    // A screen-reader user hears which source a claim has, and the claim points at its note.
    for (const mark of marks) {
      const id = mark.getAttribute('data-claim-source') ?? '';
      expect(mark.getAttribute('aria-describedby')).toBe(`source-note-${id}`);
      expect(main.querySelector(`#source-note-${id}`)).not.toBeNull();
      expect(mark.nextElementSibling?.textContent).toMatch(/^\d+source \d+$/);
    }
    // Each note names a source type and links somewhere real.
    for (const note of notes) {
      expect(within(note as HTMLElement).getAllByRole('link').length).toBeGreaterThan(0);
    }
    const kinds = new Set(
      [...main.querySelectorAll('[data-source-note] li > span')].map((s) => s.textContent),
    );
    expect(kinds).toEqual(
      new Set(['Sample run', 'Eval report', 'Enforced in code', 'Product rule']),
    );
  });

  it('points code notes at GitHub on main and sample notes at the sample file', () => {
    const main = renderLanding();
    fireEvent.click(switches()[0] as HTMLElement);
    const hrefs = within(main)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href') ?? '');
    expect(hrefs).toContain(
      'https://github.com/EtkinD/evidomo/blob/main/apps/api/src/media/image.ts',
    );
    expect(hrefs).toContain('https://github.com/EtkinD/evidomo/blob/main/README.md#eval-results');
    expect(hrefs).toContain('/demo?tab=conflicts');
  });

  it('is remembered per viewer', () => {
    renderLanding();
    fireEvent.click(switches()[0] as HTMLElement);
    expect(window.localStorage.getItem(SOURCES_STORAGE_KEY)).toBe('on');

    cleanup();
    resetShowSources();
    renderLanding();
    for (const button of switches()) expect(button.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(switches()[0] as HTMLElement);
    expect(window.localStorage.getItem(SOURCES_STORAGE_KEY)).toBeNull();
  });

  it('can be turned on from the address with ?sources=on, without storing it', () => {
    renderLanding('/?sources=on');
    for (const button of switches()) expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem(SOURCES_STORAGE_KEY)).toBeNull();
  });

  it('works when storage is blocked: reading and writing fail, the switch still switches', () => {
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
    const main = renderLanding();
    expect(switches()[0]?.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(switches()[0] as HTMLElement);
    expect(switches()[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(main.querySelectorAll('[data-source-note]').length).toBeGreaterThan(0);
  });

  it('adds no landmark per note: the landmark list stays usable', () => {
    const main = renderLanding();
    fireEvent.click(switches()[0] as HTMLElement);
    expect(main.querySelectorAll('[data-source-note]').length).toBeGreaterThan(20);
    expect(within(main).queryAllByRole('complementary')).toHaveLength(0);
  });

  it('says plainly that the sample file is a replay with a stand-in for the audio', () => {
    const main = renderLanding();
    expect(main.textContent).toMatch(/replay.*recorded once.*synthetic speech.*silent stand-in/s);
    fireEvent.click(switches()[0] as HTMLElement);
    const note = main.querySelector('[data-claim-source="replay"]');
    expect(note).not.toBeNull();
    const links = within(main.querySelector('#source-note-replay') as HTMLElement).getAllByRole(
      'link',
    );
    expect(links.map((l) => l.textContent)).toContain(
      'fixtures/projects/synthetic-walkthrough/README.md',
    );
  });

  it('captions every sample photo as a model-generated input or the staging result', () => {
    const main = renderLanding();
    const captions = [...main.querySelectorAll('figcaption')].map((c) => c.textContent ?? '');
    expect(captions.length).toBeGreaterThanOrEqual(3);
    for (const caption of captions) expect(caption).toMatch(/model-generated/);
    // "Virtually staged" is only ever said of the staging step's own result.
    expect(captions.filter((c) => /Virtually staged/.test(c))).toHaveLength(1);
  });

  it('announces only the claim heading when the selection changes', () => {
    renderLanding();
    const region = screen.getByRole('region', { name: /rests on/ });
    expect(region.getAttribute('aria-live')).toBeNull();
    expect(document.getElementById('specimen-evidence-title')?.getAttribute('aria-live')).toBe(
      'polite',
    );
  });

  it('is a real button: keyboard focusable, with the state written next to the label', () => {
    renderLanding();
    const button = switches()[0] as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.className).toContain('min-h-11');
    expect(button.textContent).toContain('Off');
    fireEvent.click(button);
    expect(button.textContent).toContain('On');
  });
});

describe('landing page: only the landing page has the switch', () => {
  it('is not in the masthead of other pages', () => {
    setRoute('/login');
    mockFetch({ 'GET /api/auth/me': meSignedOut });
    renderPage(() => <main />);
    expect(screen.queryByRole('button', { name: 'Show sources' })).toBeNull();
  });
});
