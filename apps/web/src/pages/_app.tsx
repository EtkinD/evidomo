import { QueryClientProvider } from '@tanstack/react-query';
import type { AppProps } from 'next/app';
import { Newsreader, Source_Sans_3 } from 'next/font/google';
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
const newsreader = Newsreader({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-newsreader',
});

type AppPropsWithAuth = AppProps & { Component: NextPageWithAuth };

export default function App({ Component, pageProps }: AppPropsWithAuth) {
  // One client per browser session; lazily created so a re-render never replaces the cache.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
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
