import type { StoredTranscriptTurn } from '@evidomo/shared';
import type { TranscriptTurn } from '../../meta/transcribe.ts';

// Maps Voice Transcribe turns to the stored transcript turns (docs/architecture.md §5 step 1,
// §6). Turns are the evidence anchors of transcript claims, so a turn that covers minutes of
// audio is useless for playback from `startMs`. Turns longer than the configured bound are
// split into chunks whose timestamps are interpolated and labelled `approximate`. Chunks end at
// sentence boundaries, so one may exceed the bound by part of a sentence.

export interface TurnMappingOptions {
  /** Split API turns longer than this; `null` keeps every turn as the API returned it. */
  readonly maxTurnMs: number | null;
}

interface Unit {
  readonly text: string;
  /** Character offset of the unit within the turn text (units joined by single spaces). */
  readonly offset: number;
}

/** Sentence ends followed by whitespace; the punctuation stays with its sentence. */
const SENTENCE_BREAK = /(?<=[.!?…])\s+/u;

function units(parts: readonly string[]): Unit[] {
  let offset = 0;
  return parts.map((text) => {
    const unit = { text, offset };
    offset += text.length + 1;
    return unit;
  });
}

/**
 * Splits `text` into at most `count` chunks of roughly equal length, preferring sentence
 * boundaries and falling back to word boundaries when there are fewer sentences than chunks.
 * Returns each chunk with its character offset in the space-normalized text.
 */
export function chunkText(text: string, count: number): Unit[] {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (count <= 1 || normalized === '') return [{ text: normalized, offset: 0 }];
  const sentences = normalized.split(SENTENCE_BREAK);
  const parts = sentences.length >= count ? sentences : normalized.split(' ');
  const target = normalized.length / count;

  const chunks: { parts: string[]; offset: number }[] = [];
  for (const unit of units(parts)) {
    // A unit belongs to the chunk its first character falls into, so chunks stay in order and
    // close to the target length; a chunk that receives no unit simply does not exist.
    const chunkIndex = Math.min(count - 1, Math.floor(unit.offset / target));
    const last = chunks.at(-1);
    if (last !== undefined && chunks.length - 1 >= chunkIndex) {
      last.parts.push(unit.text);
    } else {
      chunks.push({ parts: [unit.text], offset: unit.offset });
    }
  }
  return chunks.map((chunk) => ({ text: chunk.parts.join(' '), offset: chunk.offset }));
}

/**
 * Splits one long turn. Each chunk's start is interpolated from its character offset, on the
 * assumption that the speaking rate is constant within the turn; chunks are contiguous and the
 * last one ends where the API turn ends.
 */
function splitTurn(
  turn: TranscriptTurn,
  text: string,
  maxTurnMs: number,
): Omit<StoredTranscriptTurn, 'index'>[] {
  const durationMs = turn.endMs - turn.startMs;
  const chunks = chunkText(text, Math.ceil(durationMs / maxTurnMs));
  if (chunks.length <= 1) {
    return [
      {
        sourceTurnIndex: turn.index,
        speaker: turn.speaker ?? null,
        text,
        startMs: turn.startMs,
        endMs: turn.endMs,
        timing: 'model',
      },
    ];
  }
  const totalChars = text.replace(/\s+/gu, ' ').trim().length;
  const starts = chunks.map(
    (chunk) => turn.startMs + Math.round((durationMs * chunk.offset) / totalChars),
  );
  return chunks.map((chunk, i) => ({
    sourceTurnIndex: turn.index,
    speaker: turn.speaker ?? null,
    text: chunk.text,
    startMs: starts[i] ?? turn.startMs,
    endMs: starts[i + 1] ?? turn.endMs,
    timing: 'approximate',
  }));
}

/**
 * API turns → stored turns: text trimmed, empty turns dropped (nothing to cite), long turns
 * split, and indices assigned 0..n-1 in start-time order. `sourceTurnIndex` keeps the API turn.
 */
export function toStoredTurns(
  turns: readonly TranscriptTurn[],
  options: TurnMappingOptions,
): StoredTranscriptTurn[] {
  const stored: Omit<StoredTranscriptTurn, 'index'>[] = [];
  // Diarized turns of different speakers may overlap; stored turns are ordered by start time.
  const ordered = [...turns].sort((a, b) => a.startMs - b.startMs || a.index - b.index);
  for (const turn of ordered) {
    const text = turn.text.trim();
    if (text === '') continue;
    const durationMs = turn.endMs - turn.startMs;
    if (options.maxTurnMs !== null && durationMs > options.maxTurnMs) {
      stored.push(...splitTurn(turn, text, options.maxTurnMs));
    } else {
      stored.push({
        sourceTurnIndex: turn.index,
        speaker: turn.speaker ?? null,
        text,
        startMs: turn.startMs,
        endMs: turn.endMs,
        timing: 'model',
      });
    }
  }
  return stored.map((turn, index) => ({ index, ...turn }));
}
