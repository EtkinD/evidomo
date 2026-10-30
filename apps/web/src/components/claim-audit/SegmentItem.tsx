import { CLAIM_EDIT_MAX_LENGTH } from '@evidomo/shared';
import type {
  ClaimAuditGateSegment,
  ClaimAuditWarning,
  ClaimDecisionRequest,
} from '@evidomo/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { ApiRequestError } from '../../lib/api';
import {
  flagCategoryLabel,
  decisionStatus,
  describeAuditFailure,
  hasExclusionaryFlag,
  segmentLabel,
  warningText,
  warningsFor,
  type ClaimAuditActions,
} from '../../lib/claim-audit';

export interface ReviewContext {
  readOnly: boolean;
  actions: ClaimAuditActions;
  selectedId: string | null;
  onSelect: (claimId: string) => void;
  warnings: readonly ClaimAuditWarning[];
  factLabel: (key: string) => string | undefined;
  /** Reports whether a segment has its edit form open (Approve pack waits for it). */
  onEditing: (claimId: string, editing: boolean) => void;
}

export const segmentButtonId = (claimId: string): string => `segment-${claimId}`;

function EditForm({
  segment,
  initial,
  busy,
  pending,
  failure,
  onSubmit,
  onCancel,
}: {
  segment: ClaimAuditGateSegment;
  initial: string;
  /** Any write is in flight: the form is locked. */
  busy: boolean;
  /** This form's own write is in flight. */
  pending: boolean;
  failure: unknown;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('claimAudit');
  const tApi = useTranslations('apiErrors');
  const [text, setText] = useState(initial);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const field = useRef<HTMLTextAreaElement>(null);
  const id = `edit-${segment.claimId}`;
  const errorId = `${id}-error`;

  // The Edit button that opened the form is gone; the first control takes focus.
  useEffect(() => {
    field.current?.focus();
  }, []);

  // The field is disabled while saving, which drops its focus; a refusal returns it.
  useEffect(() => {
    if (failure !== null && !busy) field.current?.focus();
  }, [failure, busy]);

  const findings = failure instanceof ApiRequestError ? failure.findings : [];
  const message =
    problem ??
    (failure !== null && findings.length === 0 ? describeAuditFailure(t, tApi, failure) : null);
  const rejected = failure instanceof ApiRequestError && failure.code === 'claim_edit_rejected';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (text.trim() === '') {
      setProblem(t('edit.empty'));
      return;
    }
    setProblem(undefined);
    onSubmit(text);
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-3 rounded-box bg-base-200 p-4">
      <fieldset className="fieldset">
        <label htmlFor={id} className="fieldset-legend">
          {t('edit.newTextFor', { text: segmentLabel(segment.text) })}
        </label>
        <textarea
          id={id}
          ref={field}
          className={`textarea min-h-32 w-full ${message !== null || rejected ? 'textarea-error' : ''}`}
          value={text}
          maxLength={CLAIM_EDIT_MAX_LENGTH}
          onChange={(event) => setText(event.target.value)}
          disabled={busy}
          aria-invalid={message !== null || rejected}
          aria-describedby={`${id}-hint${message !== null || rejected ? ` ${errorId}` : ''}`}
        />
        <p id={`${id}-hint`} className="text-sm text-base-content/70">
          {t('edit.hint')}
        </p>
        {(message !== null || rejected) && (
          <div id={errorId} role="alert" className="text-sm text-error">
            {rejected ? (
              <>
                <p>{t('edit.rejected')}</p>
                <ul className="list-disc pl-5">
                  {findings.map((finding, index) => (
                    <li key={`${finding.code}-${index}`}>{finding.detail}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{message}</p>
            )}
          </div>
        )}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-outline min-h-11" disabled={busy}>
          {pending && <span className="loading loading-spinner loading-xs" aria-hidden />}
          {t('edit.save')}
        </button>
        <button type="button" className="btn btn-ghost min-h-11" onClick={onCancel} disabled={busy}>
          {t('edit.cancel')}
        </button>
      </div>
    </form>
  );
}

/**
 * One segment of the copy or of a Q&A answer: the text opens its evidence; a flagged segment also
 * shows its flags and the three decisions.
 */
export function SegmentItem({
  segment,
  kind,
  cardDropped,
  context,
  paragraphBreak = false,
}: {
  segment: ClaimAuditGateSegment;
  kind: 'copy' | 'qa';
  cardDropped: boolean;
  context: ReviewContext;
  /** The segment opens a new paragraph of the copy: extra space above it. */
  paragraphBreak?: boolean;
}) {
  const t = useTranslations('claimAudit');
  const tApi = useTranslations('apiErrors');
  const { actions, readOnly, selectedId, onSelect, warnings } = context;
  const [editing, setEditing] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const flagged = segment.flags.length > 0;
  const decision = segment.decision;
  const name = segmentLabel(segment.text);
  const selected = selectedId === segment.claimId;
  const busy = actions.busy;
  const thisClaim = actions.claim.variables?.claimId === segment.claimId;
  const failure = actions.claim.isError && thisClaim ? actions.claim.error : null;
  const pending = actions.claim.isPending && thisClaim;
  const exclusionary = hasExclusionaryFlag(segment);
  // Another answer of a dropped card decided the card; this one needs nothing.
  const moot = cardDropped && decision?.choice !== 'remove';
  const canDecide = flagged && !readOnly && !moot;
  const shownText = decision?.choice === 'edit' ? decision.text : segment.text;
  const removed = decision?.choice === 'remove';
  const removalWarnings = removed ? warningsFor(warnings, segment.claimId) : [];
  const { onEditing } = context;
  useEffect(() => {
    onEditing(segment.claimId, editing);
    return () => onEditing(segment.claimId, false);
  }, [editing, segment.claimId, onEditing]);
  const dropNoteId = `drop-${segment.claimId}`;
  const exclusionNoteId = `exclusion-${segment.claimId}`;

  function send(body: ClaimDecisionRequest) {
    actions.claim.mutate(
      { claimId: segment.claimId, body },
      {
        // The pressed button may be gone; the status line keeps keyboard users in place.
        onSuccess: () => {
          setEditing(false);
          statusRef.current?.focus();
        },
      },
    );
  }

  const text = (
    <button
      type="button"
      id={segmentButtonId(segment.claimId)}
      className={`min-h-11 w-full rounded-field px-2 py-2 text-left hover:bg-base-200 ${
        removed ? 'line-through opacity-80' : ''
      } ${flagged ? 'bg-warning/20' : ''}`}
      aria-expanded={selected}
      aria-controls={selected ? 'evidence-panel' : undefined}
      onClick={() => onSelect(segment.claimId)}
    >
      <span className="sr-only">{t('showEvidenceFor')} </span>
      {shownText}
    </button>
  );

  const itemClass = paragraphBreak ? 'mt-3' : undefined;

  if (!flagged) return <li className={itemClass}>{text}</li>;

  return (
    <li className={itemClass}>
      <div
        role="group"
        aria-label={t('flaggedLabel', { name })}
        className="flex flex-col gap-3 rounded-box border-l-4 border-warning bg-base-100 p-2 pl-3 ring-1 ring-base-300"
      >
        {text}
        {decision?.choice === 'edit' && (
          <p className="px-2 text-sm text-base-content/70">
            {t('original', { text: segment.text })}
          </p>
        )}
        <ul aria-label={t('flagsLabel')} className="flex flex-col gap-2 px-2">
          {segment.flags.map((flag, index) => (
            <li key={`${flag.category}-${index}`} className="flex flex-col gap-1">
              <span className="badge badge-warning w-fit">
                <span aria-hidden>⚑ </span>
                {flagCategoryLabel(t, flag.category)}
              </span>
              <p className="text-sm">{flag.problem}</p>
              {flag.suggestion !== null && (
                <p className="text-sm text-base-content/70">
                  {t('suggestion', { text: flag.suggestion })}
                </p>
              )}
            </li>
          ))}
        </ul>
        {exclusionary && canDecide && (
          <p id={exclusionNoteId} className="px-2 text-sm font-medium">
            {t('exclusionaryNote')}
          </p>
        )}
        {kind === 'qa' && canDecide && (
          <p id={dropNoteId} className="px-2 text-sm font-medium">
            {t('dropNote')}
          </p>
        )}
        <p ref={statusRef} tabIndex={-1} className="px-2 text-sm font-semibold">
          {moot ? t('status.moot') : decisionStatus(t, segment, decision, kind)}
        </p>
        {decision?.choice === 'accept' && exclusionary && (
          <p className="px-2 text-sm">{t('checklistFails')}</p>
        )}
        {removalWarnings.length > 0 && (
          <ul aria-label={t('removalWarnings')} className="flex flex-col gap-1 px-2">
            {removalWarnings.map((warning, index) => (
              <li key={index} className="text-sm font-medium">
                <span aria-hidden>⚠ </span>
                {warningText(t, warning, context.factLabel)}
              </li>
            ))}
          </ul>
        )}
        {pending && (
          <p role="status" className="flex items-center gap-2 px-2 text-sm text-base-content/70">
            <span className="loading loading-spinner loading-xs" aria-hidden />
            {t('saving')}
          </p>
        )}
        {failure !== null && !editing && (
          <p role="alert" className="px-2 text-sm text-error">
            {describeAuditFailure(t, tApi, failure)}
          </p>
        )}
        {canDecide && !editing && (
          <div className="flex flex-wrap gap-2 px-2 pb-1">
            {decision?.choice !== 'accept' && (
              <button
                type="button"
                className="btn btn-outline min-h-11"
                aria-label={t('approveAsWrittenLabel', { name })}
                aria-describedby={exclusionary ? exclusionNoteId : undefined}
                disabled={busy}
                onClick={() => send({ choice: 'accept' })}
              >
                {t('approveAsWritten')}
              </button>
            )}
            <button
              type="button"
              className="btn btn-outline min-h-11"
              aria-label={t('editLabel', { name })}
              disabled={busy}
              onClick={() => {
                actions.claim.reset();
                setEditing(true);
              }}
            >
              {t('edit.open')}
            </button>
            {decision?.choice !== 'remove' && (
              <button
                type="button"
                className="btn btn-outline btn-error min-h-11"
                aria-label={t('removeLabel', { name })}
                aria-describedby={kind === 'qa' ? dropNoteId : undefined}
                disabled={busy}
                onClick={() => send({ choice: 'remove' })}
              >
                {t('remove')}
              </button>
            )}
          </div>
        )}
        {canDecide && editing && (
          <EditForm
            segment={segment}
            initial={shownText}
            busy={busy}
            pending={pending}
            failure={failure}
            onSubmit={(value) => send({ choice: 'edit', text: value })}
            onCancel={() => {
              actions.claim.reset();
              setEditing(false);
              statusRef.current?.focus();
            }}
          />
        )}
      </div>
    </li>
  );
}
