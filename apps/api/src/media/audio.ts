import { stat } from 'node:fs/promises';
import { UPLOAD_LIMITS } from '@evidomo/shared';
import { convertToTranscriptionWav, MediaConversionError } from './convert.ts';
import { MediaProbeError, probeMedia } from './probe.ts';
import { isEnvironmentError, UploadRejectedError } from './upload-error.ts';
import type { TranscriptionSampleRate } from './wav.ts';

/**
 * Demuxers a voice memo may use: browser recordings (WebM/Opus from Chrome and Firefox, MP4/AAC
 * from Safari, Ogg/Opus) and common recorder apps (M4A, MP3, WAV, FLAC, AAC, AMR).
 */
export const VOICE_MEMO_FORMATS = [
  'mov,mp4,m4a,3gp,3g2,mj2',
  'matroska,webm',
  'ogg',
  'wav',
  'mp3',
  'flac',
  'aac',
  'amr',
] as const;

export const VOICE_MEMO_CODECS = [
  'aac',
  'opus',
  'vorbis',
  'mp3',
  'flac',
  'alac',
  'amr_nb',
  'amr_wb',
  'pcm_s16le',
  'pcm_s24le',
  'pcm_s32le',
  'pcm_f32le',
  'pcm_u8',
] as const;

/**
 * ffmpeg stops decoding this far past the limit. The overshoot is what tells "too long" apart
 * from "exactly at the limit" when the container declares no duration.
 */
const DECODE_MARGIN_MS = 1_000;

export interface VoiceMemoOptions {
  readonly maxBytes?: number;
  readonly maxDurationMs?: number;
  readonly sampleRate?: TranscriptionSampleRate;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly signal?: AbortSignal;
}

export interface ValidatedVoiceMemo {
  /** ffprobe demuxer name, e.g. `matroska,webm`. */
  readonly container: string;
  readonly codec: string;
  /** Declared by the container; absent for streamed WebM. Not trusted for the final check. */
  readonly declaredDurationMs: number | undefined;
}

export interface ProcessedVoiceMemo {
  readonly wavPath: string;
  /** Measured from the converted WAV's samples. */
  readonly durationMs: number;
  readonly sampleRate: TranscriptionSampleRate;
  readonly sourceContainer: string;
  readonly sourceCodec: string;
}

const UNDECODABLE_MESSAGE = 'The recording could not be read; it may be damaged or incomplete.';

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return values.some((candidate) => candidate === value);
}

function formatLimit(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${Math.floor(ms / 1000)} seconds`;
}

/**
 * Checks size, container, codec, and declared duration by probing the content (never the
 * extension or the client's MIME type), before any audio is decoded.
 */
export async function validateVoiceMemo(
  inputPath: string,
  options: VoiceMemoOptions = {},
): Promise<ValidatedVoiceMemo> {
  const maxBytes = options.maxBytes ?? UPLOAD_LIMITS.voiceMemoMaxBytes;
  const maxDurationMs = options.maxDurationMs ?? UPLOAD_LIMITS.voiceMemoMaxDurationMs;

  const { size } = await stat(inputPath);
  if (size === 0) throw new UploadRejectedError('empty_file', 'The recording is empty.');
  if (size > maxBytes) {
    throw new UploadRejectedError(
      'file_too_large',
      `The recording is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
    );
  }

  let probe;
  try {
    probe = await probeMedia(inputPath, {
      allowedFormats: VOICE_MEMO_FORMATS,
      ...(options.ffprobePath === undefined ? {} : { ffprobePath: options.ffprobePath }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (
      error instanceof MediaProbeError &&
      (error.failure === 'exit' || error.failure === 'timeout')
    ) {
      throw new UploadRejectedError(
        'unsupported_format',
        'Unsupported recording format. Upload M4A, MP3, WAV, WebM, Ogg, or FLAC audio.',
        { cause: error },
      );
    }
    throw error;
  }

  if (!isOneOf(VOICE_MEMO_FORMATS, probe.formatName)) {
    // Unreachable with `-format_whitelist`; kept so the allow-list holds even if probing changes.
    throw new UploadRejectedError('unsupported_format', 'Unsupported recording format.');
  }
  if (probe.streams.some((stream) => stream.codecType === 'video' && !stream.attachedPic)) {
    throw new UploadRejectedError(
      'unsupported_format',
      'Video files are not accepted; upload the voice memo as an audio file.',
    );
  }
  const audio = probe.streams.filter((stream) => stream.codecType === 'audio');
  const [track] = audio;
  if (track === undefined || audio.length > 1) {
    throw new UploadRejectedError(
      'unsupported_format',
      audio.length === 0
        ? 'The file contains no audio.'
        : 'The recording must have a single audio track.',
    );
  }
  if (track.codecName === undefined || !isOneOf(VOICE_MEMO_CODECS, track.codecName)) {
    throw new UploadRejectedError('unsupported_format', 'Unsupported audio codec.');
  }

  const declared = [probe.durationMs, track.durationMs].filter(
    (value): value is number => value !== undefined,
  );
  const declaredDurationMs = declared.length === 0 ? undefined : Math.max(...declared);
  if (declaredDurationMs !== undefined && declaredDurationMs > maxDurationMs) {
    throw new UploadRejectedError(
      'too_long',
      `The recording is longer than ${formatLimit(maxDurationMs)}.`,
    );
  }

  return { container: probe.formatName, codec: track.codecName, declaredDurationMs };
}

/**
 * Validates a voice memo, then converts it with the shared ffmpeg converter to the transcription
 * WAV at `outputPath`. Decoding is capped just above the limit, so a file with a missing or
 * forged duration costs at most that much work before the measured duration rejects it.
 */
export async function processVoiceMemo(
  inputPath: string,
  outputPath: string,
  options: VoiceMemoOptions = {},
): Promise<ProcessedVoiceMemo> {
  const maxDurationMs = options.maxDurationMs ?? UPLOAD_LIMITS.voiceMemoMaxDurationMs;
  const sampleRate = options.sampleRate ?? 16_000;
  const validated = await validateVoiceMemo(inputPath, options);

  let converted;
  try {
    converted = await convertToTranscriptionWav(inputPath, outputPath, {
      sampleRate,
      maxDurationMs: maxDurationMs + DECODE_MARGIN_MS,
      ...(options.ffmpegPath === undefined ? {} : { ffmpegPath: options.ffmpegPath }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    // A spawn failure (missing binary, abort) carries an errno cause; anything else means
    // ffmpeg ran and could not decode what the probe accepted.
    if (error instanceof MediaConversionError && !isEnvironmentError(error.cause)) {
      throw new UploadRejectedError('undecodable', UNDECODABLE_MESSAGE, { cause: error });
    }
    throw error;
  }

  if (converted.info.durationMs > maxDurationMs) {
    throw new UploadRejectedError(
      'too_long',
      `The recording is longer than ${formatLimit(maxDurationMs)}.`,
    );
  }

  return {
    wavPath: converted.path,
    durationMs: converted.info.durationMs,
    sampleRate,
    sourceContainer: validated.container,
    sourceCodec: validated.codec,
  };
}
