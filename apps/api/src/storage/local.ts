import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  assertValidStorageKey,
  InvalidStorageKeyError,
  StorageNotFoundError,
  type Storage,
  type StorageKey,
  type StoredObject,
} from './storage.ts';

/** In-progress writes live under the root so the final `rename` stays on one filesystem. */
const TMP_DIR = '.tmp';

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return isErrnoException(error) && error.code !== undefined && codes.includes(error.code);
}

/** `write` may write fewer bytes than asked; loop until the chunk is on disk. */
async function writeFully(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    offset += bytesWritten;
  }
}

/** fsync on the directory makes the rename itself durable across a crash. */
async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface LocalStorageOptions {
  /** Absolute directory; `STORAGE_DIR` (the `/data` volume in production). Created on demand. */
  readonly rootDir: string;
}

/**
 * Filesystem storage rooted at `rootDir`. Keys map to paths below the root; writes go to a
 * temp file that is fsynced and renamed into place, so readers never see a partial object.
 */
export function createLocalStorage(options: LocalStorageOptions): Storage {
  if (!path.isAbsolute(options.rootDir)) {
    throw new Error('Local storage root must be an absolute path');
  }
  const root = path.resolve(options.rootDir);

  function pathFor(key: StorageKey): string {
    assertValidStorageKey(key);
    const resolved = path.resolve(root, ...key.split('/'));
    // The key grammar already excludes traversal; this is the backstop if it ever changes.
    const relative = path.relative(root, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new InvalidStorageKeyError();
    }
    return resolved;
  }

  return {
    async put(key, body) {
      const target = pathFor(key);
      const tmpDir = path.join(root, TMP_DIR);
      await mkdir(tmpDir, { recursive: true, mode: 0o700 });
      const tmpPath = path.join(tmpDir, randomUUID());

      const hash = createHash('sha256');
      let sizeBytes = 0;
      try {
        // `wx`: never follow or reuse an existing path; 0600 because uploads are personal data.
        const handle = await open(tmpPath, 'wx', 0o600);
        try {
          const source = body instanceof Uint8Array ? [body] : body;
          for await (const chunk of source) {
            if (!(chunk instanceof Uint8Array)) {
              throw new TypeError('Storage bodies must be byte streams');
            }
            hash.update(chunk);
            sizeBytes += chunk.byteLength;
            await writeFully(handle, chunk);
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        const targetDir = path.dirname(target);
        await mkdir(targetDir, { recursive: true, mode: 0o700 });
        await rename(tmpPath, target);
        await syncDirectory(targetDir);
      } catch (error) {
        await rm(tmpPath, { force: true });
        throw error;
      }

      return { key, sizeBytes, sha256: hash.digest('hex') } satisfies StoredObject;
    },

    async get(key, options = {}) {
      const target = pathFor(key);
      const { range } = options;
      if (
        range !== undefined &&
        (!Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.end) ||
          range.start < 0 ||
          range.end < range.start)
      ) {
        throw new RangeError('Invalid byte range');
      }
      let handle;
      try {
        handle = await open(target, 'r');
      } catch (error) {
        if (hasCode(error, 'ENOENT', 'ENOTDIR')) throw new StorageNotFoundError(key);
        throw error;
      }
      try {
        if (!(await handle.stat()).isFile()) throw new StorageNotFoundError(key);
      } catch (error) {
        await handle.close();
        throw error;
      }
      // The stream owns the handle from here and closes it on end or error.
      return range === undefined
        ? handle.createReadStream()
        : handle.createReadStream({ start: range.start, end: range.end });
    },

    async stat(key) {
      const target = pathFor(key);
      let stats;
      try {
        stats = await stat(target);
      } catch (error) {
        if (hasCode(error, 'ENOENT', 'ENOTDIR')) throw new StorageNotFoundError(key);
        throw error;
      }
      if (!stats.isFile()) throw new StorageNotFoundError(key);
      return { sizeBytes: stats.size };
    },

    async delete(key) {
      // No `recursive`: a key always names a file, so a directory here is a bug, not a delete.
      await rm(pathFor(key), { force: true });
    },

    async exists(key) {
      try {
        return (await stat(pathFor(key))).isFile();
      } catch (error) {
        if (hasCode(error, 'ENOENT', 'ENOTDIR')) return false;
        throw error;
      }
    },
  };
}
