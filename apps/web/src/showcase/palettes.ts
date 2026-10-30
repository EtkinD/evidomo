// Showcase candidates, removed after P4B-02. The values here must equal the theme blocks in
// `src/styles/showcase.css` (a test enforces it); the colours page measures contrast from them.
export const COLOR_KEYS = [
  'base-100',
  'base-200',
  'base-300',
  'base-content',
  'primary',
  'primary-content',
  'secondary',
  'secondary-content',
  'accent',
  'accent-content',
  'neutral',
  'neutral-content',
  'info',
  'info-content',
  'success',
  'success-content',
  'warning',
  'warning-content',
  'error',
  'error-content',
] as const;

export type ColorKey = (typeof COLOR_KEYS)[number];
export type Palette = Readonly<Record<ColorKey, string>>;
export type DirectionId = 'B' | 'B2' | 'B3';
export type Mode = 'light' | 'dark';

export interface ThemeShape {
  readonly radiusSelector: string;
  readonly radiusField: string;
  readonly radiusBox: string;
}

export const SHAPES: Readonly<Record<DirectionId, ThemeShape>> = {
  B: { radiusSelector: '0.75rem', radiusField: '0.75rem', radiusBox: '1.25rem' },
  // Clay: rounder than Hearth.
  B2: { radiusSelector: '1rem', radiusField: '1rem', radiusBox: '1.75rem' },
  // Canal: slightly tighter than Hearth.
  B3: { radiusSelector: '0.5rem', radiusField: '0.5rem', radiusBox: '0.875rem' },
};

export const THEME_NAMES: Readonly<Record<DirectionId, Readonly<Record<Mode, string>>>> = {
  B: { light: 'hearth-light', dark: 'hearth-dark' },
  B2: { light: 'clay-light', dark: 'clay-dark' },
  B3: { light: 'canal-light', dark: 'canal-dark' },
};

