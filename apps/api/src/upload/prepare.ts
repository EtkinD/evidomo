import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  photoMaterialMetadataSchema,
  voiceMemoMaterialMetadataSchema,
  type JsonObject,
  type MaterialKind,
} from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import { addMaterial, type Material } from '../db/repositories/materials.ts';
import { processVoiceMemo, type VoiceMemoOptions } from '../media/audio.ts';
import { PHOTO_OUTPUT, processPhoto, type PhotoOptions } from '../media/image.ts';
import { newMaterialStorageKey, type Storage, type StoredObject } from '../storage/storage.ts';

// Validation and processing of one input file into what is stored (P2-05 media functions),
// shared by the upload route (`processUpload`) and the headless pipeline CLI (`cli/ingest.ts`).
// Neither the input file nor anything derived from the client (name, MIME type) is kept.

export interface PreparedMaterial {
  readonly kind: MaterialKind;
  /** The stored bytes: re-encoded JPEG or the 16 kHz mono transcription WAV. */
  readonly data: Buffer;
  readonly mimeType: string;
  readonly extension: string;
  /** `photoMaterialMetadataSchema` / `voiceMemoMaterialMetadataSchema`, already validated. */
  readonly metadata: JsonObject;
}

export interface PreparedPhoto extends PreparedMaterial {
  readonly kind: 'photo';
  readonly width: number;
  readonly height: number;
}

/** Throws `UploadRejectedError` for an unacceptable photo; reads but never deletes the input. */
export async function preparePhoto(
  inputPath: string,
  options: PhotoOptions = {},
): Promise<PreparedPhoto> {
  const processed = await processPhoto(inputPath, options);
  const metadata: JsonObject = photoMaterialMetadataSchema.parse({
    width: processed.width,
    height: processed.height,
    sourceFormat: processed.sourceFormat,
    sourceWidth: processed.sourceWidth,
    sourceHeight: processed.sourceHeight,
  });
  return {
    kind: 'photo',
    data: processed.data,
    mimeType: PHOTO_OUTPUT.mimeType,
    extension: PHOTO_OUTPUT.extension,
    metadata,
    width: processed.width,
    height: processed.height,
  };
}

/**
 * Throws `UploadRejectedError` for an unacceptable recording; reads but never deletes the input.
 * The converted WAV is written to a private temp directory that is always removed.
 */
export async function prepareVoiceMemo(
  inputPath: string,
  options: VoiceMemoOptions = {},
): Promise<PreparedMaterial> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'evidomo-voice-'));
  try {
    const processed = await processVoiceMemo(inputPath, path.join(workDir, 'memo.wav'), options);
    const metadata: JsonObject = voiceMemoMaterialMetadataSchema.parse({
      durationMs: processed.durationMs,
      sampleRate: processed.sampleRate,
      sourceContainer: processed.sourceContainer,
      sourceCodec: processed.sourceCodec,
    });
    return {
      kind: 'voice_memo',
      data: await readFile(processed.wavPath),
      mimeType: 'audio/wav',
      extension: 'wav',
      metadata,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Writes the prepared file under a fresh, server-generated key of the project. */
export async function storePrepared(
  storage: Storage,
  projectId: string,
  prepared: PreparedMaterial,
): Promise<StoredObject> {
  return storage.put(newMaterialStorageKey(projectId, prepared.extension), prepared.data);
}

/** The `ready` material row for a stored file, in one insert (no intermediate state). */
export async function insertReadyMaterial(
  db: Executor,
  projectId: string,
  prepared: PreparedMaterial,
  stored: StoredObject,
): Promise<Material> {
  return addMaterial(db, {
    projectId,
    kind: prepared.kind,
    storageKey: stored.key,
    mimeType: prepared.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    status: 'ready',
    metadata: prepared.metadata,
  });
}
