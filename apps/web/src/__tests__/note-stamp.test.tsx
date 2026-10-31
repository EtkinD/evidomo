import { render, screen } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Note, type NoteTone } from '../components/Note';
import { Stamp } from '../components/Stamp';

describe('Note', () => {
  it.each(['info', 'success', 'warning', 'error'] as NoteTone[])(
    'puts the %s status in a left rule and an icon, and the text alone in the content',
    (tone) => {
      render(
        <Note tone={tone} role="status">
          Saved.
        </Note>,
      );
      const note = screen.getByRole('status');
      expect(note.textContent).toBe('Saved.');
      expect(note.className).toContain(`border-${tone}`);
      expect(note.className).toContain('border-l-4');
      // Colour is not the only cue: a decorative icon is there too (generated content).
      const icon = note.querySelector('[data-icon]');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      expect(icon?.getAttribute('data-icon')).toMatch(/\S/);
    },
  );

  it('keeps its role and accessible name, and never uses the daisyUI alert box', () => {
    render(
      <Note tone="warning" role="region" label="Warnings">
        <p>One</p>
      </Note>,
    );
    const note = screen.getByRole('region', { name: 'Warnings' });
    expect(note.className).not.toContain('alert');
  });

  it('places an action beside the message from sm up when split', () => {
    render(
      <Note tone="info" role="alert" split>
        <span>Message</span>
        <button type="button">Act</button>
      </Note>,
    );
    expect(screen.getByRole('alert').querySelector('div')?.className).toContain('sm:flex-row');
  });
});

describe('Stamp', () => {
  it.each(['verified', 'decision', 'kept', 'removed', 'staged', 'sample'] as const)(
    'writes the %s state in words; the mark is generated content',
    (tone) => {
      render(<Stamp tone={tone}>The state</Stamp>);
      const stamp = screen.getByText('The state');
      expect(stamp.textContent).toBe('The state');
      expect(stamp.getAttribute('data-stamp')).toBe(tone);
      expect(stamp.className).toContain('uppercase');
      expect(stamp.className).toContain('tracking-');
    },
  );

  it('can be the caption of a figure', () => {
    render(
      <figure>
        <Stamp tone="staged" as="figcaption">
          Virtually staged
        </Stamp>
      </figure>,
    );
    expect(screen.getByText('Virtually staged').tagName).toBe('FIGCAPTION');
  });
});

describe('the work screens carry no daisyUI alert box for info, success, or warning', () => {
  const root = resolve(__dirname, '..');
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === 'showcase' || name === '__tests__') return [];
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('uses Note instead', () => {
    const offenders = files(root).filter((file) =>
      /alert-(info|success|warning|error)/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
