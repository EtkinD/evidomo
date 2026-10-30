// The approved palette (P4B-02), shown by the colours page with measured contrast. The values must
// equal the `evidomo-light` / `evidomo-dark` blocks in `src/styles/globals.css`; a test enforces it.
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
export type Mode = 'light' | 'dark';

export interface ThemeShape {
  readonly radiusSelector: string;
  readonly radiusField: string;
  readonly radiusBox: string;
}

export const SHAPE: ThemeShape = {
  radiusSelector: '0.5rem',
  radiusField: '0.5rem',
  radiusBox: '0.875rem',
};

export const THEME_NAMES: Readonly<Record<Mode, string>> = {
  light: 'evidomo-light',
  dark: 'evidomo-dark',
};

export const PALETTE: Readonly<Record<Mode, Palette>> = {
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
};
