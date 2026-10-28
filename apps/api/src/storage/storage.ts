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

/**
 * Where uploaded materials and generated artifacts live (docs/architecture.md section 2).
 * Implementations must make `put` atomic (a key is either absent or complete) and `delete`
 * permanent, because project deletion is a hard delete (P5-04).
 */
export interface Storage {
  /** Writes the object, replacing any existing one, and returns what was written. */
  put(key: StorageKey, body: Uint8Array | Readable): Promise<StoredObject>;
  /** Opens the object for reading. Throws `StorageNotFoundError` when it does not exist. */
  get(key: StorageKey): Promise<Readable>;
  /** Removes the object. Idempotent: deleting a missing key succeeds. */
  delete(key: StorageKey): Promise<void>;
  exists(key: StorageKey): Promise<boolean>;
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

/** A fresh key for one material file of a project: `projects/<id>/materials/<uuid>.<ext>`. */
export function newMaterialStorageKey(projectId: string, extension: string): StorageKey {
  if (!UUID.test(projectId) || !EXTENSION.test(extension)) throw new InvalidStorageKeyError();
  return `projects/${projectId}/materials/${randomUUID()}.${extension}`;
}
