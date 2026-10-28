import type { UploadRejectionCode } from '@evidomo/shared';

/**
 * The upload itself is unacceptable (wrong type, too large, too long, undecodable). The message
 * is written for the uploader and never contains paths, filenames, or decoder output; those stay
 * in `cause` for server-side debugging. Anything that is not an `UploadRejectedError` is a
 * server fault.
 */
export class UploadRejectedError extends Error {
  override name = 'UploadRejectedError';
  readonly code: UploadRejectionCode;

  constructor(code: UploadRejectionCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** Errno-style failures (ENOENT, ENOSPC, ABORT_ERR, ...) are environment faults, not bad input. */
export function isEnvironmentError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}
