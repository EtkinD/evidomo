import {
  UPLOAD_LIMITS,
  VOICE_MEMO_UPLOAD_CONTENT_TYPES,
  type UploadRejectionCode,
} from '@evidomo/shared';
import { ApiRequestError } from './api';
import type { Translator } from './i18n';
import type { DownscaleFailure } from './image-downscale';
import { describeRequestFailure } from './request-failure';

type CaptureT = Translator<'capture'>;

export function describeRejection(t: CaptureT, reason: UploadRejectionCode): string {
  return t(`rejections.${reason}`);
}

export function describeDownscaleFailure(t: CaptureT, failure: DownscaleFailure): string {
  return t(`downscale.${failure}`);
}

export interface UploadFailure {
  message: string;
  /** Trying the same file again can succeed. */
  retryable: boolean;
  /** No further file can be accepted: stop the queue. */
  stopsQueue: boolean;
}

/** Turns an upload error into what the uploader sees and what the queue does next. */
export function describeUploadFailure(
  t: CaptureT,
  tApi: Translator<'apiErrors'>,
  error: unknown,
): UploadFailure {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case 'upload_rejected':
        return {
          message:
            error.reason === null ? t('uploadErrors.refused') : describeRejection(t, error.reason),
          retryable: false,
          stopsQueue: false,
        };
      case 'photo_limit_reached':
        return {
          message: t('uploadErrors.photoLimit'),
          retryable: false,
          stopsQueue: true,
        };
      case 'inputs_locked':
        return {
          message: t('uploadErrors.locked'),
          retryable: false,
          stopsQueue: true,
        };
      case 'unsupported_media_type':
        return {
          message: t('uploadErrors.mediaType'),
          retryable: false,
          stopsQueue: false,
        };
      case 'too_many_uploads':
        return {
          message: t('uploadErrors.busy'),
          retryable: true,
          stopsQueue: false,
        };
      case 'unauthenticated':
      case 'not_found':
        return { message: describeRequestFailure(tApi, error), retryable: false, stopsQueue: true };
      default:
        return { message: describeRequestFailure(tApi, error), retryable: true, stopsQueue: false };
    }
  }
  return { message: describeRequestFailure(tApi, error), retryable: true, stopsQueue: false };
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
export function checkAudioFile(
  t: CaptureT,
  file: { name: string; type: string; size: number },
): AudioFileCheck {
  if (file.size === 0) return { ok: false, message: describeRejection(t, 'empty_file') };
  if (file.size > UPLOAD_LIMITS.voiceMemoMaxBytes) {
    return { ok: false, message: describeRejection(t, 'file_too_large') };
  }
  if (isAllowedAudioType(file.type)) return { ok: true, contentType: baseMimeType(file.type) };
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const inferred = AUDIO_EXTENSION_TYPES[extension];
  if (inferred !== undefined) return { ok: true, contentType: inferred };
  return { ok: false, message: t('audioFormat') };
}

/** "10 minutes", "90 seconds": prose for a limit, where `formatDuration` is a clock. */
export function describeLimit(t: CaptureT, ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 60 === 0) return t('limit.minutes', { count: seconds / 60 });
  return t('limit.seconds', { count: seconds });
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
