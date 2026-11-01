import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../messages/en.json';
import { METHOD_ANCHORS } from '../lib/method';
import { LEDGER_ROWS } from '../lib/sample-run';
import { REPOSITORY_URL } from '../lib/repository';
import Method from '../pages/method';
import { setRoute } from './router-mock';
import { meSignedOut, mockFetch, renderPage } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

afterEach(() => {
  cleanup();
});

function renderMethod(): HTMLElement {
  setRoute('/method');
  mockFetch({ 'GET /api/auth/me': meSignedOut });
  renderPage(Method);
  return screen.getByRole('main');
}

const words = (text: string): number =>
  text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** The body text of the page: tables, figure captions, and decoration are not counted. */
function bodyWords(main: HTMLElement): number {
  const copy = main.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll('table, figcaption, [aria-hidden], .sr-only')) {
    el.remove();
  }
  return words(copy.textContent ?? '');
}

describe('/method: structure', () => {
  it('has one h1, ordered headings, and the five sections in order', () => {
    const main = renderMethod();
    expect(
      within(main).getByRole('heading', { level: 1, name: 'How Evidomo works' }),
    ).toBeDefined();
    expect(within(main).getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual([
      'What you give it',
      'Where every sentence comes from',
      'What happened to the example listing',
      'How well does it work?',
      'What it will not do',
    ]);
    const levels = within(main)
      .getAllByRole('heading')
      .map((h) => Number(h.tagName.slice(1)));
    levels.forEach((level, i) => {
      if (i > 0) expect(level - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1);
    });
  });

  it('has an index whose links reach stable anchors on the sections', () => {
    const main = renderMethod();
    const nav = within(main).getByRole('navigation', { name: 'On this page' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '#inputs',
      '#sources',
      '#example',
      '#tests',
      '#limits',
    ]);
    expect(METHOD_ANCHORS).toEqual(['inputs', 'sources', 'example', 'tests', 'limits']);
    for (const link of links) {
      const target = main.querySelector(link.getAttribute('href') as string);
      expect(target?.tagName).toBe('SECTION');
      // The section is named by its heading, which the index link repeats.
      expect(target?.getAttribute('aria-labelledby')).toBeTruthy();
      expect(link.className).toContain('min-h-11');
    }
  });

  it('keeps to about 650 words of body text', () => {
    const count = bodyWords(renderMethod());
    expect(count).toBeGreaterThan(450);
    expect(count).toBeLessThanOrEqual(700);
  });

  it('uses no internal jargon or technical names anywhere on the page', () => {
    const text = renderMethod().textContent ?? '';
    expect(text).not.toMatch(
      /NEN ?2580|BBMI|provenance|\bgate\b|pipeline|validator|\bSAM\b|Spark|Muse|fact id|audited page|segment|cassette|synthetic/i,
    );
  });

  it('keeps each ledger line to 20 words and each limit to 25', () => {
    for (const row of Object.values(en.method.ledger.rows)) {
      expect(words(row.replace(/\{\w+\}/g, '9')), row).toBeLessThanOrEqual(20);
    }
    for (const limit of Object.values(en.method.numbers.limits)) {
      expect(words(limit), limit).toBeLessThanOrEqual(25);
    }
  });

  it('shows no honey except the open claim of the example, no source switch, and no source links', () => {
    const main = renderMethod();
    expect(main.querySelectorAll('.claim')).toHaveLength(1);
    expect(main.querySelector('.claim')?.closest('blockquote')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /sources/i })).toBeNull();
    expect(within(main).queryByRole('heading', { name: 'Sources' })).toBeNull();
    // Only the footer links to GitHub.
    const github = [...document.querySelectorAll('a[href]')].filter((a) =>
      (a.getAttribute('href') ?? '').includes('github.com'),
    );
    expect(github.map((a) => a.getAttribute('href'))).toEqual([REPOSITORY_URL]);
    expect(github[0]?.closest('footer')).not.toBeNull();
  });
});

describe('/method: §1 what you give it', () => {
  it('names the photos, the voice walkthrough, and the form, says video is not used, and says what comes back', () => {
    const main = renderMethod();
    const section = main.querySelector('#inputs') as HTMLElement;
    expect(within(section).getByRole('heading', { name: '10 to 30 photos' })).toBeDefined();
    expect(within(section).getByRole('heading', { name: 'A voice walkthrough' })).toBeDefined();
    expect(within(section).getByRole('heading', { name: 'A short form' })).toBeDefined();
    expect(section.textContent).toMatch(/2 to 10 minutes/);
    expect(section.textContent).toMatch(/Record it in your browser, or upload an audio file/);
    expect(section.textContent).toContain('Evidomo does not use video');
    expect(within(section).getByRole('heading', { name: 'What you get back' })).toBeDefined();
  });
});

