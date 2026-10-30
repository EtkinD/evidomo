import { Figtree, Fraunces, Newsreader, Source_Sans_3 } from 'next/font/google';

// next/font needs literal options and a module-scope call. Loaded only by showcase pages, so
// the font files never reach the product bundle. Each family exposes a CSS variable that
// `styles/showcase.css` maps to the display/body roles of a direction.
const fraunces = Fraunces({ subsets: ['latin'], display: 'swap', variable: '--font-sc-fraunces' });
// Hearth Clay uses the same family with the SOFT and optical-size axes, which next/font only
// loads for the variable font; a second instance keeps Hearth's own file unchanged.
const frauncesSoft = Fraunces({
  subsets: ['latin'],
  axes: ['SOFT', 'opsz'],
  display: 'swap',
  variable: '--font-sc-fraunces-soft',
});
const sourceSans = Source_Sans_3({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sc-source-sans',
});
const figtree = Figtree({ subsets: ['latin'], display: 'swap', variable: '--font-sc-figtree' });
const newsreader = Newsreader({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sc-newsreader',
});

/** Class names that define every font variable; put them on the showcase root. */
export const FONT_VARIABLE_CLASSES: string = [
  fraunces,
  frauncesSoft,
  sourceSans,
  figtree,
  newsreader,
]
  .map((font) => font.variable)
  .join(' ');
