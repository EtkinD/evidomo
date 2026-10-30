import type { ReactNode } from 'react';
import { AppFooter } from './shell/AppFooter';
import { AppHeader } from './shell/AppHeader';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="grain flex min-h-dvh flex-col bg-base-200">
      <AppHeader />
      {children}
      <AppFooter />
    </div>
  );
}
