// WCAG 2.x contrast for oklch tokens. Same maths as
// .claude/skills/evidomo-theme/scripts/check-contrast.ts (which stays the CI-style gate); this copy
// lets the colours page show the measured ratios.
type Rgb = [number, number, number];

function oklchToLinearSrgb(value: string): Rgb {
  const match = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (match === null) throw new Error(`Unsupported colour "${value}" (use oklch(L% C H))`);
  const l = Number(match[1]) / 100;
  const c = Number(match[2]);
  const h = (Number(match[3]) * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
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
const luminance = ([r, g, b]: Rgb): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** sRGB hex of an oklch colour, for display next to a swatch. */
export function oklchToHex(value: string): string {
  const hex = oklchToLinearSrgb(value).map((channel) =>
    Math.round(encode(channel) * 255)
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${hex.join('')}`;
}

/** Contrast ratio of `foreground` (at `alpha`) over an opaque `background`. */
export function contrastRatio(foreground: string, background: string, alpha = 1): number {
  const fg = oklchToLinearSrgb(foreground).map(encode);
  const bgLinear = oklchToLinearSrgb(background);
  const bg = bgLinear.map(encode);
  const blended = fg.map((f, i) => decode(alpha * f + (1 - alpha) * (bg[i] ?? 0))) as Rgb;
  const [hi, lo] = [luminance(blended), luminance(bgLinear)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

export const AA_TEXT = 4.5;
