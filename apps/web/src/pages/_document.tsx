import { Head, Html, Main, NextScript } from 'next/document';
import { THEME_COLORS, THEME_INIT_SCRIPT } from '../lib/theme';

export default function Document() {
  return (
    // No lang here: Next sets it from the active locale.
    <Html>
      <Head>
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        {/* The System pair; lib/theme.ts repoints both when Light or Dark is chosen. */}
        <meta
          name="theme-color"
          content={THEME_COLORS.light}
          media="(prefers-color-scheme: light)"
        />
        <meta name="theme-color" content={THEME_COLORS.dark} media="(prefers-color-scheme: dark)" />
        {/* After the meta tags it updates. Applies the stored theme before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </Head>
      <body className="antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
