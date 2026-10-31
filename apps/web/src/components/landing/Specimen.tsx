import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { formatTimestamp } from '../../lib/evidence';
import {
  BUILD_YEAR,
  SAMPLE_COUNTS,
  SPECIMEN_EVIDENCE,
  SPECIMEN_FIRST_CLAIM,
  SPECIMEN_PARTS,
  type SpecimenClaimId,
  type SpecimenEvidence,
} from '../../lib/sample-run';
import { Stamp } from '../Stamp';
import { SamplePhoto } from './SamplePhoto';
import { SourceNotes, Sourced } from './sources';

const CLAIM_IDS: readonly SpecimenClaimId[] = ['year', 'label', 'issued'];
const EVIDENCE_ID = 'specimen-evidence';

function EvidenceItem({ item }: { item: SpecimenEvidence }) {
  const t = useTranslations('landing.specimen');
  const tEvidence = useTranslations('evidence');
  if (item.kind === 'voice') {
    return (
      <li className="flex flex-col gap-1 border-l-4 border-secondary pl-3">
        <p className="text-sm text-base-content/70">
          {tEvidence('voiceTurn', { time: formatTimestamp(item.startMs) })}
          <br />
          {tEvidence('timeRange', {
            start: formatTimestamp(item.startMs),
            end: formatTimestamp(item.endMs),
          })}
        </p>
        {/* The walkthrough is Dutch and quoted as spoken. */}
        <blockquote lang="nl" className="font-display text-lg italic">
          “{item.quote}”
        </blockquote>
      </li>
    );
  }
  return (
    <li
      className={`flex flex-col gap-1 border-l-4 pl-3 ${item.used ? 'border-secondary' : 'border-error'}`}
    >
      <p className="text-sm text-base-content/70">{tEvidence('formField')}</p>
      <p className="font-medium">
        {t('formValue', { field: t(`fieldNames.${item.field}`), value: item.value })}
      </p>
      {!item.used && (
        <>
          <Stamp tone="removed">{t('notUsed')}</Stamp>
          <p className="text-sm">
            {t('conflict', { form: BUILD_YEAR.form, voice: BUILD_YEAR.voice })}
          </p>
        </>
      )}
    </li>
  );
}

/**
 * The first screen after the headline: one real sentence of the sample run, with its claims
 * highlighted. Selecting a claim opens the evidence it rests on. Always annotated, whatever the
 * "Show sources" switch says: it is the page's own example of the idea.
 */
export function Specimen() {
  const t = useTranslations('landing.specimen');
  const [selected, setSelected] = useState<SpecimenClaimId>(SPECIMEN_FIRST_CLAIM);
  const claimName = t(`claimNames.${selected}`);
  const claimText = SPECIMEN_PARTS.find((part) => 'claim' in part && part.claim === selected)?.text;

  return (
    <>
      <div className="flex flex-col gap-4 lg:col-span-8">
        <p className="font-display text-lg text-base-content/70 italic">{t('label')}</p>
        <blockquote
          lang="en"
          className="grain bg-base-100 p-5 font-display text-3xl leading-snug shadow-sheet md:p-8 md:text-[2.4rem] md:leading-[1.25]"
        >
          <p>
            {SPECIMEN_PARTS.map((part, index) =>
              'claim' in part ? (
                <span key={index}>
                  <mark
                    data-claim={part.claim}
                    data-active={selected === part.claim}
                    className="claim bg-transparent"
                  >
                    {part.text}
                  </mark>
                  <sup
                    aria-hidden
                    className="ml-0.5 font-sans text-[0.4em] font-semibold text-primary"
                  >
                    {CLAIM_IDS.indexOf(part.claim) + 1}
                  </sup>
                </span>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </p>
        </blockquote>
        <p className="text-sm text-base-content/70">{t('sentenceNote')}</p>
        <p className="max-w-prose text-sm">
          <Sourced id="replay">{t('replayNote')}</Sourced>
        </p>
        <SourceNotes ids={['replay']} />
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('prompt')}</p>
          <div role="group" aria-label={t('claimsLabel')} className="flex flex-wrap gap-2">
            {CLAIM_IDS.map((id, index) => (
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
                {t(`claimNames.${id}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-6 lg:col-span-4">
        <div
          id={EVIDENCE_ID}
          role="region"
          aria-labelledby="specimen-evidence-title"
          className="grain flex flex-col gap-4 bg-base-100 p-4 shadow-lift"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p
              id="specimen-evidence-title"
              aria-live="polite"
              className="font-display text-xl leading-tight"
            >
              {t('evidenceTitle', { claim: claimText ?? claimName })}
            </p>
            <VerifiedStamp />
          </div>
          <ul className="flex flex-col gap-4">
            {SPECIMEN_EVIDENCE[selected].map((item, index) => (
              <EvidenceItem key={`${selected}-${index}`} item={item} />
            ))}
          </ul>
          <Link
            href="/demo?tab=review"
            className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
          >
            {t('openReview')}
          </Link>
        </div>
        <figure className="hidden w-4/5 -rotate-2 flex-col gap-2 bg-base-100 p-1.5 pb-3 shadow-sheet lg:flex">
          <SamplePhoto id="cover" sizes="(min-width: 1024px) 300px, 100vw" />
          <figcaption className="px-1 text-sm text-base-content/70 italic">
            {t('coverCaption', { count: SAMPLE_COUNTS.photos })}
          </figcaption>
        </figure>
      </div>
    </>
  );
}

function VerifiedStamp() {
  const t = useTranslations('stamps');
  return <Stamp tone="verified">{t('verified')}</Stamp>;
}
