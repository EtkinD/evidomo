import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Receiving one raw upload body (Express 5 has no multipart parser, and none is needed for one
// file per request): streamed to a private temp file with a hard byte limit, never buffered.

/** A configured upload temp directory is not private to this process's user. */
export class UnsafeUploadTempDirError extends Error {
  override name = 'UnsafeUploadTempDirError';
}

/**
 * Checks that `dir` is a real directory (not a symlink) owned by this process's user with no
 * group or other permissions, so no other local user can read uploads or plant files in it.
 */
export async function verifyPrivateDir(dir: string): Promise<string> {
  const info = await lstat(dir);
  const uid = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new UnsafeUploadTempDirError('The upload temp path is not a directory');
  }
  if (uid !== undefined && info.uid !== uid) {
    throw new UnsafeUploadTempDirError('The upload temp directory belongs to another user');
  }
  if ((info.mode & 0o077) !== 0) {
    throw new UnsafeUploadTempDirError('The upload temp directory must have mode 0700');
  }
  return dir;
}

/**
 * The upload temp directory, resolved once: the configured one after `verifyPrivateDir`, or by
 * default a fresh per-process `mkdtemp` directory (mode 0700, unpredictable name) under the OS
 * temp directory, never a fixed path another user could create first. A failed attempt is
 * retried on the next upload.
 */
export function createUploadTempDir(configured?: string): () => Promise<string> {
  let resolved: Promise<string> | undefined;
  return () => {
    resolved ??= (
      configured === undefined
        ? mkdtemp(path.join(tmpdir(), 'evidomo-uploads-'))
        : verifyPrivateDir(configured)
    ).catch((error: unknown) => {
      resolved = undefined;
      throw error;
    });
    return resolved;
  };
}

/** The body exceeded the limit; nothing past the limit was written, and the file is removed. */
export class UploadBodyTooLargeError extends Error {
  override name = 'UploadBodyTooLargeError';
}

/** The client went away before the body ended; the partial file is removed. */
export class UploadAbortedError extends Error {
  override name = 'UploadAbortedError';
}

export interface ReceiveUploadOptions {
  readonly maxBytes: number;
  /** A private directory (`createUploadTempDir`). */
  readonly tempDir: string;
}

/** The declared `Content-Length`, or undefined for a chunked body. */
export function declaredLength(req: IncomingMessage): number | undefined {
  const raw = req.headers['content-length'];
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * Streams `req` into a new temp file (mode 0600) and resolves with its path; the caller then
 * owns the file. Rejects with {@link UploadBodyTooLargeError} as soon as the received bytes pass
 * `maxBytes` (whatever `Content-Length` claimed), or {@link UploadAbortedError} when the client
 * disconnects; in both cases the partial file is deleted before the promise settles.
 *
 * On a too-large body the request is paused, not destroyed, so the caller can still answer 413;
 * it should send `Connection: close` so Node does not read the rest of the body.
 */
export async function receiveUploadToTempFile(
  req: IncomingMessage,
  options: ReceiveUploadOptions,
): Promise<string> {
  const file = path.join(options.tempDir, randomUUID());
  const out = createWriteStream(file, { flags: 'wx', mode: 0o600 });

  try {
    await new Promise<void>((resolve, reject) => {
      let received = 0;
      let settled = false;

      const cleanup = (): void => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onRequestError);
        req.off('close', onClose);
        out.off('error', onWriteError);
        out.off('finish', onFinish);
        out.off('drain', onDrain);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        req.pause();
        out.destroy();
        reject(error);
      };
      const onData = (chunk: Buffer): void => {
        received += chunk.length;
        if (received > options.maxBytes) {
          fail(new UploadBodyTooLargeError(`Upload body exceeds ${options.maxBytes} bytes`));
          return;
        }
        if (!out.write(chunk)) req.pause();
      };
      const onDrain = (): void => {
        req.resume();
      };
      const onEnd = (): void => {
        out.end();
      };
      const onFinish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onRequestError = (): void => {
        fail(new UploadAbortedError('The client aborted the upload'));
      };
      const onClose = (): void => {
        if (!req.complete) fail(new UploadAbortedError('The client aborted the upload'));
      };
      const onWriteError = (error: Error): void => {
        fail(error);
      };

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onRequestError);
      req.on('close', onClose);
      out.on('error', onWriteError);
      out.on('finish', onFinish);
      out.on('drain', onDrain);
      // The socket may already be gone (e.g. the client aborted while a guard ran).
      if (req.destroyed && !req.complete) onClose();
    });
  } catch (error) {
    // Wait for the stream to release the descriptor before unlinking.
    await new Promise<void>((resolve) => {
      if (out.closed) resolve();
      else out.once('close', () => resolve());
    });
    await rm(file, { force: true });
    throw error;
  }
  return file;
}
