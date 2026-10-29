import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { sendError } from '../http/errors.ts';
import type { Logger } from '../logger.ts';
import { StorageNotFoundError, type Storage } from '../storage/storage.ts';
import { parseRangeHeader } from './range.ts';

/** A stored file as one route serves it. */
export interface StoredFileResponse {
  readonly storageKey: string;
  /** The full `Content-Type` value, e.g. `text/html; charset=utf-8`. */
  readonly contentType: string;
  /**
   * Strong validator (unquoted). Stored files never change under their ID, so the material or
   * artifact ID (or the file's SHA-256) is enough.
   */
  readonly etag: string;
  /** ASCII file name for `Content-Disposition` (server-chosen, never user input). */
  readonly fileName: string;
  readonly disposition: 'inline' | 'attachment';
  /** Answer `Range` with 206 (audio seeking). Off for files a proxy may compress (HTML). */
  readonly rangeable: boolean;
  /** Extra headers, e.g. the export's CSP. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Defaults to `private` (owner-only files). */
  readonly cache?: FileCachePolicy;
}

/**
 * How browsers may keep a file: `private` revalidates every use (owner-only material, so the
 * ownership check runs each time); `public` (the demo API's synthetic runs) may be reused for
 * `maxAgeSeconds` without asking, then revalidated against the ETag.
 */
export type FileCachePolicy =
  { readonly kind: 'private' } | { readonly kind: 'public'; readonly maxAgeSeconds: number };

const PRIVATE: FileCachePolicy = { kind: 'private' };

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Headers every evidence and export file response carries (also 304s). */
export function setFileHeaders(
  res: Response,
  options: { noTransform: boolean; cache?: FileCachePolicy | undefined },
): void {
  const cache = options.cache ?? PRIVATE;
  // Private: `no-cache`, not `max-age`: the browser revalidates (cheap 304s against the ETag),
  // so the ownership check runs on every use and a deleted project's files stop being served.
  const base =
    cache.kind === 'private' ? 'private, no-cache' : `public, max-age=${cache.maxAgeSeconds}`;
  res.set('Cache-Control', options.noTransform ? `${base}, no-transform` : base);
  res.set('X-Content-Type-Options', 'nosniff');
  // Same-origin web app only; another site cannot embed customer material.
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
}

/** `If-None-Match` against a quoted strong ETag: `*`, lists, and weak (`W/`) forms. */
export function etagMatches(header: string | undefined, quoted: string): boolean {
  if (header === undefined) return false;
  return header
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === '*' || value === quoted);
}

function isClientAbort(error: unknown, res: Response): boolean {
  return (
    res.destroyed ||
    (error instanceof Error &&
      'code' in error &&
      (error.code === 'ERR_STREAM_PREMATURE_CLOSE' || error.code === 'ECONNRESET'))
  );
}

/**
 * Streams a stored file with conditional requests (ETag → 304), optional single-range support
 * (206, 416 with `Content-Range: bytes * /size`), and the private-file headers. The caller has
 * already checked ownership and chosen the content type; nothing here reads user input except
 * the Range and validator headers.
 */
export async function sendStoredFile(
  req: Request,
  res: Response,
  storage: Storage,
  file: StoredFileResponse,
  logger: Logger,
): Promise<void> {
  if (!SAFE_FILE_NAME.test(file.fileName)) throw new Error('Unsafe download file name');
  const quotedEtag = `"${file.etag}"`;

  let sizeBytes: number;
  try {
    ({ sizeBytes } = await storage.stat(file.storageKey));
  } catch (error) {
    if (!(error instanceof StorageNotFoundError)) throw error;
    // The database references a file storage does not have: a storage fault, not a client error.
    logger.error({ storageKey: file.storageKey }, 'stored file is missing');
    sendError(res, 500, 'internal_error');
    return;
  }

  if (etagMatches(req.get('if-none-match'), quotedEtag)) {
    setFileHeaders(res, { noTransform: file.rangeable, cache: file.cache });
    res.set('ETag', quotedEtag);
    res.status(304).end();
    return;
  }

  const ifRange = req.get('if-range');
  const outcome =
    file.rangeable && (ifRange === undefined || ifRange.trim() === quotedEtag)
      ? parseRangeHeader(req.get('range'), sizeBytes)
      : ({ kind: 'full' } as const);

  if (outcome.kind === 'unsatisfiable') {
    setFileHeaders(res, { noTransform: file.rangeable, cache: file.cache });
    // An error for this one request, not the file: no cache (private or public) may keep it.
    res.set('Cache-Control', 'no-store');
    res.set('Content-Range', `bytes */${sizeBytes}`);
    sendError(res, 416, 'range_not_satisfiable');
    return;
  }

  const range = outcome.kind === 'partial' ? outcome.range : undefined;
  // Opened before any file header is set, so a failure here answers a clean 500.
  let body: Readable | undefined;
  if (req.method !== 'HEAD') {
    try {
      body = await storage.get(file.storageKey, range === undefined ? {} : { range });
    } catch (error) {
      if (!(error instanceof StorageNotFoundError)) throw error;
      logger.error({ storageKey: file.storageKey }, 'stored file is missing');
      sendError(res, 500, 'internal_error');
      return;
    }
  }

  setFileHeaders(res, { noTransform: file.rangeable, cache: file.cache });
  res.set('ETag', quotedEtag);
  res.set('Content-Type', file.contentType);
  res.set('Content-Disposition', `${file.disposition}; filename="${file.fileName}"`);
  if (file.rangeable) res.set('Accept-Ranges', 'bytes');
  for (const [name, value] of Object.entries(file.headers ?? {})) res.set(name, value);
  if (range === undefined) {
    res.status(200);
    res.set('Content-Length', String(sizeBytes));
  } else {
    res.status(206);
    res.set('Content-Range', `bytes ${range.start}-${range.end}/${sizeBytes}`);
    res.set('Content-Length', String(range.end - range.start + 1));
  }
  if (body === undefined) {
    res.end();
    return;
  }

  try {
    // pipeline destroys both streams on error or client abort, which closes the file handle.
    await pipeline(body, res);
  } catch (error) {
    if (isClientAbort(error, res)) return;
    logger.error({ storageKey: file.storageKey, err: error }, 'streaming a stored file failed');
    // Headers are sent; the only honest signal left is to cut the connection.
    res.destroy();
  }
}
