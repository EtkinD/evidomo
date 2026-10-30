import type { ReactNode } from 'react';

/** Page title of the run screens: the dossier's oversized serif headline. */
export const PAGE_TITLE_CLASS = 'text-4xl leading-tight font-medium tracking-tight sm:text-5xl';

/**
 * A page of the dossier: one paper sheet resting on the desk (the page background). `bare` drops
 * the sheet and puts the content straight on the desk, for screens that carry their own printed
 * page (the pack). `banner` sits above the sheet (the demo banner).
 */
export function DossierPage({
  widthClass,
  banner,
  bare = false,
  children,
}: {
  widthClass: string;
  banner?: ReactNode;
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    <main className="flex-1 px-4 py-8 md:py-12">
      <div className={`mx-auto flex flex-col gap-5 ${widthClass}`}>
        {banner}
        {bare ? (
          <div className="flex flex-col gap-6">{children}</div>
        ) : (
          <section className="grain bg-base-100 shadow-sheet">
            <div className="flex flex-col gap-6 p-5 sm:p-8">{children}</div>
          </section>
        )}
      </div>
    </main>
  );
}
