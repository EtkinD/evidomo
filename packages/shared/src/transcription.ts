import { z } from 'zod';

// Muse Voice Transcribe settings and the stored transcript (docs/architecture.md §5 step 1, §8).
// Shared because the service definition (intake step) names the mode, the market profile lists
// transcription keywords, and the web app reads transcript turns for evidence playback (P4-06).

/**
 * Modes the endpoint accepts (Meta API reference, Voice schemas). `PUSH_TO_TALK` returns the
 * transcript with an empty `turns` array; `ENDPOINTING` splits it into timed turns;
 * `DIARIZATION` does the same and adds a speaker label per turn. The server silently ignores an
 * unknown mode, so the value is always constrained to this set.
 */
export const TRANSCRIPTION_MODES = ['PUSH_TO_TALK', 'ENDPOINTING', 'DIARIZATION'] as const;
export const transcriptionModeSchema = z.enum(TRANSCRIPTION_MODES);
export type TranscriptionMode = z.infer<typeof transcriptionModeSchema>;

/**
 * Modes that return timed turns. Intake needs them: turn timestamps are the evidence anchors of
 * transcript claims (§6), and `PUSH_TO_TALK` returns none.
 */
export const TURN_TRANSCRIPTION_MODES = ['ENDPOINTING', 'DIARIZATION'] as const;
export const turnTranscriptionModeSchema = z.enum(TURN_TRANSCRIPTION_MODES);

/**
 * Bounds on keyword biasing. Meta documents no limit on the number or length of `keywords`, so
 * these are our own: biasing is a hint whose effect thins out as the list grows, and an
 * unbounded list built from user input must not grow the request without limit
 * (docs/model-notes.md, P2-06).
 */
export const TRANSCRIPTION_KEYWORD_LIMITS = {
  maxKeywords: 50,
  maxKeywordLength: 64,
} as const;

/** One keyword: trimmed, non-empty, within the length bound. */
export const transcriptionKeywordSchema = z
  .string()
  .trim()
  .min(1)
  .max(TRANSCRIPTION_KEYWORD_LIMITS.maxKeywordLength);

/**
 * Where a stored turn's timestamps come from. `model`: the API's turn boundaries (which the API
 * itself calls approximate, not acoustic boundaries). `approximate`: a long API turn was split
 * into chunks and each chunk's times were interpolated from its share of the turn's text, so
 * they can be off by several seconds; playback should start a little earlier.
 */
export const TRANSCRIPT_TURN_TIMINGS = ['model', 'approximate'] as const;
export const transcriptTurnTimingSchema = z.enum(TRANSCRIPT_TURN_TIMINGS);
export type TranscriptTurnTiming = z.infer<typeof transcriptTurnTimingSchema>;

const nonNegativeInt = z.int().nonnegative();

export const storedTranscriptTurnSchema = z
  .strictObject({
    /**
     * Position in the stored transcript (0-based) and, together with the artifact ID, the
     * turn's stable ID: facts cite `(transcript artifact ID, index)` (§8 `facts.source_ref`).
     */
    index: nonNegativeInt,
    /** The API turn this text came from; several stored turns share it when one was split. */
    sourceTurnIndex: nonNegativeInt,
    /** Model-generated label such as `A` (`DIARIZATION` only). */
    speaker: z.string().min(1).nullable(),
    text: z.string().min(1),
    startMs: nonNegativeInt,
    endMs: nonNegativeInt,
    timing: transcriptTurnTimingSchema,
  })
  .refine((turn) => turn.endMs >= turn.startMs, {
    message: 'endMs must not be before startMs',
    path: ['endMs'],
  });
export type StoredTranscriptTurn = z.infer<typeof storedTranscriptTurnSchema>;

/** Content of the `transcript` artifact written by the intake step. */
export const transcriptArtifactContentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    /** The voice-memo material that was transcribed, and the SHA-256 of the bytes sent. */
    materialId: z.uuid(),
    materialSha256: z.string().regex(/^[0-9a-f]{64}$/),
    model: z.string().min(1),
    mode: turnTranscriptionModeSchema,
    /** Meta's correlation ID for the call (also the usage ledger's response ID). */
    sessionId: z.string().min(1),
    /** Billed duration as reported by the API. */
    audioDurationMs: nonNegativeInt,
    /** The biasing sent with the request, for reproducibility. Same personal-data scope as the turns. */
    languageBias: z.array(z.string().min(1)),
    keywords: z.array(transcriptionKeywordSchema).max(TRANSCRIPTION_KEYWORD_LIMITS.maxKeywords),
    /** The split threshold applied to long API turns; `null` when splitting is off. */
    maxTurnMs: z.int().positive().nullable(),
    turns: z.array(storedTranscriptTurnSchema),
  })
  .superRefine((content, ctx) => {
    // Ordered by start time. Overlap is allowed: diarized turns of two speakers can overlap.
    let previousStart = 0;
    content.turns.forEach((turn, i) => {
      if (turn.index !== i) {
        ctx.addIssue({
          code: 'custom',
          path: ['turns', i, 'index'],
          message: `Expected index ${i}`,
        });
      }
      if (turn.startMs < previousStart) {
        ctx.addIssue({
          code: 'custom',
          path: ['turns', i, 'startMs'],
          message: 'Turns must be ordered by start time',
        });
      }
      previousStart = turn.startMs;
    });
  });
export type TranscriptArtifactContent = z.infer<typeof transcriptArtifactContentSchema>;

/** The artifact kind of a stored transcript; at most one per run and step (database index). */
export const TRANSCRIPT_ARTIFACT_KIND = 'transcript';
