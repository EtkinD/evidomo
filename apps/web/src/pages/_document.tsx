import { Head, Html, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        {/* Token hex values of base-100 in evidomo-light / evidomo-dark (see site.webmanifest). */}
        <meta name="theme-color" content="#fefbf5" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#28201a" media="(prefers-color-scheme: dark)" />
      </Head>
      <body className="antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
