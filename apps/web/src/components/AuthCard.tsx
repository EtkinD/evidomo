import type { ReactNode } from 'react';

/** Centered single-card layout for the login and register pages; full width on a phone. */
export function AuthCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="flex flex-1 items-start justify-center bg-base-200 px-4 py-8 sm:items-center">
      <div className="card w-full max-w-sm bg-base-100 shadow-sm">
        <div className="card-body gap-6">
          <h1 className="card-title text-2xl">{title}</h1>
          {children}
          <p className="text-center text-sm">{footer}</p>
        </div>
      </div>
    </main>
  );
}