describe('/method: §2 where every sentence comes from', () => {
  it('names the three evidence types in three short lines', () => {
    const main = renderMethod();
    const section = main.querySelector('#sources') as HTMLElement;
    for (const line of Object.values(en.method.types)) {
      expect(section.textContent).toContain(line);
      expect(words(line)).toBeLessThanOrEqual(12);
    }
  });

  it('opens the 1987 claim with its voice turn and the form value it replaced, and says it is a replay', () => {
    const main = renderMethod();
    expect(
      within(main)
        .getByRole('button', { name: /Year built/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    const evidence = within(main).getByRole('region', { name: /What “1987” is based on/ });
    expect(evidence.textContent).toContain('at 00:11');
    expect(evidence.textContent).toContain('“in 1987 gebouwd”');
    expect(evidence.textContent).toContain('Year built: 1986');
    expect(evidence.textContent).toContain('who kept 1987');
    expect(main.textContent).toMatch(
      /replay of a saved example.*made up.*computer-made.*plays silence/s,
    );
    fireEvent.click(within(main).getByRole('button', { name: /Energy label/ }));
    expect(within(main).getByRole('region', { name: /energy label B/ }).textContent).toContain(
      '“Het energielabel is B”',
    );
  });
});

describe('/method: §3 the example listing', () => {
  it('lists the ten steps and the two stops, the stops set heavier, with the slips said plainly', () => {
    const main = renderMethod();
    const section = main.querySelector('#example') as HTMLElement;
    expect(section.querySelectorAll('ol > li')).toHaveLength(LEDGER_ROWS.length);
    const stops = within(section).getAllByText('Evidomo stops here');
    expect(stops).toHaveLength(2);
    for (const stop of stops) expect(stop.closest('li')?.className).toContain('border-t-4');
    expect(within(section).getByText(/3 facts disagree/)).toBeDefined();
    // The bedroom slip: an empty living room was taken for a bedroom.
    expect(section.textContent).toMatch(/mistook an empty room for a bedroom/);
    // Evidomo runs every step; only the stops are decided by the agent.
    expect(section.textContent).toContain(
      'Evidomo does every step by itself. At two points it stops and waits for you to decide.',
    );
  });
});

describe('/method: §4 how well it works and §5 what it will not do', () => {
  it('shows the test table with its date, at most four limits, and the misheard-word slip', () => {
    const main = renderMethod();
    const section = main.querySelector('#tests') as HTMLElement;
    expect(section.querySelectorAll('tbody tr')).toHaveLength(5);
    expect(section.textContent).toContain('October 30, 2026');
    expect(section.textContent).toMatch(/with 6 made-up sets/);
    expect(section.textContent).toContain('14 / 14');
    const limits = section.querySelectorAll('ul > li');
    expect(limits.length).toBeLessThanOrEqual(4);
    expect(section.textContent).toContain('If a word was misheard, it can slip through');
  });

  it('lists the boundaries and the data handling in one numbered list, without hosting claims', () => {
    const main = renderMethod();
    const section = main.querySelector('#limits') as HTMLElement;
    expect(section.querySelectorAll('ol > li')).toHaveLength(9);
    const text = section.textContent ?? '';
    for (const phrase of [
      'Value a home',
      'Give legal advice',
      'Screen, score, or rank buyers',
      'Publish to a listing site',
      'hide a flaw or alter the building',
      'location data',
      'number plate',
      'Photos, voice, facts, and the listing are removed',
      'AI models train on your content',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    expect(main.textContent).not.toMatch(/\bEU\b|Europe|GDPR/);
  });
});

describe('/method: round 8 clarity fixes', () => {
  it('separates footnote markers from numbers and gives each an accessible name', () => {
    const main = renderMethod();
    const sentence = main.querySelector('blockquote[lang="en"]');
    expect(sentence?.textContent).toBe(
      'The building dates from 1987[1], Note 1 and has energy label B[2], Note 2 issued in 2023[3], Note 3.',
    );
    for (const marker of sentence?.querySelectorAll('sup') ?? []) {
      expect(marker.querySelector('[aria-hidden]')?.textContent).toMatch(/^\[\d\]$/);
      expect(marker.querySelector('.sr-only')?.textContent).toMatch(/^, Note \d$/);
    }
  });

  it('says which example its numbers come from and links to the examples', () => {
    const main = renderMethod();
    const note = within(main).getByText(/are from one example: the made-up three-room apartment/);
    expect(note.textContent).toContain('Other examples differ');
    const link = within(note).getByRole('link', { name: 'All examples' });
    expect(link.getAttribute('href')).toBe('/demo');
  });
});
