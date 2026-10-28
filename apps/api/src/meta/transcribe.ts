import type OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import type { TranscriptionMode } from '@evidomo/shared';
import { z } from 'zod';
import { assertTranscriptionWav } from '../media/wav.ts';
import { assertStandardModelId } from './clients.ts';
import type { CostEstimator, TokenUsage, UsageEntry, UsageRecorder } from './usage.ts';

/** Relative to the client's base URL (`https://api.meta.ai/v1`). Not an OpenAI-standard route. */
export const TRANSCRIBE_PATH = '/asr/transcribe';

/** Limits of the file endpoint (Meta API reference, Voice: Transcribe a recording). */
export const TRANSCRIBE_MAX_BYTES = 32 * 1024 * 1024;
export const TRANSCRIBE_MAX_DURATION_MS = 10 * 60 * 1000;

// The mode set moved to `@evidomo/shared` (the intake step's `transcription_mode` is validated
// there); re-exported so existing imports keep working.
export { TRANSCRIPTION_MODES, type TranscriptionMode } from '@evidomo/shared';

export interface TranscribeRequest {
  /** From the service definition, e.g. `muse-voice-transcribe-1.0`. */
  readonly model: string;
  readonly mode: TranscriptionMode;
  /** Mono 16-bit PCM WAV at 16 or 24 kHz (see `media/convert.ts`). */
  readonly audio: Uint8Array;
  /** Multipart filename. Not sent anywhere else; replay tests use it as the fixture key. */
  readonly fileName?: string;
  /** Terms to bias recognition toward (street names, room terms). Biasing is a hint only. */
  readonly keywords?: readonly string[];
  /** Language names, e.g. `["Dutch"]`. Omit to let the model detect the language. */
  readonly languageBias?: readonly string[];
  /** Correlation id echoed back by the API; the server generates one when absent. */
  readonly sessionId?: string;
  /** Per-attempt timeout override; long recordings may need more than the client default. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface TranscriptTurn {
  /** Position in turn order (0-based). */
  readonly index: number;
  /** Model-generated label such as `A`; present in `DIARIZATION` mode only. */
  readonly speaker?: string;
  readonly text: string;
  /** Turn-level boundaries; the API says they are not precise acoustic boundaries. */
  readonly startMs: number;
  readonly endMs: number;
}

export interface Transcript {
  readonly sessionId: string;
  /** All turn transcripts joined in turn order (populated in every mode). */
  readonly text: string;
  readonly audioDurationMs: number;
  readonly turns: readonly TranscriptTurn[];
}

export interface TranscribeDeps {
  /** `MetaClients.openai`: base URL, retries, timeout, and the Standard-mode guard. */
  readonly openai: OpenAI;
  readonly usage: UsageRecorder;
  readonly estimateCost?: CostEstimator;
}

export class TranscriptionInputError extends Error {
  override name = 'TranscriptionInputError';
}

export class TranscriptionResponseError extends Error {
  override name = 'TranscriptionResponseError';
}

const millis = z.number().int().nonnegative();

const turnSchema = z
  .object({
    turnId: z.number().int(),
    startMs: millis,
    endMs: millis,
    transcript: z.string(),
    speaker: z.string().min(1).optional(),
  })
  .refine((turn) => turn.endMs >= turn.startMs, {
    message: 'endMs must not be before startMs',
  });

const transcribeResponseSchema = z.object({
  sessionId: z.string().min(1),
  transcript: z.string(),
  audioDurationMs: millis,
  turns: z.array(turnSchema),
});

/** Validates a `TranscribeResponse` (model output is untrusted) and maps it to typed turns. */
export function parseTranscribeResponse(body: unknown): Transcript {
  const parsed = transcribeResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new TranscriptionResponseError(
      `Unexpected Voice Transcribe response:\n${z.prettifyError(parsed.error)}`,
    );
  }
  const { sessionId, transcript, audioDurationMs, turns } = parsed.data;
  // The API documents ascending turnId order; sort anyway so `index` never depends on it.
  const ordered = [...turns].sort((a, b) => a.turnId - b.turnId);
  return {
    sessionId,
    text: transcript,
    audioDurationMs,
    turns: ordered.map((turn, index) => ({
      index,
      ...(turn.speaker === undefined ? {} : { speaker: turn.speaker }),
      text: turn.transcript,
      startMs: turn.startMs,
      endMs: turn.endMs,
    })),
  };
}

