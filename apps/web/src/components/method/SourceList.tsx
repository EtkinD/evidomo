import Link from 'next/link';
import { useTranslations } from 'use-intl';
import type { SourceRef } from '../../lib/landing-sources';
import { useRefParts } from '../landing/sources';

/** The numbered sources that close a section: a type and one link each. */
export function SourceList({ refs }: { refs: readonly SourceRef[] }) {
  const t = useTranslations('method');
  const parts = useRefParts();
  return (
    <div
      data-method-sources
      className="flex max-w-2xl flex-col gap-1 border-t border-base-content/25 pt-3"
    >
      <h3 className="text-sm font-semibold tracking-wider text-base-content/70 uppercase">
        {t('sourcesTitle')}
      </h3>
      <ol className="flex flex-col text-sm">
        {refs.map((ref, index) => {
          const { kind, label, href } = parts(ref);
          const link = 'inline-flex min-h-11 items-center break-all underline underline-offset-4';
          return (
            <li key={index} className="flex flex-wrap items-center gap-x-3">
              <span aria-hidden className="w-5 font-mono text-primary">
                {index + 1}
              </span>
              <span className="text-xs font-semibold tracking-wider text-base-content/70 uppercase">
                {kind}
              </span>
              {href.startsWith('http') ? (
                <a href={href} rel="noreferrer" className={link}>
                  {label}
                </a>
              ) : (
                <Link href={href} className={link}>
                  {label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
