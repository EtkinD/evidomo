import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  photoMaterialMetadataSchema,
  voiceMemoMaterialMetadataSchema,
  type JsonObject,
} from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import { addMaterial, setMaterialStatus, type Material } from '../db/repositories/materials.ts';
import { processVoiceMemo } from '../media/audio.ts';
import { processPhoto } from '../media/image.ts';
import { UploadRejectedError } from '../media/upload-error.ts';
import { newMaterialStorageKey, type Storage } from '../storage/storage.ts';

// The project's inputs as uploads: the same validation and processing the upload route will
// use (P2-05 media functions), then storage and a `ready` material row, in upload order.
// There is no `processUpload` service yet (P4-03 adds the route); this is its minimal CLI form.

/** An input file was refused by upload validation; the message is the uploader-safe one. */
export class InputRejectedError extends Error {
  override name = 'InputRejectedError';
}

export interface IngestedPhoto {
  readonly material: Material;
  readonly name: string;
  readonly sourceSha256: string;
  readonly stored: { readonly bytes: Uint8Array; readonly width: number; readonly height: number };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function rejected(file: string, error: unknown): unknown {
  if (error instanceof UploadRejectedError) {
    return new InputRejectedError(`${path.basename(file)}: ${error.code}: ${error.message}`, {
      cause: error,
    });
  }
  return error;
}

export async function ingestPhoto(
  db: Executor,
  storage: Storage,
  projectId: string,
  photo: { readonly name: string; readonly path: string },
): Promise<IngestedPhoto> {
  const source = new Uint8Array(await readFile(photo.path));
  let processed;
  try {
    processed = await processPhoto(photo.path);
  } catch (error) {
    throw rejected(photo.path, error);
  }
  const stored = await storage.put(newMaterialStorageKey(projectId, 'jpg'), processed.data);
  const material = await addMaterial(db, {
    projectId,
    kind: 'photo',
    storageKey: stored.key,
    mimeType: 'image/jpeg',
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    status: 'processing',
  });
  const metadata: JsonObject = photoMaterialMetadataSchema.parse({
    width: processed.width,
    height: processed.height,
    sourceFormat: processed.sourceFormat,
    sourceWidth: processed.sourceWidth,
    sourceHeight: processed.sourceHeight,
  });
  return {
    material: await setMaterialStatus(db, material.id, 'ready', metadata),
    name: photo.name,
    sourceSha256: sha256Hex(source),
    stored: {
      bytes: new Uint8Array(processed.data),
      width: processed.width,
      height: processed.height,
    },
  };
}

export async function ingestVoiceMemo(
  db: Executor,
  storage: Storage,
  projectId: string,
  file: string,
): Promise<Material> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'evidomo-pipeline-voice-'));
  try {
    let processed;
    try {
      processed = await processVoiceMemo(file, path.join(workDir, 'memo.wav'));
    } catch (error) {
      throw rejected(file, error);
    }
    const wav = await readFile(processed.wavPath);
    const stored = await storage.put(newMaterialStorageKey(projectId, 'wav'), wav);
    const material = await addMaterial(db, {
      projectId,
      kind: 'voice_memo',
      storageKey: stored.key,
      mimeType: 'audio/wav',
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      status: 'processing',
    });
    const metadata: JsonObject = voiceMemoMaterialMetadataSchema.parse({
      durationMs: processed.durationMs,
      sampleRate: processed.sampleRate,
      sourceContainer: processed.sourceContainer,
      sourceCodec: processed.sourceCodec,
    });
    return await setMaterialStatus(db, material.id, 'ready', metadata);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
