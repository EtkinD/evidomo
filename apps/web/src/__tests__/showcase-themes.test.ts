import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AA_TEXT, contrastRatio } from '../showcase/contrast';
import {
  COLOR_KEYS,
  COMBO_PALETTES,
  COMBO_SHAPE,
  COMBO_THEME_NAMES,
  PALETTES,
  SHAPES,
  THEME_NAMES,
  type DirectionId,
  type Mode,
} from '../showcase/palettes';

const css = readFileSync(resolve(import.meta.dirname, '../styles/showcase.css'), 'utf8');
const globals = readFileSync(resolve(import.meta.dirname, '../styles/globals.css'), 'utf8');

function themeBlock(name: string): string {
  const match = new RegExp(`@plugin "daisyui/theme" \\{[^}]*name: '${name}'[^}]*\\}`).exec(css);
  if (match === null) throw new Error(`theme ${name} missing from showcase.css`);
  return match[0];
}

const directions: DirectionId[] = ['B', 'B2', 'B3'];
const modes: Mode[] = ['light', 'dark'];

describe('showcase candidate themes', () => {
  it.each(directions.flatMap((d) => modes.map((m) => [d, m] as const)))(
    'palettes.ts matches showcase.css for %s %s',
    (direction, mode) => {
      const block = themeBlock(THEME_NAMES[direction][mode]);
      for (const key of COLOR_KEYS) {
        expect(block).toContain(`--color-${key}: ${PALETTES[direction][mode][key]};`);
      }
    },
  );

  it.each(directions.flatMap((d) => modes.map((m) => [d, m] as const)))(
    'every text pair passes AA for %s %s',
    (direction, mode) => {
      const p = PALETTES[direction][mode];
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
    },
  );

  it.each(modes)('the combination theme (%s) is B2 colours with B3 shape tokens', (mode) => {
    const block = themeBlock(COMBO_THEME_NAMES[mode]);
    expect(COMBO_PALETTES[mode]).toBe(PALETTES.B2[mode]);
    for (const key of COLOR_KEYS) {
      expect(block).toContain(`--color-${key}: ${PALETTES.B2[mode][key]};`);
    }
    expect(block).toContain(`--radius-selector: ${COMBO_SHAPE.radiusSelector};`);
    expect(block).toContain(`--radius-field: ${COMBO_SHAPE.radiusField};`);
    expect(block).toContain(`--radius-box: ${COMBO_SHAPE.radiusBox};`);
    expect(COMBO_SHAPE).toEqual(SHAPES.B3);
  });

  it.each(modes)('every text pair of the combination passes AA (%s)', (mode) => {
    const p = COMBO_PALETTES[mode];
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
    // Pairs the combination samples rely on beyond the palette tests above: the accent on the
    // neutral tile (logo mark), and the secondary-content mark on the secondary tile.
    expect(contrastRatio(p.accent, p.neutral)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(p['secondary-content'], p.secondary)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('matches the contrast script on a known product pair', () => {
    // evidomo-light base-content on base-100 measured by the skill's script: see check-contrast.ts.
    const ratio = contrastRatio('oklch(24% 0.02 250)', 'oklch(99% 0.003 240)');
    expect(ratio).toBeGreaterThan(12);
    expect(contrastRatio('oklch(100% 0 0)', 'oklch(0% 0 0)')).toBeCloseTo(21, 1);
  });

  it('has no theme left for the removed directions', () => {
    expect(css).not.toMatch(/ledger|signal/);
    expect(css.match(/name: '/g)).toHaveLength(8);
  });

  it('keeps candidate themes out of the product stylesheet', () => {
    expect(globals).not.toMatch(/ledger|hearth|signal|\bclay\b|\bcanal\b|\bcombo\b/);
    expect(globals).toContain("@source not '../showcase'");
    expect(globals).toContain("@source not '../pages/showcase'");
  });
});
