import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Executor } from '../db/client.ts';
import type { Material } from '../db/repositories/materials.ts';
import { UploadRejectedError } from '../media/upload-error.ts';
import type { Storage } from '../storage/storage.ts';
import {
  insertReadyMaterial,
  preparePhoto,
  prepareVoiceMemo,
  storePrepared,
} from '../upload/prepare.ts';

// The project's inputs as uploads: the same validation and processing as the upload route
// (`upload/prepare.ts`, shared with `processUpload`), then storage and a `ready` material row,
// in upload order. The CLI's files belong to the operator, so nothing here deletes them.

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
  let prepared;
  try {
    prepared = await preparePhoto(photo.path);
  } catch (error) {
    throw rejected(photo.path, error);
  }
  const stored = await storePrepared(storage, projectId, prepared);
  return {
    material: await insertReadyMaterial(db, projectId, prepared, stored),
    name: photo.name,
    sourceSha256: sha256Hex(source),
    stored: {
      bytes: new Uint8Array(prepared.data),
      width: prepared.width,
      height: prepared.height,
    },
  };
}

export async function ingestVoiceMemo(
  db: Executor,
  storage: Storage,
  projectId: string,
  file: string,
): Promise<Material> {
  let prepared;
  try {
    prepared = await prepareVoiceMemo(file);
  } catch (error) {
    throw rejected(file, error);
  }
  const stored = await storePrepared(storage, projectId, prepared);
  return insertReadyMaterial(db, projectId, prepared, stored);
}
