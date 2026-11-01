import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { formatTimestamp } from '../../lib/evidence';
import {
  EXAMPLE_EVIDENCE,
  EXAMPLE_FIRST_CLAIM,
  EXAMPLE_PARTS,
  type ExampleClaimId,
  type ExampleEvidence,
} from '../../lib/sample-run';
import { Stamp } from '../Stamp';
import { CONTAINER } from './Section';

const CLAIMS: readonly ExampleClaimId[] = ['place', 'area', 'floor'];
const EVIDENCE_ID = 'claim-evidence';

function EvidenceItem({ item }: { item: ExampleEvidence }) {
  const t = useTranslations('landing.evidence');
  const tEvidence = useTranslations('evidence');
  if (item.kind === 'voice') {
    return (
      <li className="flex flex-col gap-1 border-l-4 border-secondary pl-3">
        <p className="text-sm text-base-content/70">
          {tEvidence('voiceTurn', { time: formatTimestamp(item.startMs) })}
        </p>
        {/* The walkthrough is Dutch and quoted as spoken. */}
        <blockquote lang="nl" className="font-display text-lg italic">
          “{item.quote}”
        </blockquote>
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-1 border-l-4 border-secondary pl-3">
      <p className="text-sm text-base-content/70">{tEvidence('formField')}</p>
      <p className="font-medium">
        {t(`fields.${item.field}`)}: <span className="font-mono">{item.value}</span>
      </p>
    </li>
  );
}

/**
 * The claim example: a real sentence of the sample run, three claims, one open at a time. Only the
 * open claim is highlighted, so the honey marks the one claim being shown.
 */
export function ClaimExample() {
  const t = useTranslations('landing.evidence');
  const tStamps = useTranslations('stamps');
  const [selected, setSelected] = useState<ExampleClaimId>(EXAMPLE_FIRST_CLAIM);
  const claimText = EXAMPLE_PARTS.find((part) => 'claim' in part && part.claim === selected)?.text;

  return (
    <section
      id="evidence"
      aria-labelledby="landing-evidence"
      className="grain scroll-mt-4 bg-base-200"
    >
      <div className={`${CONTAINER} grid items-start gap-10 py-14 md:py-24 lg:grid-cols-12`}>
        <div className="flex flex-col gap-4 lg:sticky lg:top-8 lg:col-span-4">
          <h2
            id="landing-evidence"
            className="text-4xl leading-[1.05] font-medium tracking-tight md:text-5xl"
          >
            {t('title')}
          </h2>
          <p className="text-lg text-base-content/70">{t('text')}</p>
          <p className="font-display text-base text-base-content/70 italic">{t('caption')}</p>
        </div>

        <div className="flex flex-col gap-6 lg:col-span-8">
          <blockquote
            lang="en"
            className="grain bg-base-100 p-6 font-display text-3xl leading-snug shadow-sheet md:p-10 md:text-[2.5rem] md:leading-[1.25]"
          >
            <p>
              {EXAMPLE_PARTS.map((part, index) =>
                'claim' in part ? (
                  <span key={index}>
                    <mark
                      data-claim={part.claim}
                      data-active={selected === part.claim}
                      className={`bg-transparent text-base-content ${selected === part.claim ? 'claim' : ''}`}
                    >
                      {part.text}
                    </mark>
                    <sup
                      aria-hidden
                      className="ml-0.5 font-sans text-[0.4em] font-semibold text-primary"
                    >
                      {CLAIMS.indexOf(part.claim) + 1}
                    </sup>
                  </span>
                ) : (
                  <span key={index}>{part.text}</span>
                ),
              )}
            </p>
          </blockquote>

          <div role="group" aria-label={t('claimsLabel')} className="flex flex-wrap gap-2">
            {CLAIMS.map((id, index) => (
              <button
                key={id}
                type="button"
                aria-pressed={selected === id}
                aria-controls={EVIDENCE_ID}
                onClick={() => setSelected(id)}
                className={`btn min-h-11 gap-2 ${selected === id ? 'btn-accent' : 'btn-outline'}`}
              >
                <span aria-hidden className="font-mono text-xs">
                  {index + 1}
                </span>
                {t(`claims.${id}`)}
              </button>
            ))}
          </div>

          <div
            id={EVIDENCE_ID}
            role="region"
            aria-labelledby="claim-evidence-title"
            className="grain flex flex-col gap-4 bg-base-100 p-4 shadow-lift md:max-w-lg md:p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p
                id="claim-evidence-title"
                aria-live="polite"
                className="font-display text-xl leading-tight"
              >
                {t('rests', { claim: claimText ?? '' })}
              </p>
              <Stamp tone="verified">{tStamps('verified')}</Stamp>
            </div>
            <ul className="flex flex-col gap-4">
              {EXAMPLE_EVIDENCE[selected].map((item, index) => (
                <EvidenceItem key={`${selected}-${index}`} item={item} />
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