export const PALETTES: Readonly<Record<DirectionId, Readonly<Record<Mode, Palette>>>> = {
  B: {
    light: {
      'base-100': 'oklch(98.5% 0.01 80)',
      'base-200': 'oklch(96% 0.016 80)',
      'base-300': 'oklch(91% 0.022 75)',
      'base-content': 'oklch(26% 0.03 45)',
      primary: 'oklch(47% 0.14 35)',
      'primary-content': 'oklch(98% 0.01 60)',
      secondary: 'oklch(38% 0.07 160)',
      'secondary-content': 'oklch(98% 0.01 160)',
      accent: 'oklch(83% 0.09 80)',
      'accent-content': 'oklch(28% 0.05 60)',
      neutral: 'oklch(30% 0.03 50)',
      'neutral-content': 'oklch(97% 0.01 70)',
      info: 'oklch(46% 0.09 235)',
      'info-content': 'oklch(98% 0.01 235)',
      success: 'oklch(45% 0.1 150)',
      'success-content': 'oklch(98% 0.01 150)',
      warning: 'oklch(82% 0.14 80)',
      'warning-content': 'oklch(30% 0.06 60)',
      error: 'oklch(48% 0.2 20)',
      'error-content': 'oklch(98% 0.01 20)',
    },
    dark: {
      'base-100': 'oklch(22% 0.02 50)',
      'base-200': 'oklch(19% 0.018 50)',
      'base-300': 'oklch(16% 0.015 50)',
      'base-content': 'oklch(93% 0.015 80)',
      primary: 'oklch(74% 0.12 40)',
      'primary-content': 'oklch(21% 0.04 40)',
      secondary: 'oklch(76% 0.09 160)',
      'secondary-content': 'oklch(20% 0.03 160)',
      accent: 'oklch(82% 0.09 80)',
      'accent-content': 'oklch(24% 0.05 60)',
      neutral: 'oklch(32% 0.03 50)',
      'neutral-content': 'oklch(93% 0.015 80)',
      info: 'oklch(75% 0.09 235)',
      'info-content': 'oklch(20% 0.03 235)',
      success: 'oklch(75% 0.11 150)',
      'success-content': 'oklch(20% 0.03 150)',
      warning: 'oklch(83% 0.13 80)',
      'warning-content': 'oklch(24% 0.05 60)',
      error: 'oklch(72% 0.16 20)',
      'error-content': 'oklch(20% 0.04 20)',
    },
  },
  B2: {
    light: {
      'base-100': 'oklch(98.8% 0.008 85)',
      'base-200': 'oklch(96.5% 0.014 85)',
      'base-300': 'oklch(92.5% 0.02 80)',
      'base-content': 'oklch(30% 0.025 50)',
      primary: 'oklch(52% 0.1 42)',
      'primary-content': 'oklch(99% 0.008 70)',
      secondary: 'oklch(44% 0.06 135)',
      'secondary-content': 'oklch(98% 0.01 135)',
      accent: 'oklch(85% 0.1 85)',
      'accent-content': 'oklch(30% 0.05 65)',
      neutral: 'oklch(36% 0.025 55)',
      'neutral-content': 'oklch(97% 0.01 80)',
      info: 'oklch(48% 0.07 235)',
      'info-content': 'oklch(98% 0.01 235)',
      success: 'oklch(47% 0.08 150)',
      'success-content': 'oklch(98% 0.01 150)',
      warning: 'oklch(84% 0.12 85)',
      'warning-content': 'oklch(30% 0.06 65)',
      error: 'oklch(50% 0.16 25)',
      'error-content': 'oklch(98% 0.01 25)',
    },
    dark: {
      'base-100': 'oklch(25% 0.016 55)',
      'base-200': 'oklch(22% 0.014 55)',
      'base-300': 'oklch(19% 0.012 55)',
      'base-content': 'oklch(93% 0.012 85)',
      primary: 'oklch(77% 0.09 45)',
      'primary-content': 'oklch(22% 0.035 45)',
      secondary: 'oklch(77% 0.07 135)',
      'secondary-content': 'oklch(21% 0.03 135)',
      accent: 'oklch(84% 0.09 85)',
      'accent-content': 'oklch(25% 0.045 65)',
      neutral: 'oklch(34% 0.022 55)',
      'neutral-content': 'oklch(93% 0.012 85)',
      info: 'oklch(77% 0.07 235)',
      'info-content': 'oklch(21% 0.03 235)',
      success: 'oklch(77% 0.09 150)',
      'success-content': 'oklch(21% 0.03 150)',
      warning: 'oklch(84% 0.11 85)',
      'warning-content': 'oklch(25% 0.05 65)',
      error: 'oklch(74% 0.13 25)',
      'error-content': 'oklch(21% 0.04 25)',
    },
  },
  B3: {
    light: {
      'base-100': 'oklch(97.5% 0.008 90)',
      'base-200': 'oklch(94.5% 0.012 90)',
      'base-300': 'oklch(89% 0.016 85)',
      'base-content': 'oklch(22% 0.025 40)',
      primary: 'oklch(40% 0.14 22)',
      'primary-content': 'oklch(98% 0.01 60)',
      secondary: 'oklch(36% 0.065 195)',
      'secondary-content': 'oklch(98% 0.01 195)',
      accent: 'oklch(78% 0.11 90)',
      'accent-content': 'oklch(25% 0.05 70)',
      neutral: 'oklch(27% 0.02 220)',
      'neutral-content': 'oklch(96% 0.01 90)',
      info: 'oklch(44% 0.09 245)',
      'info-content': 'oklch(98% 0.01 245)',
      success: 'oklch(42% 0.09 160)',
      'success-content': 'oklch(98% 0.01 160)',
      warning: 'oklch(80% 0.13 85)',
      'warning-content': 'oklch(28% 0.06 65)',
      error: 'oklch(46% 0.19 25)',
      'error-content': 'oklch(98% 0.01 25)',
    },
    dark: {
      'base-100': 'oklch(17% 0.014 215)',
      'base-200': 'oklch(14% 0.012 215)',
      'base-300': 'oklch(11% 0.01 215)',
      'base-content': 'oklch(92% 0.012 90)',
      primary: 'oklch(72% 0.13 25)',
      'primary-content': 'oklch(18% 0.04 25)',
      secondary: 'oklch(74% 0.08 195)',
      'secondary-content': 'oklch(17% 0.03 195)',
      accent: 'oklch(80% 0.11 90)',
      'accent-content': 'oklch(21% 0.045 70)',
      neutral: 'oklch(26% 0.018 215)',
      'neutral-content': 'oklch(92% 0.012 90)',
      info: 'oklch(74% 0.09 245)',
      'info-content': 'oklch(17% 0.03 245)',
      success: 'oklch(74% 0.1 160)',
      'success-content': 'oklch(17% 0.03 160)',
      warning: 'oklch(81% 0.12 85)',
      'warning-content': 'oklch(21% 0.05 65)',
      error: 'oklch(70% 0.15 25)',
      'error-content': 'oklch(17% 0.04 25)',
    },
  },
};

// Round 3 combination, marked "showcase candidate, removed after P4B-02": B2's colours with B3's
// shape tokens. It shares the B2 palette object, so the palette test stays the single source of
// truth for the colour values.
export const COMBO_THEME_NAMES: Readonly<Record<Mode, string>> = {
  light: 'combo-light',
  dark: 'combo-dark',
};
export const COMBO_PALETTES: Readonly<Record<Mode, Palette>> = PALETTES.B2;
export const COMBO_SHAPE: ThemeShape = SHAPES.B3;
