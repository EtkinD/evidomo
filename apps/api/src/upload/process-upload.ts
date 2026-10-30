import { rm } from 'node:fs/promises';
import {
  UPLOAD_LIMITS,
  type MaterialKind,
  type ServiceDefinition,
  type UploadLimits,
} from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import {
  deleteProjectMaterials,
  getMaterialByStorageKey,
  listMaterials,
  type Material,
} from '../db/repositories/materials.ts';
import { lockProject, touchProject } from '../db/repositories/projects.ts';
import { listRunsForProject } from '../db/repositories/runs.ts';
import type { Logger } from '../logger.ts';
import { inputsLocked } from '../projects/input-lock.ts';
import type { Storage, StoredObject } from '../storage/storage.ts';
import {
  insertReadyMaterial,
  preparePhoto,
  prepareVoiceMemo,
  storePrepared,
  type PreparedMaterial,
} from './prepare.ts';
import { UploadAbortedError } from './receive.ts';

// `processUpload` (docs/architecture.md §8 "Uploads and storage"): validate and process one
// received file by its content, store it, and write its `ready` material row under the project
// lock, which re-checks the upload rules atomically. It owns the temp file on every path.

/** What the capture screen and the upload rules take from the service definition. */
export interface CaptureInputs {
  readonly photos: { readonly min: number; readonly max: number; readonly required: boolean };
  readonly voiceMemo: { readonly maxSeconds: number; readonly required: boolean };
}

/**
 * The service's photo and voice memo inputs. A service without both cannot be captured through
 * the web app, so this throws at startup rather than at the first upload.
 */
export function captureInputs(service: ServiceDefinition): CaptureInputs {
  const images = service.inputs.find((input) => input.type === 'images');
  const audio = service.inputs.find((input) => input.type === 'audio');
  if (images?.type !== 'images' || audio?.type !== 'audio') {
    throw new Error(
      `Service ${service.id} v${service.version} needs one images and one audio input for capture`,
    );
  }
  return {
    photos: { min: images.min, max: images.max, required: images.required },
    voiceMemo: { maxSeconds: audio.max_seconds, required: audio.required },
  };
}

export type UploadConflictReason = 'project_not_found' | 'inputs_locked' | 'photo_limit_reached';

/** The upload is valid but the project does not accept it (now). Nothing was stored. */
export class UploadConflictError extends Error {
  override name = 'UploadConflictError';
  readonly reason: UploadConflictReason;

  constructor(reason: UploadConflictReason) {
    super(`Upload refused: ${reason}`);
    this.reason = reason;
  }
}

/**
 * Why the project accepts no upload of `kind` right now, or undefined: inputs are locked
 * (`inputsLocked`: a run other than a failed one exists), or the photo maximum is reached.
 * Authoritative only under the project lock.
 */
export async function uploadBlocker(
  db: Executor,
  projectId: string,
  kind: MaterialKind,
  capture: CaptureInputs,
): Promise<Exclude<UploadConflictReason, 'project_not_found'> | undefined> {
  if (inputsLocked(await listRunsForProject(db, projectId))) return 'inputs_locked';
  if (kind === 'photo') {
    const photos = await listMaterials(db, projectId, { kind: 'photo' });
    if (photos.length >= capture.photos.max) return 'photo_limit_reached';
  }
  return undefined;
}

export interface ProcessUploadInput {
  readonly projectId: string;
  readonly kind: MaterialKind;
  /** Owned by `processUpload` from the call on: deleted on every path. */
  readonly tempFilePath: string;
  /** Logged for diagnostics only; never used for validation. */
  readonly clientMime?: string | undefined;
  /** Aborts when the client disconnects: nothing is committed after it fires. */
  readonly signal?: AbortSignal | undefined;
}

export type ProcessUpload = (input: ProcessUploadInput) => Promise<Material>;

/** The database side of an upload, separate so the processor can be tested without one. */
export interface MaterialCommitter {
  /**
   * Writes the `ready` row under the project lock after re-checking the upload rules; returns the
   * row and the storage keys of the rows it replaced (a previous voice memo). Throws
   * `UploadConflictError` when the project refuses the upload.
   */
  commit(
    input: ProcessUploadInput,
    prepared: PreparedMaterial,
    stored: StoredObject,
  ): Promise<{ material: Material; replacedKeys: string[] }>;
  /** The row stored under `storageKey`, if one exists. */
  findByStorageKey(storageKey: string): Promise<Material | undefined>;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new UploadAbortedError('The client aborted the upload');
}

export function createMaterialCommitter(db: Executor, capture: CaptureInputs): MaterialCommitter {
  return {
    async commit(input, prepared, stored) {
      return db.transaction(async (tx) => {
        const project = await lockProject(tx, input.projectId);
        if (project === undefined) throw new UploadConflictError('project_not_found');
        const blocker = await uploadBlocker(tx, input.projectId, input.kind, capture);
        if (blocker !== undefined) throw new UploadConflictError(blocker);
        let replacedKeys: string[] = [];
        if (input.kind === 'voice_memo') {
          // The service takes one walkthrough: a new upload replaces the previous one.
          const previous = await listMaterials(tx, input.projectId, { kind: 'voice_memo' });
          replacedKeys = await deleteProjectMaterials(
            tx,
            input.projectId,
            previous.map((material) => material.id),
          );
        }
        throwIfAborted(input.signal);
        const material = await insertReadyMaterial(tx, input.projectId, prepared, stored);
        // Input changed: a failed run created before it is no longer resumable (a replaced
        // voice memo leaves no row behind to compare with).
        await touchProject(tx, input.projectId);
        return { material, replacedKeys };
      });
    },
    findByStorageKey: (storageKey) => getMaterialByStorageKey(db, storageKey),
  };
}

