import type { ReactNode } from 'react';
import { Logo } from './brand/Logo';

/** A single sheet on the desk, under the masthead: the heading rules off the form below it. */
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
    <main className="flex flex-1 items-start justify-center px-4 py-10 sm:items-center sm:py-16">
      <div className="settle grain w-full max-w-md bg-base-100 shadow-sheet">
        <div className="flex flex-col gap-6 p-6 sm:p-8">
          <div className="relative flex flex-col gap-2 border-b border-base-content/40 pb-5 rule-double">
            {/* The header already names the site; the mark here is decoration. */}
            <div aria-hidden="true">
              <Logo size="lg" />
            </div>
            <h1 className="text-4xl leading-tight font-medium tracking-tight">{title}</h1>
            {description !== undefined && (
              <p className="font-display text-lg text-base-content/70 italic">{description}</p>
            )}
          </div>
          {children}
          <p className="border-t border-base-content/20 pt-4 text-sm">{footer}</p>
        </div>
      </div>
    </main>
  );
}
