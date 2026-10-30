import { QueryClientProvider } from '@tanstack/react-query';
import type { AppProps } from 'next/app';
import { Newsreader, Source_Sans_3 } from 'next/font/google';
import Head from 'next/head';
import { useState } from 'react';
import { AppShell } from '../components/AppShell';
import { AuthGate } from '../components/AuthGate';
import type { NextPageWithAuth } from '../lib/page-auth';
import { createQueryClient } from '../lib/query-client';
import '../styles/globals.css';

// Dev-only showcase utilities. next.config.ts aliases this module to the real stylesheet on the dev
// server and to an empty one in production builds, so none of that CSS ships.
import 'showcase-styles';

// Self-hosted at build time by next/font (no request to Google from the browser). Each family is a
// CSS variable that `@theme inline` in globals.css maps to `font-sans` and `font-display`.
const sourceSans = Source_Sans_3({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-source-sans',
});
// Italic is real (footnotes, captions, the masthead line), and the optical-size axis lets large
// headings draw with finer strokes than text sizes.
const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  axes: ['opsz'],
  display: 'swap',
  variable: '--font-newsreader',
});

// Optional production origin (non-secret, inlined at build time). Open Graph images should be
// absolute URLs; without it the path stays relative.
const SITE_ORIGIN = (process.env['NEXT_PUBLIC_SITE_ORIGIN'] ?? '').replace(/\/+$/, '');
const OG_IMAGE = `${SITE_ORIGIN}/og.png`;

type AppPropsWithAuth = AppProps & { Component: NextPageWithAuth };

export default function App({ Component, pageProps }: AppPropsWithAuth) {
  // One client per browser session; lazily created so a re-render never replaces the cache.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Keyed defaults: a page's own <Head> can replace any of them. */}
      <Head>
        <meta key="og:site_name" property="og:site_name" content="Evidomo" />
        <meta key="og:type" property="og:type" content="website" />
        <meta key="og:title" property="og:title" content="Evidomo" />
        <meta key="og:description" property="og:description" content="Evidence for every home." />
        <meta key="og:image" property="og:image" content={OG_IMAGE} />
        <meta key="og:image:width" property="og:image:width" content="1200" />
        <meta key="og:image:height" property="og:image:height" content="630" />
        <meta
          key="og:image:alt"
          property="og:image:alt"
          content="Evidomo: evidence for every home."
        />
        <meta key="twitter:card" name="twitter:card" content="summary_large_image" />
        <meta key="twitter:image" name="twitter:image" content={OG_IMAGE} />
      </Head>
      {/* The font variables must be defined above every element that uses them. */}
      <div className={`${sourceSans.variable} ${newsreader.variable} font-sans`}>
        {Component.bare ? (
          <Component {...pageProps} />
        ) : (
          <AppShell>
            {/* Pages opt in with `Page.auth`; public pages (and the demo replay) set nothing. */}
            <AuthGate mode={Component.auth}>
              <Component {...pageProps} />
            </AuthGate>
          </AppShell>
        )}
      </div>
    </QueryClientProvider>
  );
}
