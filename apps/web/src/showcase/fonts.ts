import {
  Fraunces,
  IBM_Plex_Mono,
  Inter,
  JetBrains_Mono,
  Source_Sans_3,
  Space_Grotesk,
} from 'next/font/google';

// next/font needs literal options and a module-scope call. Loaded only by showcase pages, so
// the font files never reach the product bundle. Each family exposes a CSS variable that
// `styles/showcase.css` maps to the display/body/mono roles of a direction.
const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-sc-inter' });
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-sc-plex-mono',
});
const fraunces = Fraunces({ subsets: ['latin'], display: 'swap', variable: '--font-sc-fraunces' });
const sourceSans = Source_Sans_3({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sc-source-sans',
});
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sc-space-grotesk',
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sc-jetbrains-mono',
});

/** Class names that define every font variable; put them on the showcase root. */
export const FONT_VARIABLE_CLASSES: string = [
  inter,
  plexMono,
  fraunces,
  sourceSans,
  spaceGrotesk,
  jetbrainsMono,
]
  .map((font) => font.variable)
  .join(' ');
