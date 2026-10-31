import { useTranslations } from 'use-intl';
import type { SourceNoteId } from '../../lib/landing-sources';
import { BOUNDARY_IDS } from '../../lib/sample-run';
import { Section } from './Section';
import { SourceNotes, Sourced } from './sources';

/** Section 4: a plain numbered list in a narrow column, like the closing clauses of a file. */
export function Boundaries() {
  const t = useTranslations('landing.boundaries');
  return (
    <Section n={4} id="landing-boundaries" title={t('title')}>
      <ol className="flex flex-col">
        {BOUNDARY_IDS.map((id, index) => {
          const note: SourceNoteId = id;
          return (
            <li
              key={id}
              className="grid gap-x-8 gap-y-2 border-t border-base-content/25 py-4 first:border-t-0 lg:grid-cols-9"
            >
              <p className="flex max-w-prose gap-3 lg:col-span-6">
                <span aria-hidden className="font-mono text-sm text-primary">
                  {index + 1}.
                </span>
                <span>
                  <Sourced id={note}>{t(`items.${id}`)}</Sourced>
                </span>
              </p>
              <div className="lg:col-span-3">
                <SourceNotes ids={[note]} />
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
