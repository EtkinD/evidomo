import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { layoutZip, streamZip, updateCrc32, ZipError, type ZipEntry } from '../export/zip.ts';
import { sendError } from '../http/errors.ts';
import type { Logger } from '../logger.ts';
import { StorageNotFoundError, type Storage } from '../storage/storage.ts';
import { etagMatches, isClientAbort, setFileHeaders, type FileCachePolicy } from './send-file.ts';
import type { ServableExportArchive } from './service.ts';

// The export archive route's response (docs/architecture.md §5, "Export archive"): every file of
// the stored export in one stored ZIP. Entries are the manifest's files under their manifest
// names (flat, so `portal-fields.json`'s image names resolve inside the archive).
//
// Two passes over storage, no buffering: the first reads each file once to get its CRC-32 (a
// local header precedes the bytes and must carry it) and checks size and SHA-256 against the
// manifest, so a damaged export answers a clean 500 before any header is sent; the second
// streams the bytes. Exports are bounded (tens of MB, at most a few dozen files).

/** Server-chosen ASCII name for `Content-Disposition` (the run ID is a UUID). */
export function exportArchiveFileName(runId: string): string {
  return `evidomo-listing-pack-${runId.slice(0, 8)}.zip`;
}

type PreparedEntry = ZipEntry & { readonly storageKey: string };

/** Reads every file once; undefined (after logging) when storage and manifest disagree. */
async function checksummedEntries(
  storage: Storage,
  archive: ServableExportArchive,
  logger: Logger,
): Promise<PreparedEntry[] | undefined> {
  const entries: PreparedEntry[] = [];
  for (const file of archive.files) {
    const { storageKey } = file.artifact;
    let crc = 0;
    let sizeBytes = 0;
    const sha256 = createHash('sha256');
    try {
      const stream: AsyncIterable<Uint8Array> = await storage.get(storageKey);
      for await (const chunk of stream) {
        crc = updateCrc32(crc, chunk);
        sha256.update(chunk);
        sizeBytes += chunk.byteLength;
      }
    } catch (error) {
      if (!(error instanceof StorageNotFoundError)) throw error;
      logger.error({ storageKey }, 'stored export file is missing');
      return undefined;
    }
    if (sizeBytes !== file.sizeBytes || sha256.digest('hex') !== file.sha256) {
      logger.error({ storageKey }, 'stored export file does not match its manifest entry');
      return undefined;
    }
    entries.push({ name: file.fileName, sizeBytes, crc32: crc, storageKey });
  }
  return entries;
}

/** HEAD: the archive's length needs the manifest's sizes only; storage is just checked. */
async function plannedEntries(
  storage: Storage,
  archive: ServableExportArchive,
  logger: Logger,
): Promise<PreparedEntry[] | undefined> {
  const entries: PreparedEntry[] = [];
  for (const file of archive.files) {
    const { storageKey } = file.artifact;
    try {
      const { sizeBytes } = await storage.stat(storageKey);
      if (sizeBytes !== file.sizeBytes) {
        logger.error({ storageKey }, 'stored export file does not match its manifest entry');
        return undefined;
      }
    } catch (error) {
      if (!(error instanceof StorageNotFoundError)) throw error;
      logger.error({ storageKey }, 'stored export file is missing');
      return undefined;
    }
    entries.push({ name: file.fileName, sizeBytes: file.sizeBytes, crc32: 0, storageKey });
  }
  return entries;
}

/**
 * Answers `GET`/`HEAD` of the archive: conditional (ETag from the manifest artifact, immutable),
 * always an attachment, never compressed in transit, no ranges. A storage or manifest mismatch is
 * a 500 before any header; a failure after the first byte can only cut the connection.
 */
export async function sendExportArchive(
  req: Request,
  res: Response,
  storage: Storage,
  archive: ServableExportArchive,
  runId: string,
  cache: FileCachePolicy,
  logger: Logger,
): Promise<void> {
  // The stored files never change under their manifest, and the writer is deterministic, so the
  // manifest artifact versions the archive; `v1` versions the layout.
  const quotedEtag = `"export-zip-v1-${archive.manifestArtifactId}"`;
  if (etagMatches(req.get('if-none-match'), quotedEtag)) {
    setFileHeaders(res, { noTransform: true, cache });
    res.set('ETag', quotedEtag);
    res.status(304).end();
    return;
  }

  const head = req.method === 'HEAD';
  const entries = head
    ? await plannedEntries(storage, archive, logger)
    : await checksummedEntries(storage, archive, logger);
  if (entries === undefined) {
    sendError(res, 500, 'internal_error');
    return;
  }
  let layout: ReturnType<typeof layoutZip>;
  try {
    layout = layoutZip(entries, archive.storedAt);
  } catch (error) {
    if (!(error instanceof ZipError)) throw error;
    logger.error({ err: error }, 'the export does not fit an archive');
    sendError(res, 500, 'internal_error');
    return;
  }

  setFileHeaders(res, { noTransform: true, cache });
  res.set('ETag', quotedEtag);
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${exportArchiveFileName(runId)}"`);
  res.status(200);
  res.set('Content-Length', String(layout.sizeBytes));
  if (head) {
    res.end();
    return;
  }

  const keys = new Map(entries.map((entry) => [entry.name, entry.storageKey]));
  const body = Readable.from(
    streamZip(entries, layout, async (entry) => {
      const storageKey = keys.get(entry.name);
      if (storageKey === undefined) throw new Error('Archive entry without a storage key');
      return storage.get(storageKey);
    }),
    { objectMode: false },
  );
  try {
    // pipeline destroys both streams on error or client abort, which closes the open file.
    await pipeline(body, res);
  } catch (error) {
    if (isClientAbort(error, res)) return;
    logger.error({ err: error }, 'streaming the export archive failed');
    // Headers are sent; the only honest signal left is to cut the connection.
    res.destroy();
  }
}