function cleanTerms(label: string, terms: readonly string[] | undefined): string[] | undefined {
  if (terms === undefined) return undefined;
  const cleaned = terms.map((term) => term.trim());
  if (cleaned.some((term) => term === '')) {
    throw new TranscriptionInputError(`${label} must not contain empty strings`);
  }
  // Omitted when empty: the server ignores unknown or empty fields silently, so sending `[]`
  // would look identical to a working request.
  return cleaned.length === 0 ? undefined : [...new Set(cleaned)];
}

/** Rejects input the endpoint would refuse, before any bytes (or credit) leave the process. */
function validateAudio(audio: Uint8Array): void {
  if (audio.byteLength > TRANSCRIBE_MAX_BYTES) {
    throw new TranscriptionInputError(
      `Audio is ${audio.byteLength} bytes; the file endpoint accepts at most ${TRANSCRIBE_MAX_BYTES}`,
    );
  }
  let durationMs: number;
  try {
    durationMs = assertTranscriptionWav(audio).durationMs;
  } catch (error) {
    throw new TranscriptionInputError('Audio is not a transcribable WAV file', { cause: error });
  }
  if (durationMs > TRANSCRIBE_MAX_DURATION_MS) {
    throw new TranscriptionInputError(
      `Audio is ${durationMs} ms long; the file endpoint accepts at most ${TRANSCRIBE_MAX_DURATION_MS} ms`,
    );
  }
}

/**
 * Transcribes one WAV recording with `POST /v1/asr/transcribe` through the `openai` SDK's custom
 * request (`client.post`), so the SDK's retry/timeout policy and the shared fetch apply. Records
 * one usage entry with the billed audio duration from the response.
 */
export async function transcribeAudio(
  deps: TranscribeDeps,
  request: TranscribeRequest,
): Promise<Transcript> {
  assertStandardModelId(request.model);
  validateAudio(request.audio);
  const keywords = cleanTerms('keywords', request.keywords);
  const languageBias = cleanTerms('languageBias', request.languageBias);

  // The settings travel as a JSON part named `request`, not as form fields (Meta cookbook,
  // 06_muse_voice; API reference). `audioEncoding` has a single value, `WAV`.
  const settings = {
    model: request.model,
    audioEncoding: 'WAV',
    mode: request.mode,
    ...(keywords === undefined ? {} : { keywords }),
    ...(languageBias === undefined ? {} : { languageBias }),
  };
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify(settings)], { type: 'application/json' }));
  form.append(
    'audio',
    await toFile(request.audio, request.fileName ?? 'audio.wav', { type: 'audio/wav' }),
  );

  const startedAt = performance.now();
  // A FormData body is sent verbatim (and re-sent on retries); fetch sets the boundary.
  const body = await deps.openai.post<unknown>(TRANSCRIBE_PATH, {
    body: form,
    ...(request.sessionId === undefined ? {} : { query: { sessionId: request.sessionId } }),
    ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  const latencyMs = performance.now() - startedAt;

  const transcript = parseTranscribeResponse(body);
  deps.usage.record(
    transcriptionUsageEntry(request.model, transcript, latencyMs, deps.estimateCost),
  );
  return transcript;
}

/** Voice Transcribe reports no tokens; it is billed by audio duration. */
function transcriptionUsageEntry(
  modelId: string,
  transcript: Transcript,
  latencyMs: number,
  estimateCost: CostEstimator | undefined,
): UsageEntry {
  const tokens: TokenUsage = {
    modelId,
    inputTokens: undefined,
    cachedInputTokens: undefined,
    outputTokens: undefined,
    reasoningTokens: undefined,
    totalTokens: undefined,
  };
  const { audioDurationMs } = transcript;
  return {
    ...tokens,
    sdk: 'openai',
    responseId: transcript.sessionId,
    latencyMs,
    audioDurationMs,
    estimatedCostUsd: estimateCost?.({ ...tokens, audioDurationMs }),
  };
}
