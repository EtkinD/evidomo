import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AA_TEXT, contrastRatio } from '../showcase/contrast';
import { COLOR_KEYS, PALETTE, SHAPE, THEME_NAMES, type Mode } from '../showcase/palettes';

const globals = readFileSync(resolve(import.meta.dirname, '../styles/globals.css'), 'utf8');
const showcaseCss = readFileSync(resolve(import.meta.dirname, '../styles/showcase.css'), 'utf8');

function themeBlock(name: string): string {
  const match = new RegExp(`@plugin "daisyui/theme" \\{[^}]*name: '${name}'[^}]*\\}`).exec(globals);
  if (match === null) throw new Error(`theme ${name} missing from globals.css`);
  return match[0];
}

const modes: Mode[] = ['light', 'dark'];

describe('the colours page shows the product theme', () => {
  it.each(modes)('palettes.ts matches the %s theme in globals.css', (mode) => {
    const block = themeBlock(THEME_NAMES[mode]);
    for (const key of COLOR_KEYS) {
      expect(block).toContain(`--color-${key}: ${PALETTE[mode][key]};`);
    }
    expect(block).toContain(`--radius-selector: ${SHAPE.radiusSelector};`);
    expect(block).toContain(`--radius-field: ${SHAPE.radiusField};`);
    expect(block).toContain(`--radius-box: ${SHAPE.radiusBox};`);
    expect(block).toContain('--depth: 0;');
  });

  it.each(modes)('every text pair passes AA (%s)', (mode) => {
    const p = PALETTE[mode];
    for (const surface of ['base-100', 'base-200', 'base-300'] as const) {
      expect(contrastRatio(p['base-content'], p[surface])).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrastRatio(p['base-content'], p[surface], 0.7)).toBeGreaterThanOrEqual(AA_TEXT);
      for (const role of ['primary', 'secondary', 'info', 'success', 'error'] as const) {
        expect(contrastRatio(p[role], p[surface])).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
    for (const role of [
      'primary',
      'secondary',
      'accent',
      'neutral',
      'info',
      'success',
      'warning',
      'error',
    ] as const) {
      expect(contrastRatio(p[`${role}-content`], p[role])).toBeGreaterThanOrEqual(AA_TEXT);
    }
    // The logo's check mark sits on the secondary window.
    expect(contrastRatio(p['secondary-content'], p.secondary)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('matches the contrast script on a known pair', () => {
    expect(contrastRatio('oklch(100% 0 0)', 'oklch(0% 0 0)')).toBeCloseTo(21, 1);
  });
});

describe('stylesheets', () => {
  it('defines only the two product themes and no candidate theme', () => {
    expect(globals.match(/@plugin "daisyui\/theme"/g)).toHaveLength(2);
    expect(showcaseCss).not.toContain('daisyui/theme');
    expect(globals).not.toMatch(/ledger|hearth|signal|\bclay\b|\bcanal\b|\bcombo\b/);
  });

  it('keeps showcase utilities out of the product stylesheet', () => {
    expect(globals).toContain("@source not '../showcase'");
    expect(globals).toContain("@source not '../pages/showcase'");
  });

  it('maps the body and display faces in both stylesheets', () => {
    for (const css of [globals, showcaseCss]) {
      expect(css).toContain('--font-sans: var(--font-source-sans)');
      expect(css).toContain('--font-display: var(--font-newsreader)');
    }
    expect(globals).toMatch(/h1,\s*h2,\s*h3,\s*h4,\s*\.card-title\s*\{\s*@apply font-display;/);
  });
});
