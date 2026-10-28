import { QueryClientProvider } from '@tanstack/react-query';
import type { AppProps } from 'next/app';
import { useState } from 'react';
import { AppShell } from '../components/AppShell';
import { AuthGate } from '../components/AuthGate';
import type { NextPageWithAuth } from '../lib/page-auth';
import { createQueryClient } from '../lib/query-client';
import '../styles/globals.css';

type AppPropsWithAuth = AppProps & { Component: NextPageWithAuth };

export default function App({ Component, pageProps }: AppPropsWithAuth) {
  // One client per browser session; lazily created so a re-render never replaces the cache.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <AppShell>
        {/* Pages opt in with `Page.auth`; public pages (and the demo replay) set nothing. */}
        <AuthGate mode={Component.auth}>
          <Component {...pageProps} />
        </AuthGate>
      </AppShell>
    </QueryClientProvider>
  );
}
