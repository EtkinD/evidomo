import { useTranslations } from 'use-intl';
import { METHOD_ANCHORS, type MethodAnchor } from '../../lib/method';
import { Boundaries } from '../landing/Boundaries';
import { Ledger } from '../landing/Ledger';
import { Numbers } from '../landing/Numbers';
import { CONTAINER, Section } from '../landing/Section';
import { Specimen } from '../landing/Specimen';
import { Inputs } from './Inputs';

const EVIDENCE_TYPES = ['form', 'voice', 'photo'] as const;

/**
 * "How Evidomo works": the detail the landing page leaves out, in plain words and set as a short
 * spec sheet. Five numbered sections: what goes in, where a sentence comes from, what happened to
 * the example listing, how well it works, and what it will not do. No source links: the example
 * itself (`/demo`) is the proof.
 */
export function MethodPage() {
  const t = useTranslations('method');

  const section = (anchor: MethodAnchor) => ({
    n: METHOD_ANCHORS.indexOf(anchor) + 1,
    anchor,
    id: `method-${anchor}`,
    title: t(`sections.${anchor}`),
  });

  return (
    <main className="flex-1 overflow-x-clip bg-base-200">
      <header className="grain">
        <div className={`${CONTAINER} flex flex-col gap-5 pt-8 pb-10 md:pt-14 md:pb-14`}>
          <h1 className="text-[clamp(2.4rem,6.6vw,4.5rem)] leading-[1] font-medium tracking-tight">
            {t('title')}
          </h1>
          <p className="max-w-prose font-display text-xl leading-relaxed md:text-2xl">
            {t('lede')}
          </p>
          <nav aria-label={t('indexLabel')}>
            <ol className="flex flex-wrap gap-x-6 gap-y-1">
              {METHOD_ANCHORS.map((anchor, index) => (
                <li key={anchor}>
                  <a
                    href={`#${anchor}`}
                    className="inline-flex min-h-11 items-center gap-2 hover:underline"
                  >
                    <span aria-hidden className="font-display text-primary">
                      § {index + 1}
                    </span>
                    {t(`sections.${anchor}`)}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </div>
      </header>

      <Section {...section('inputs')}>
        <Inputs />
      </Section>

      <Section {...section('sources')}>
        <ul className="flex max-w-2xl flex-col">
          {EVIDENCE_TYPES.map((type) => (
            <li key={type} className="border-t border-base-content/25 py-3 first:border-t-0">
              {t(`types.${type}`)}
            </li>
          ))}
        </ul>
        <Specimen />
      </Section>

      <Section {...section('example')}>
        <Ledger />
      </Section>

      <Section {...section('tests')}>
        <Numbers />
      </Section>

      <Section {...section('limits')}>
        <Boundaries />
      </Section>
    </main>
  );
}
