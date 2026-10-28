// WCAG 2.x contrast check for the daisyUI themes defined in apps/web/src/styles/globals.css.
//
//   node .claude/skills/evidomo-theme/scripts/check-contrast.ts [path/to/globals.css]
//
// Reads every `@plugin "daisyui/theme" { ... }` block, converts its oklch colour tokens to sRGB,
// and checks the pairs the evidomo-theme skill relies on. Exits 1 when a required pair is below
// its threshold, so a theme edit cannot silently break contrast.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AA_TEXT = 4.5;
const SECONDARY_TEXT_ALPHA = 0.7;

/** Colour roles that have a `-content` counterpart (text on that colour as a background). */
const FILLED_ROLES = [
  'primary',
  'secondary',
  'accent',
  'neutral',
  'info',
  'success',
  'warning',
  'error',
] as const;

/**
 * Roles the UI may use as text or icons directly on a base surface (`link-primary`, `text-error`,
 * …). `accent` and `warning` are light by design and are background-only; the skill forbids them
 * as text, so they are not checked here.
 */
const TEXT_ROLES = ['primary', 'secondary', 'info', 'success', 'error'] as const;
const SURFACES = ['base-100', 'base-200', 'base-300'] as const;

type Rgb = [number, number, number];

interface Theme {
  readonly name: string;
  readonly colors: ReadonlyMap<string, string>;
}

interface Check {
  readonly theme: string;
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  readonly min: number;
}

function parseThemes(css: string): Theme[] {
  const themes: Theme[] = [];
  const blockPattern = /@plugin\s+"daisyui\/theme"\s*\{([^}]*)\}/g;
  for (const match of css.matchAll(blockPattern)) {
    const body = match[1] ?? '';
    // Prettier rewrites the theme name to single quotes; accept either.
    const name = /name:\s*["']([^"']+)["']/.exec(body)?.[1];
    if (name === undefined) throw new Error('A daisyui/theme block has no name');
    const colors = new Map<string, string>();
    for (const token of body.matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)) {
      const [, key, value] = token;
      if (key !== undefined && value !== undefined) colors.set(key, value.trim());
    }
    themes.push({ name, colors });
  }
  return themes;
}

/** `oklch(L% C H)` → linear-light sRGB channels, clamped to the sRGB gamut. */
function oklchToLinearSrgb(value: string): Rgb {
  const match = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (match === null) throw new Error(`Unsupported colour "${value}" (use oklch(L% C H))`);
  const l = Number(match[1]) / 100;
  const c = Number(match[2]);
  const h = (Number(match[3]) * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  // OKLab → LMS → linear sRGB (Björn Ottosson's reference matrices).
  const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number): number => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp),
    clamp(-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp),
    clamp(-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp),
  ];
}

const encode = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const decode = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminanceOf([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Linear sRGB of `foreground` at `alpha` over an opaque `background`. Browsers composite in
 * gamma-encoded sRGB, so blending happens on encoded channels.
 */
function composite(foreground: string, alpha: number, background: string): Rgb {
  const [fr, fg, fb] = oklchToLinearSrgb(foreground).map(encode);
  const [br, bg, bb] = oklchToLinearSrgb(background).map(encode);
  const mix = (f = 0, b = 0): number => decode(alpha * f + (1 - alpha) * b);
  return [mix(fr, br), mix(fg, bg), mix(fb, bb)];
}

function contrastOf(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

function contrast(foreground: string, background: string, alpha = 1): number {
  return contrastOf(composite(foreground, alpha, background), oklchToLinearSrgb(background));
}

function requireColor(theme: Theme, key: string): string {
  const value = theme.colors.get(key);
  if (value === undefined) throw new Error(`${theme.name}: missing --color-${key}`);
  return value;
}

function checksFor(theme: Theme): Check[] {
  const checks: Check[] = [];
  const add = (foreground: string, background: string, alpha = 1): void => {
    checks.push({
      theme: theme.name,
      foreground: alpha === 1 ? foreground : `${foreground}/${Math.round(alpha * 100)}`,
      background,
      ratio: contrast(requireColor(theme, foreground), requireColor(theme, background), alpha),
      min: AA_TEXT,
    });
  };
  for (const surface of SURFACES) {
    add('base-content', surface);
    // The skill's secondary-text opacity (`text-base-content/70`).
    add('base-content', surface, SECONDARY_TEXT_ALPHA);
  }
  for (const role of FILLED_ROLES) add(`${role}-content`, role);
  for (const role of TEXT_ROLES) {
    for (const surface of SURFACES) add(role, surface);
  }
  return checks;
}

const cssPath = resolve(process.argv[2] ?? 'apps/web/src/styles/globals.css');
const themes = parseThemes(readFileSync(cssPath, 'utf8'));
if (themes.length === 0) {
  console.error(`No @plugin "daisyui/theme" blocks found in ${cssPath}`);
  process.exit(1);
}

const results = themes.flatMap(checksFor);
for (const check of results) {
  const status = check.ratio >= check.min ? 'ok  ' : 'FAIL';
  const pair = `${check.foreground} on ${check.background}`.padEnd(32);
  console.log(`${status} ${check.theme.padEnd(14)} ${pair} ${check.ratio.toFixed(2)}:1`);
}
const failures = results.filter((check) => check.ratio < check.min);
if (failures.length > 0) {
  console.error(`\n${failures.length} pair(s) below WCAG AA (${AA_TEXT}:1).`);
  process.exit(1);
}
console.log(`\nAll ${results.length} pairs meet WCAG AA (${AA_TEXT}:1).`);
