import {
  UPLOAD_LIMITS,
  VOICE_MEMO_UPLOAD_CONTENT_TYPES,
  type UploadRejectionCode,
} from '@evidomo/shared';
import { ApiRequestError } from './api';
import type { DownscaleFailure } from './image-downscale';
import { describeRequestFailure } from './request-failure';

const REJECTION_MESSAGES: Record<UploadRejectionCode, string> = {
  empty_file: 'The file is empty.',
  file_too_large: 'The file is too large.',
  unsupported_format: 'This file format is not supported. Use a JPEG, PNG, or WebP photo.',
  heic_not_supported:
    'HEIC photos are not supported. In your phone camera settings choose "Most Compatible" (JPEG), or pick a JPEG.',
  too_many_pixels: 'The photo has too many pixels. Use a smaller resolution.',
  undecodable: 'The file could not be read. It may be damaged.',
  too_long: 'The recording is longer than the allowed length.',
};

export function describeRejection(reason: UploadRejectionCode): string {
  return REJECTION_MESSAGES[reason];
}

const DOWNSCALE_MESSAGES: Record<DownscaleFailure, string> = {
  heic_unreadable:
    'This browser cannot read HEIC photos. Set your camera to "Most Compatible" (JPEG) or pick a JPEG.',
  undecodable: 'This photo could not be read on your device. Try a different photo.',
  encode_failed: 'This photo could not be prepared on your device. Try a different photo.',
};

export function describeDownscaleFailure(failure: DownscaleFailure): string {
  return DOWNSCALE_MESSAGES[failure];
}

export interface UploadFailure {
  message: string;
  /** Trying the same file again can succeed. */
  retryable: boolean;
  /** No further file can be accepted: stop the queue. */
  stopsQueue: boolean;
}

/** Turns an upload error into what the uploader sees and what the queue does next. */
export function describeUploadFailure(error: unknown): UploadFailure {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case 'upload_rejected':
        return {
          message:
            error.reason === null ? 'The file was refused.' : describeRejection(error.reason),
          retryable: false,
          stopsQueue: false,
        };
      case 'photo_limit_reached':
        return {
          message: 'The maximum number of photos is reached.',
          retryable: false,
          stopsQueue: true,
        };
      case 'inputs_locked':
        return {
          message: 'A run has been started, so no more files can be added.',
          retryable: false,
          stopsQueue: true,
        };
      case 'unsupported_media_type':
        return {
          message: 'This file type is not supported.',
          retryable: false,
          stopsQueue: false,
        };
      case 'too_many_uploads':
        return {
          message: 'The server is busy with other uploads. Try again in a moment.',
          retryable: true,
          stopsQueue: false,
        };
      case 'unauthenticated':
      case 'not_found':
        return { message: describeRequestFailure(error), retryable: false, stopsQueue: true };
      default:
        return { message: describeRequestFailure(error), retryable: true, stopsQueue: false };
    }
  }
  return { message: describeRequestFailure(error), retryable: true, stopsQueue: false };
}

/** The upload is busy-rejected and the server says when to come back. */
export function isTooManyUploads(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.code === 'too_many_uploads';
}

/**
 * Network failures and 5xx answers can succeed on a second try; everything else (a refusal, a
 * lock, a missing project) repeats itself. `too_many_uploads` has its own wait.
 */
export function isTransientFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return error instanceof ApiRequestError && error.status >= 500;
}

/**
 * Waits used by the photo queue. An object so tests can shorten them; production code never
 * assigns to it.
 */
export const uploadTiming = {
  /** Automatic retries of a transient failure, one wait each. */
  backoffMs: [1000, 2000, 4000] as readonly number[],
  defaultBusyMs: 5000,
  /** `Retry-After` is clamped: 0 would hammer the server, a huge value would stall the queue. */
  minBusyMs: 1000,
  maxBusyMs: 60_000,
};

export function busyDelayMs(error: ApiRequestError): number {
  const requested =
    error.retryAfterSeconds === null ? uploadTiming.defaultBusyMs : error.retryAfterSeconds * 1000;
  return Math.min(uploadTiming.maxBusyMs, Math.max(uploadTiming.minBusyMs, requested));
}

export const MAX_BUSY_RETRIES = 5;

// --- voice memo content types -----------------------------------------------------------------

const ALLOWED_AUDIO_TYPES: readonly string[] = VOICE_MEMO_UPLOAD_CONTENT_TYPES;

/** `audio/webm;codecs=opus` → `audio/webm`. */
export function baseMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

export function isAllowedAudioType(mimeType: string): boolean {
  return ALLOWED_AUDIO_TYPES.includes(baseMimeType(mimeType));
}

const AUDIO_EXTENSION_TYPES: Record<string, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  amr: 'audio/amr',
  '3gp': 'audio/3gpp',
};

export type AudioFileCheck = { ok: true; contentType: string } | { ok: false; message: string };

/**
 * The upload route accepts a fixed list of `Content-Type` values, and some browsers label a
 * recorder file with an empty or unlisted type (e.g. `audio/mp3`), so fall back to the extension.
 */
export function checkAudioFile(file: { name: string; type: string; size: number }): AudioFileCheck {
  if (file.size === 0) return { ok: false, message: describeRejection('empty_file') };
  if (file.size > UPLOAD_LIMITS.voiceMemoMaxBytes) {
    return { ok: false, message: describeRejection('file_too_large') };
  }
  if (isAllowedAudioType(file.type)) return { ok: true, contentType: baseMimeType(file.type) };
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const inferred = AUDIO_EXTENSION_TYPES[extension];
  if (inferred !== undefined) return { ok: true, contentType: inferred };
  return { ok: false, message: 'This audio format is not supported. Use WebM, M4A, MP3, or WAV.' };
}

/** "10 minutes", "90 seconds": prose for a limit, where `formatDuration` is a clock. */
export function describeLimit(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  return `${seconds} seconds`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
