import type { ClaimAuditGateSegment, GateFact } from '@evidomo/shared';
import { useEffect, useRef } from 'react';
import { useTranslations } from 'use-intl';
import { segmentButtonId } from './SegmentItem';
import { segmentLabel } from '../../lib/claim-audit';
import type { Labels } from '../FactConflicts';
import { EvidenceInspector } from '../evidence/EvidenceInspector';

/**
 * The evidence behind one segment's citations. A bottom sheet on a phone, a sticky side panel
 * from `lg` up: one element, so there is one DOM and one focus path.
 */
export function EvidencePanel({
  segment,
  facts,
  labels,
  onClose,
}: {
  segment: ClaimAuditGateSegment;
  facts: readonly GateFact[];
  labels: Labels;
  onClose: () => void;
}) {
  const t = useTranslations('claimAudit');
  const heading = useRef<HTMLHeadingElement>(null);
  const entries = segment.factIds.map((id) => ({
    id,
    fact: facts.find((candidate) => candidate.id === id),
  }));
  const cited = entries;

  const claimId = segment.claimId;
  useEffect(() => {
    // On a phone the sheet covers the lower part of the screen: bring the segment above it.
    if (
      typeof window.matchMedia === 'function' &&
      !window.matchMedia('(min-width: 1024px)').matches
    ) {
      document.getElementById(segmentButtonId(claimId))?.scrollIntoView?.({ block: 'start' });
    }
    heading.current?.focus();
  }, [claimId]);

  // Escape works wherever focus is, but not for the larger-photo dialog, which closes itself.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open]') !== null) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      id="evidence-panel"
      aria-labelledby="evidence-heading"
      className="fixed inset-x-0 bottom-0 z-30 flex max-h-[70vh] flex-col gap-3 overflow-y-auto border-t-4 border-accent bg-base-100 p-4 shadow-lift lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:border-t-0 lg:border-l-4 lg:shadow-sheet"
    >
      <div className="flex items-start justify-between gap-2">
        <h2
          id="evidence-heading"
          ref={heading}
          tabIndex={-1}
          className="text-xl leading-tight font-medium"
        >
          {t('evidenceFor', { text: segmentLabel(segment.text) })}
        </h2>
        <button type="button" className="btn btn-ghost min-h-11" onClick={onClose}>
          {t('closeEvidence')}
        </button>
      </div>
      <p className="text-sm text-base-content/70">{t('cites', { count: cited.length })}</p>
      <ul className="flex flex-col gap-3">
        {cited.map(({ id, fact }, index) => (
          <li key={id} className="flex gap-3 border-t border-dashed border-base-content/30 pt-3">
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-content"
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              {fact === undefined ? (
                <p role="alert" className="text-sm font-medium text-error">
                  <span aria-hidden>⚠ </span>
                  {t('missingEvidence', { id })}
                </p>
              ) : (
                <EvidenceInspector
                  factId={fact.id}
                  source={fact.source}
                  valueText={labels.value(fact.value, fact.unit, fact.basis)}
                  label={labels.fact(fact.key)}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
