import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

/**
 * Opaque, server-generated object key: `/`-separated lower-case segments, e.g.
 * `projects/<uuid>/materials/<uuid>.jpg`. Never derived from user input such as filenames.
 */
export type StorageKey = string;

export interface StoredObject {
  readonly key: StorageKey;
  readonly sizeBytes: number;
  /** Lower-case hex SHA-256 of exactly the bytes that were stored. */
  readonly sha256: string;
}

/** Inclusive byte offsets: `{ start: 0, end: 0 }` is the first byte. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Where uploaded materials and generated artifacts live (docs/architecture.md section 2).
 * Implementations must make `put` atomic (a key is either absent or complete) and `delete`
 * permanent, because project deletion is a hard delete (P5-04).
 */
export interface Storage {
  /** Writes the object, replacing any existing one, and returns what was written. */
  put(key: StorageKey, body: Uint8Array | Readable): Promise<StoredObject>;
  /**
   * Opens the object for reading, optionally only `range` (inclusive byte offsets, as in an HTTP
   * `Range`). Throws `StorageNotFoundError` when it does not exist.
   */
  get(key: StorageKey, options?: { readonly range?: ByteRange }): Promise<Readable>;
  /** The stored object's size. Throws `StorageNotFoundError` when it does not exist. */
  stat(key: StorageKey): Promise<{ readonly sizeBytes: number }>;
  /** Removes the object. Idempotent: deleting a missing key succeeds. */
  delete(key: StorageKey): Promise<void>;
  exists(key: StorageKey): Promise<boolean>;
  /**
   * The segment names directly below `prefix` (objects and deeper prefixes alike; S3: a
   * `Delimiter: '/'` listing), sorted. Empty when nothing is stored below it.
   */
  listChildren(prefix: StorageKey): Promise<string[]>;
  /**
   * Removes every object whose key starts with `<prefix>/`. Idempotent. Only a project's whole
   * prefix is accepted (`projects/<lower-case uuid>`, `projectStoragePrefix`); anything else,
   * such as `projects` or `system`, throws `InvalidStorageKeyError`, so no caller bug can empty
   * the storage.
   */
  deletePrefix(prefix: StorageKey): Promise<void>;
  /**
   * The newest modification time of anything at or below `prefix` (objects and, locally, the
   * directories themselves), or undefined when nothing is stored there. The orphan sweep's age
   * guard.
   */
  lastModified(prefix: StorageKey): Promise<Date | undefined>;
}

export class StorageError extends Error {
  override name = 'StorageError';
}

export class InvalidStorageKeyError extends StorageError {
  override name = 'InvalidStorageKeyError';

  constructor() {
    // The rejected key is not echoed: it may come from a caller bug carrying user input.
    super('Invalid storage key');
  }
}

export class StorageNotFoundError extends StorageError {
  override name = 'StorageNotFoundError';
  readonly key: StorageKey;

  constructor(key: StorageKey) {
    super(`Storage object ${key} not found`);
    this.key = key;
  }
}

// Segments start with [a-z0-9], so `.`, `..`, hidden names, and the implementation's own
// `.tmp` area are unrepresentable; no `\`, `:`, NUL, or absolute paths either.
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_KEY_LENGTH = 512;

export function isValidStorageKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  return key.split('/').every((segment) => SEGMENT.test(segment));
}

export function assertValidStorageKey(key: string): void {
  if (!isValidStorageKey(key)) throw new InvalidStorageKeyError();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXTENSION = /^[a-z0-9]{1,8}$/;

// Key layout (docs/architecture.md §8 "Storage"): every file derived from a project lives below
// `projects/<projectId>/`, so a project's files can be found and removed by prefix alone:
//
//   projects/<projectId>/materials/<uuid>.<ext>                  uploads (photos, voice memo)
//   projects/<projectId>/runs/<runId>/artifacts/<uuid>.<ext>     staged images, integrity
//                                                                retries, export files
//   system/…                                                     the storage's own records
//
// Masks, transcripts, and every other derived value are database rows, not files.

/** The first segment of every project's files. */
export const PROJECTS_STORAGE_PREFIX = 'projects';

/** `projects/<projectId>`: everything stored for one project lives below this prefix. */
export function projectStoragePrefix(projectId: string): StorageKey {
  if (!UUID.test(projectId)) throw new InvalidStorageKeyError();
  return `${PROJECTS_STORAGE_PREFIX}/${projectId}`;
}

/** Whether a segment below `projects/` can name a project (a lower-case UUID). */
export function isProjectStorageSegment(segment: string): boolean {
  return UUID.test(segment);
}

/** Throws `InvalidStorageKeyError` unless `prefix` is exactly `projects/<lower-case uuid>`. */
export function assertProjectStoragePrefix(prefix: string): void {
  const [first, projectId, ...rest] = prefix.split('/');
  if (
    first !== PROJECTS_STORAGE_PREFIX ||
    projectId === undefined ||
    !UUID.test(projectId) ||
    rest.length > 0
  ) {
    throw new InvalidStorageKeyError();
  }
}

/** A fresh key for one material file of a project: `projects/<id>/materials/<uuid>.<ext>`. */
export function newMaterialStorageKey(projectId: string, extension: string): StorageKey {
  if (!EXTENSION.test(extension)) throw new InvalidStorageKeyError();
  return `${projectStoragePrefix(projectId)}/materials/${randomUUID()}.${extension}`;
}

/**
 * A fresh key for one generated file of a run (e.g. a staged image):
 * `projects/<projectId>/runs/<runId>/artifacts/<uuid>.<ext>`. Under the project prefix, like
 * materials, so everything derived from a project's photos lives below one directory.
 */
export function newRunArtifactStorageKey(
  projectId: string,
  runId: string,
  extension: string,
): StorageKey {
  if (!UUID.test(runId) || !EXTENSION.test(extension)) throw new InvalidStorageKeyError();
  return `${projectStoragePrefix(projectId)}/runs/${runId}/artifacts/${randomUUID()}.${extension}`;
}
