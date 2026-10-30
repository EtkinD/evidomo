import type { ReactNode } from 'react';
import { Logo } from './brand/Logo';

/** Centered single-card layout for the login and register pages; full width on a phone. */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="flex flex-1 items-start justify-center bg-base-200 px-4 py-10 sm:items-center sm:py-16">
      <div className="card w-full max-w-sm border border-base-300 bg-base-100">
        <div className="card-body gap-5">
          <div className="flex flex-col items-center gap-2 text-center">
            {/* The header already names the site; the mark here is decoration. */}
            <div aria-hidden="true">
              <Logo size="lg" />
            </div>
            <h1 className="card-title text-2xl">{title}</h1>
            {description !== undefined && (
              <p className="text-sm text-base-content/70">{description}</p>
            )}
          </div>
          {children}
          <p className="text-center text-sm">{footer}</p>
        </div>
      </div>
    </main>
  );
}
