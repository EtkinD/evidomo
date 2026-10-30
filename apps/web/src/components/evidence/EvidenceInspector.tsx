import type { FactSource } from '@evidomo/shared';
import { formatTimestamp } from '../../lib/evidence';
import { PhotoRegionEvidence } from './PhotoRegionEvidence';
import { useEvidenceAudio, useEvidenceUrls } from './EvidenceProvider';

type SourceOf<K extends FactSource['kind']> = Extract<FactSource, { kind: K }>;

export function FormFieldEvidence({ label, valueText }: { label: string; valueText: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium">Form field</p>
      <p>
        <span className="text-base-content/70">{label}:</span> {valueText}
      </p>
    </div>
  );
}

export function TranscriptTurnEvidence({ source }: { source: SourceOf<'transcript_turn'> }) {
  const urls = useEvidenceUrls();
  const { playingId, failedId, unavailableId, toggle } = useEvidenceAudio();
  // The same turn can back several facts; the clip identity is the turn, not the fact.
  const clipId = `${source.transcriptArtifactId}:${source.turnIndex}`;
  const playing = playingId === clipId;
  const time = formatTimestamp(source.startMs);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Voice walkthrough, turn at {time}</p>
      <blockquote className="border-l-4 border-secondary pl-3 italic">“{source.quote}”</blockquote>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-outline min-h-11"
          aria-label={`${playing ? 'Stop' : 'Play'} the turn at ${time}`}
          onClick={() =>
            toggle({
              id: clipId,
              url: urls.transcriptAudio(source.transcriptArtifactId),
              startMs: source.startMs,
              endMs: source.endMs,
            })
          }
        >
          <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
            {playing ? (
              <rect x="3" y="3" width="10" height="10" rx="1" />
            ) : (
              <path d="M4 2.5v11l9-5.5z" />
            )}
          </svg>
          {playing ? 'Stop' : 'Play'}
        </button>
        <span className="text-sm text-base-content/70">
          {time} to {formatTimestamp(source.endMs)}
        </span>
      </div>
      {unavailableId === clipId && (
        <p role="alert" className="text-sm text-error">
          The audio for this part is not available: the recording ends before this point.
        </p>
      )}
      {failedId === clipId && (
        <p role="alert" className="text-sm text-error">
          The recording could not be played. Check your connection and try again.
        </p>
      )}
    </div>
  );
}

export function GateDecisionEvidence() {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium">Your decision</p>
      <p className="text-base-content/70">
        This value was entered by you when you reviewed the fact conflicts.
      </p>
    </div>
  );
}

export interface EvidenceInspectorProps {
  /** The fact the evidence belongs to (the mask is addressed by fact). */
  factId: string;
  source: FactSource;
  /** The fact's value as displayed; a form field shows it as entered. */
  valueText: string;
  /** A human label for the fact, used for the form field label and photo descriptions. */
  label: string;
  /** Overrides the label of a form field source (defaults to `label`). */
  fieldLabel?: string;
}

/**
 * The evidence behind one fact, by where it came from. Must be rendered inside an
 * `EvidenceProvider`, which decides whether files come from the owner's API or the demo.
 */
export function EvidenceInspector({
  factId,
  source,
  valueText,
  label,
  fieldLabel,
}: EvidenceInspectorProps) {
  switch (source.kind) {
    case 'form':
      return <FormFieldEvidence label={fieldLabel ?? label} valueText={valueText} />;
    case 'transcript_turn':
      return <TranscriptTurnEvidence source={source} />;
    case 'photo_region':
      return <PhotoRegionEvidence factId={factId} source={source} subject={label} />;
    case 'gate_decision':
      return <GateDecisionEvidence />;
    default: {
      const unreachable: never = source;
      return unreachable;
    }
  }
}
