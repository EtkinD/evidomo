import { transcriptArtifactContentSchema, type StoredTranscriptTurn } from '@evidomo/shared';
import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '../../meta/transcribe.ts';
import { chunkText, toStoredTurns } from './turns.ts';

function turn(
  index: number,
  startMs: number,
  endMs: number,
  text: string,
  speaker?: string,
): TranscriptTurn {
  return { index, startMs, endMs, text, ...(speaker === undefined ? {} : { speaker }) };
}

function asContent(turns: StoredTranscriptTurn[]) {
  return transcriptArtifactContentSchema.safeParse({
    schemaVersion: 1,
    materialId: '00000000-0000-4000-8000-000000000000',
    materialSha256: 'a'.repeat(64),
    model: 'muse-voice-transcribe-1.0',
    mode: 'DIARIZATION',
    sessionId: 'session',
    audioDurationMs: 200_000,
    languageBias: ['Dutch'],
    keywords: [],
    maxTurnMs: 30_000,
    turns,
  });
}

describe('toStoredTurns', () => {
  it('maps API turns 1:1 with model timing, speaker, and stable indices', () => {
    const stored = toStoredTurns(
      [turn(0, 60, 10_940, ' Goedemiddag. ', 'A'), turn(1, 11_100, 19_180, 'Het gebouw.', 'A')],
      { maxTurnMs: 30_000 },
    );
    expect(stored).toEqual([
      {
        index: 0,
        sourceTurnIndex: 0,
        speaker: 'A',
        text: 'Goedemiddag.',
        startMs: 60,
        endMs: 10_940,
        timing: 'model',
      },
      {
        index: 1,
        sourceTurnIndex: 1,
        speaker: 'A',
        text: 'Het gebouw.',
        startMs: 11_100,
        endMs: 19_180,
        timing: 'model',
      },
    ]);
    expect(asContent(stored).success).toBe(true);
  });

  it('stores null speakers in ENDPOINTING mode and drops empty turns', () => {
    const stored = toStoredTurns([turn(0, 0, 1000, '   '), turn(1, 1000, 2000, 'Hal.')], {
      maxTurnMs: null,
    });
    expect(stored).toEqual([
      {
        index: 0,
        sourceTurnIndex: 1,
        speaker: null,
        text: 'Hal.',
        startMs: 1000,
        endMs: 2000,
        timing: 'model',
      },
    ]);
  });

  it('orders overlapping diarized turns by start time', () => {
    const stored = toStoredTurns(
      [turn(0, 5000, 9000, 'Tweede.', 'A'), turn(1, 1000, 6000, 'Eerste.', 'B')],
      { maxTurnMs: null },
    );
    expect(stored.map((t) => [t.index, t.sourceTurnIndex, t.speaker])).toEqual([
      [0, 1, 'B'],
      [1, 0, 'A'],
    ]);
    expect(asContent(stored).success).toBe(true);
  });

  it('keeps a long turn whole when splitting is off', () => {
    const stored = toStoredTurns([turn(0, 0, 168_300, 'Een. Twee. Drie.')], { maxTurnMs: null });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.timing).toBe('model');
  });

  it('splits a long turn at sentences into contiguous chunks with interpolated times', () => {
    // 10 sentences of equal length over 100 s, bound 30 s: four chunks.
    const sentences = Array.from({ length: 10 }, (_, i) => `Zin nummer ${i}.`);
    const stored = toStoredTurns([turn(3, 10_000, 110_000, sentences.join(' '), 'A')], {
      maxTurnMs: 30_000,
    });
    expect(stored.length).toBe(4);
    expect(stored.every((t) => t.timing === 'approximate' && t.sourceTurnIndex === 3)).toBe(true);
    expect(stored.every((t) => t.speaker === 'A')).toBe(true);
    expect(stored[0]?.startMs).toBe(10_000);
    expect(stored.at(-1)?.endMs).toBe(110_000);
    for (const [i, chunk] of stored.entries()) {
      expect(chunk.index).toBe(i);
      // Splits fall on sentence ends, so a chunk may overshoot the bound by part of a sentence.
      expect(chunk.endMs - chunk.startMs).toBeLessThanOrEqual(30_000 + 100_000 / 10);
      const next = stored[i + 1];
      if (next !== undefined) expect(next.startMs).toBe(chunk.endMs);
      expect(chunk.text).toMatch(/\.$/); // never cut inside a sentence
    }
    expect(stored.map((t) => t.text).join(' ')).toBe(sentences.join(' '));
    expect(asContent(stored).success).toBe(true);
  });

  it('interpolates proportionally to the text position', () => {
    // Two sentences, the first three times as long as the second.
    const first = `${'a'.repeat(59)}.`;
    const second = `${'b'.repeat(19)}.`;
    const stored = toStoredTurns([turn(0, 0, 81_000, `${first} ${second}`)], { maxTurnMs: 60_000 });
    expect(stored.map((t) => [t.text, t.startMs, t.endMs])).toEqual([
      [first, 0, 61_000],
      [second, 61_000, 81_000],
    ]);
  });

  it('falls back to word boundaries when a turn has fewer sentences than chunks', () => {
    const words = Array.from({ length: 40 }, (_, i) => `woord${i}`).join(' ');
    const stored = toStoredTurns([turn(0, 0, 120_000, words)], { maxTurnMs: 30_000 });
    expect(stored).toHaveLength(4);
    expect(stored.map((t) => t.text).join(' ')).toBe(words);
  });
});

describe('chunkText', () => {
  it('returns the whole text for one chunk', () => {
    expect(chunkText('  Een.   Twee. ', 1)).toEqual([{ text: 'Een. Twee.', offset: 0 }]);
  });
});
