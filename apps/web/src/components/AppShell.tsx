import type { ReactNode } from 'react';
import { AppFooter } from './shell/AppFooter';
import { AppHeader } from './shell/AppHeader';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      {children}
      <AppFooter />
    </div>
  );
}
