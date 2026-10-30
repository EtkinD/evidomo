import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AA_TEXT, contrastRatio } from '../showcase/contrast';
import {
  COLOR_KEYS,
  PALETTES,
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

  it('matches the contrast script on a known product pair', () => {
    // evidomo-light base-content on base-100 measured by the skill's script: see check-contrast.ts.
    const ratio = contrastRatio('oklch(24% 0.02 250)', 'oklch(99% 0.003 240)');
    expect(ratio).toBeGreaterThan(12);
    expect(contrastRatio('oklch(100% 0 0)', 'oklch(0% 0 0)')).toBeCloseTo(21, 1);
  });

  it('has no theme left for the removed directions', () => {
    expect(css).not.toMatch(/ledger|signal/);
    expect(css.match(/name: '/g)).toHaveLength(6);
  });

  it('keeps candidate themes out of the product stylesheet', () => {
    expect(globals).not.toMatch(/ledger|hearth|signal|\bclay\b|\bcanal\b/);
    expect(globals).toContain("@source not '../showcase'");
    expect(globals).toContain("@source not '../pages/showcase'");
  });
});