export interface UploadProcessorDeps {
  readonly storage: Storage;
  readonly logger: Logger;
  readonly capture: CaptureInputs;
  readonly committer: MaterialCommitter;
  readonly limits?: UploadLimits;
  /**
   * Decoding a 100 MP photo takes several hundred MB; at most this many uploads are processed at
   * once per process, the rest wait their turn.
   */
  readonly maxConcurrent?: number;
  /** Validation and processing; defaults to `preparePhoto` / `prepareVoiceMemo` (tests fake it). */
  readonly prepare?: (input: ProcessUploadInput, limits: UploadLimits) => Promise<PreparedMaterial>;
}

/** A FIFO semaphore: `run` waits for a free slot, which is released however `task` ends. */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}

export function createUploadProcessor(deps: UploadProcessorDeps): ProcessUpload {
  const { storage, logger, capture, committer } = deps;
  const limits = deps.limits ?? UPLOAD_LIMITS;
  const limited = createLimiter(deps.maxConcurrent ?? 2);
  const prepareFile =
    deps.prepare ??
    (async (input: ProcessUploadInput, current: UploadLimits): Promise<PreparedMaterial> => {
      if (input.kind === 'photo') {
        return preparePhoto(input.tempFilePath, {
          maxBytes: current.photoMaxBytes,
          maxPixels: current.photoMaxPixels,
          longEdgePx: current.photoLongEdgePx,
        });
      }
      return prepareVoiceMemo(input.tempFilePath, {
        maxBytes: current.voiceMemoMaxBytes,
        maxDurationMs: Math.min(
          current.voiceMemoMaxDurationMs,
          capture.voiceMemo.maxSeconds * 1000,
        ),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    });

  async function removeStored(key: string, why: string): Promise<void> {
    try {
      await storage.delete(key);
    } catch (error) {
      // The key is server-generated (no personal data); an orphaned file is found by it.
      logger.error({ err: error, storageKey: key }, `could not delete ${why} upload file`);
    }
  }

  type CommitOutcome =
    | { readonly kind: 'absent' }
    | { readonly kind: 'committed'; readonly material: Material }
    | { readonly kind: 'unknown' };

  /**
   * After a failed commit, whether its row exists. A lost connection during COMMIT is ambiguous:
   * the row may exist, and deleting its file would leave a row without a file, which breaks the
   * next run. A definite refusal (`UploadConflictError`, an abort before the insert) needs no
   * lookup; a failed lookup is `unknown`, and the file is kept (an orphaned file is harmless).
   */
  async function outcomeAfter(error: unknown, key: string): Promise<CommitOutcome> {
    if (error instanceof UploadConflictError || error instanceof UploadAbortedError) {
      return { kind: 'absent' };
    }
    try {
      const material = await committer.findByStorageKey(key);
      return material === undefined ? { kind: 'absent' } : { kind: 'committed', material };
    } catch (lookupError) {
      logger.error(
        { err: lookupError, storageKey: key },
        'upload commit outcome unknown; keeping the stored file',
      );
      return { kind: 'unknown' };
    }
  }

  return async function processUpload(input) {
    const startedAt = Date.now();
    let stored: StoredObject | undefined;
    try {
      const prepared = await limited(async () => {
        throwIfAborted(input.signal);
        return prepareFile(input, limits);
      });
      throwIfAborted(input.signal);
      stored = await storePrepared(storage, input.projectId, prepared);
      let committed: { material: Material; replacedKeys: string[] };
      try {
        committed = await committer.commit(input, prepared, stored);
      } catch (error) {
        const outcome = await outcomeAfter(error, stored.key);
        if (outcome.kind === 'unknown') stored = undefined;
        if (outcome.kind !== 'committed') throw error;
        // The transaction did commit. A replaced voice memo's file cannot be identified any more
        // and stays as an orphan (its row is gone); the new upload stands.
        logger.warn(
          { projectId: input.projectId, materialId: outcome.material.id },
          'upload commit reported an error but its row exists',
        );
        committed = { material: outcome.material, replacedKeys: [] };
      }
      const { material, replacedKeys } = committed;
      stored = undefined;
      for (const key of replacedKeys) await removeStored(key, 'replaced');
      logger.info(
        {
          projectId: input.projectId,
          materialId: material.id,
          kind: input.kind,
          clientMime: input.clientMime,
          sizeBytes: material.sizeBytes,
          replaced: replacedKeys.length,
          durationMs: Date.now() - startedAt,
        },
        'upload processed',
      );
      return material;
    } finally {
      if (stored !== undefined) await removeStored(stored.key, 'uncommitted');
      await rm(input.tempFilePath, { force: true });
    }
  };
}
