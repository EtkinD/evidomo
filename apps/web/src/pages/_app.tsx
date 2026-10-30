import { QueryClientProvider } from '@tanstack/react-query';
import type { AppProps } from 'next/app';
import { Newsreader, Source_Sans_3 } from 'next/font/google';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { IntlProvider } from 'use-intl';
import { AppShell } from '../components/AppShell';
import { AuthGate } from '../components/AuthGate';
import { SiteHead } from '../components/SiteHead';
import { resolveLocale } from '../lib/i18n';
import type { MessagesProps } from '../lib/i18n-server';
import type { NextPageWithAuth } from '../lib/page-auth';
import { createQueryClient } from '../lib/query-client';
import '../styles/globals.css';

// Dev-only showcase utilities. next.config.ts aliases this module to the real stylesheet on the dev
// server and to an empty one in production builds, so none of that CSS ships.
import 'showcase-styles';

// Self-hosted at build time by next/font (no request to Google from the browser). Each family is a
// CSS variable that `@theme inline` in globals.css maps to `font-sans` and `font-display`.
const sourceSans = Source_Sans_3({
  // latin-ext carries the Turkish ğ ş ı İ (and Dutch, Italian, Spanish stay in latin): without it
  // those letters would fall back to another font.
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-source-sans',
});
// Italic is real (footnotes, captions, the masthead line), and the optical-size axis lets large
// headings draw with finer strokes than text sizes.
const newsreader = Newsreader({
  subsets: ['latin', 'latin-ext'],
  style: ['normal', 'italic'],
  axes: ['opsz'],
  display: 'swap',
  variable: '--font-newsreader',
});

type AppPropsWithAuth = AppProps<Partial<MessagesProps>> & { Component: NextPageWithAuth };

export default function App({ Component, pageProps }: AppPropsWithAuth) {
  // One client per browser session; lazily created so a re-render never replaces the cache.
  const [queryClient] = useState(createQueryClient);
  const locale = resolveLocale(useRouter().locale);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Messages come from the page's getStaticProps / getServerSideProps (lib/i18n.ts); error
          pages without them render with an empty catalogue. */}
      {/* UTC is the explicit default: the server cannot know the visitor's zone, and a zone that
          differs between server and browser would mismatch the markup. The one date shown (the
          demo list) is a UTC day anyway. */}
      <IntlProvider locale={locale} messages={pageProps.messages ?? {}} timeZone="UTC">
        <SiteHead />
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
      </IntlProvider>
    </QueryClientProvider>
  );
}
