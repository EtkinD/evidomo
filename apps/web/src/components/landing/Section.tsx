import type { ReactNode } from 'react';

export const CONTAINER = 'mx-auto w-full max-w-6xl px-4';

/**
 * A numbered section of the file: the heading stands in the margin column with its section
 * number (§ 2), the content takes the rest. The notes of "Show sources" go in each row's own
 * margin, so a section only provides the grid.
 */
export function Section({
  n,
  id,
  title,
  intro,
  children,
}: {
  n: number;
  id: string;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`${CONTAINER} grid gap-8 border-t border-base-content/25 py-12 md:py-20 lg:grid-cols-12 lg:gap-x-10`}
    >
      <div className="flex flex-col gap-3 self-start lg:sticky lg:top-8 lg:col-span-3">
        <p aria-hidden className="font-display text-2xl text-primary">
          § {n}
        </p>
        <h2 id={id} className="text-3xl leading-[1.05] font-medium tracking-tight md:text-4xl">
          {title}
        </h2>
        {intro}
      </div>
      <div className="lg:col-span-9">{children}</div>
    </section>
  );
}
