import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../messages/en.json';
import { METHOD_ANCHORS, METHOD_SOURCES } from '../lib/landing-sources';
import { LEDGER_ROWS } from '../lib/sample-run';
import { resetShowSources, setShowSources } from '../lib/sources';
import Method from '../pages/method';
import { setRoute } from './router-mock';
import { meSignedOut, mockFetch, renderPage } from './test-utils';

vi.mock('next/router', () => import('./router-mock'));

beforeEach(() => {
  window.localStorage.clear();
  resetShowSources();
});

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

/** The body text of the page: tables, figure captions, sources, and decoration are not counted. */
function bodyWords(main: HTMLElement): number {
  const copy = main.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll(
    'table, figcaption, [data-method-sources], [aria-hidden], .sr-only',
  )) {
    el.remove();
  }
  return words(copy.textContent ?? '');
}

describe('/method: structure', () => {
  it('has one h1, ordered headings, and the four sections in order', () => {
    const main = renderMethod();
    expect(
      within(main).getByRole('heading', { level: 1, name: 'How Evidomo checks a listing' }),
    ).toBeDefined();
    expect(within(main).getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      within(main)
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual([
      'Every claim has a source',
      'What happened to the sample listing',
      'The numbers, and their limits',
      'What it will not do, and what it removes',
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
      '#sources',
      '#sample-run',
      '#numbers',
      '#limits-and-data',
    ]);
    expect(METHOD_ANCHORS).toEqual(['sources', 'sample-run', 'numbers', 'limits-and-data']);
    for (const link of links) {
      const target = main.querySelector(link.getAttribute('href') as string);
      expect(target?.tagName).toBe('SECTION');
      // The section is named by its heading, which the index link repeats.
      expect(target?.getAttribute('aria-labelledby')).toBeTruthy();
      expect(link.className).toContain('min-h-11');
    }
  });

  it('keeps to about 600 words of body text', () => {
    const count = bodyWords(renderMethod());
    expect(count).toBeGreaterThan(450);
    expect(count).toBeLessThanOrEqual(650);
  });

  it('keeps each ledger line to 20 words and each limit to 25', () => {
    for (const row of Object.values(en.method.ledger.rows)) {
      expect(words(row.replace(/\{\w+\}/g, '9')), row).toBeLessThanOrEqual(20);
    }
    for (const limit of Object.values(en.method.numbers.limits)) {
      expect(words(limit), limit).toBeLessThanOrEqual(25);
    }
  });

  it('shows no honey except the open claim of the specimen, and no Show sources', () => {
    setShowSources(true); // a visitor who turned sources on at the landing page
    const main = renderMethod();
    expect(main.querySelectorAll('.claim')).toHaveLength(1);
    expect(main.querySelector('.claim')?.closest('blockquote')).not.toBeNull();
    expect(
      main.querySelectorAll('.claim-on, [data-source-note], [data-claim-source]'),
    ).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Show sources' })).toBeNull();
  });
});

describe('/method: §1 every claim has a source', () => {
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
        .getByRole('button', { name: /Build year/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    const evidence = within(main).getByRole('region', { name: /What “1987” rests on/ });
    expect(evidence.textContent).toContain('turn at 00:11');
    expect(evidence.textContent).toContain('“in 1987 gebouwd”');
    expect(evidence.textContent).toContain('Build year: 1986');
    expect(evidence.textContent).toContain('the spoken 1987 was kept');
    expect(main.textContent).toMatch(
      /replay.*recorded once.*synthetic speech.*sample file plays silence/s,
    );
    fireEvent.click(within(main).getByRole('button', { name: /Energy label/ }));
    expect(within(main).getByRole('region', { name: /energy label B/ }).textContent).toContain(
      '“Het energielabel is B”',
    );
  });
});

describe('/method: §2 the sample listing', () => {
  it('lists the ten steps and the two stops, the stops set heavier, with the slips said plainly', () => {
    const main = renderMethod();
    const section = main.querySelector('#sample-run') as HTMLElement;
    const rows = section.querySelectorAll('ol > li');
    // 12 ledger rows (the source list is an ol too, inside its own wrapper).
    const ledger = [...rows].filter((li) => !li.closest('[data-method-sources]'));
    expect(ledger).toHaveLength(LEDGER_ROWS.length);
    const stops = within(section).getAllByText('The run stops here');
    expect(stops).toHaveLength(2);
    for (const stop of stops) expect(stop.closest('li')?.className).toContain('border-t-4');
    expect(within(section).getByText(/3 conflicts surface/)).toBeDefined();
    // The bedroom slip: an empty living room was taken for a bedroom.
    expect(section.textContent).toMatch(/took an empty living room for a bedroom/);
    // Evidomo runs every step; only the stops are decided by the agent.
    expect(section.textContent).toContain('Evidomo runs every step. At the two stops, you decide.');
  });
});

describe('/method: §3 the numbers and §4 what it will not do', () => {
  it('shows the eval table with its date and mode, at most four limits, and the audio slip', () => {
    const main = renderMethod();
    const section = main.querySelector('#numbers') as HTMLElement;
    expect(section.querySelectorAll('tbody tr')).toHaveLength(6);
    expect(section.textContent).toContain('October 30, 2026');
    expect(section.textContent).toMatch(/fixture mode, 6 synthetic sets/);
    expect(section.textContent).toContain('14 / 14');
    const limits = section.querySelectorAll('ul > li');
    expect(limits.length).toBeLessThanOrEqual(4);
    expect(section.textContent).toContain('“L-vormige”');
    expect(section.textContent).toContain('“ellipsvormige”');
  });

  it('lists the boundaries and the data handling in one numbered list, without hosting claims', () => {
    const main = renderMethod();
    const section = main.querySelector('#limits-and-data') as HTMLElement;
    const items = [...section.querySelectorAll('ol > li')].filter(
      (li) => !li.closest('[data-method-sources]'),
    );
    expect(items).toHaveLength(9);
    const text = section.textContent ?? '';
    for (const phrase of [
      'Value a property',
      'Interpret law',
      'Screen, score, or rank buyers',
      'Publish to a portal',
      'hide a defect or change the structure',
      'GPS',
      'license plate',
      'photos, voice memo, facts, and pack are removed',
      'Standard-mode models',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    expect(main.textContent).not.toMatch(/\bEU\b|Europe|GDPR/);
  });
});

describe('/method: sources', () => {
  it('ends every section with its numbered sources, one link each', () => {
    const main = renderMethod();
    for (const anchor of METHOD_ANCHORS) {
      const section = main.querySelector(`#${anchor}`) as HTMLElement;
      const list = section.querySelector('[data-method-sources]') as HTMLElement;
      expect(list, anchor).not.toBeNull();
      // It closes the section.
      expect(section.lastElementChild?.lastElementChild).toBe(list);
      expect(within(list).getByRole('heading', { name: 'Sources' }).tagName).toBe('H3');
      const links = within(list).getAllByRole('link');
      expect(links).toHaveLength(METHOD_SOURCES[anchor].length);
      for (const link of links) {
        expect(link.getAttribute('href')).toMatch(
          /^(https:\/\/github\.com\/EtkinD\/evidomo\/blob\/main\/|\/demo)/,
        );
        expect(link.className).toContain('min-h-11');
      }
    }
  });

  it('names each source by type, in words', () => {
    const main = renderMethod();
    const kinds = new Set(
      [...main.querySelectorAll('[data-method-sources] li > span:nth-child(2)')].map(
        (s) => s.textContent,
      ),
    );
    expect(kinds).toEqual(
      new Set(['Sample run', 'Eval report', 'Enforced in code', 'Product rule']),
    );
  });
});
