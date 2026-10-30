import { photoMaterialMetadataSchema } from '@evidomo/shared';
import { and, asc, eq, exists, inArray } from 'drizzle-orm';
import type { Executor } from '../db/client.ts';
import { materials, runs } from '../db/schema.ts';
import { StorageNotFoundError, type Storage } from '../storage/storage.ts';
import type { FixtureImageAliases } from './image-aliases.ts';

// Names photos that were uploaded through the web app, for the development replay worker.
//
// A recorded project names each photo after its source file (`photo:<sha256 of the file>`,
// `image-aliases.ts`), and the seed knows those files. A photo uploaded from a browser is a
// different file: the web app re-encodes it on the device (`image-downscale.ts`, a canvas JPEG
// whose bytes depend on the browser build), so no hash of the fixture file can find it. What is
// stable is the order: the project's n-th stored photo stands for the project directory's n-th
// photo. Only projects with a run in progress are mapped, and only when they hold exactly that
// many photos: the same source file uploaded to two projects (as the capture spec does) is the
// same stored bytes at different positions, and must not be named after the recording by
// accident.

export interface UploadPhotoAliasOptions {
  readonly db: Executor;
  readonly storage: Storage;
  readonly aliases: FixtureImageAliases;
  /** SHA-256 of each source photo of the project directory, in upload order. */
  readonly sourceSha256s: readonly string[];
  readonly classificationLongEdgePx: number | undefined;
}

async function readBytes(storage: Storage, key: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of await storage.get(key)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Returns the function to run before a request's images are named
 * (`MatchOptions.beforeImageAlias`). Calls are serialized and each material is read once.
 */
export function createUploadPhotoAliaser(options: UploadPhotoAliasOptions): () => Promise<void> {
  const { db, storage, aliases, sourceSha256s, classificationLongEdgePx } = options;
  const named = new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  async function sync(): Promise<void> {
    const rows = await db
      .select()
      .from(materials)
      .where(
        and(
          eq(materials.kind, 'photo'),
          eq(materials.status, 'ready'),
          exists(
            db
              .select({ one: runs.id })
              .from(runs)
              .where(
                and(
                  eq(runs.projectId, materials.projectId),
                  inArray(runs.status, ['queued', 'running', 'awaiting_gate']),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(materials.projectId), asc(materials.createdAt), asc(materials.id));
    const byProject = new Map<string, (typeof rows)[number][]>();
    for (const row of rows) {
      const group = byProject.get(row.projectId) ?? [];
      group.push(row);
      byProject.set(row.projectId, group);
    }
    for (const group of byProject.values()) {
      if (group.length !== sourceSha256s.length) continue;
      for (const [index, row] of group.entries()) {
        const sourceSha256 = sourceSha256s[index];
        if (sourceSha256 === undefined || named.has(row.id)) continue;
        const metadata = photoMaterialMetadataSchema.safeParse(row.metadata);
        if (!metadata.success) continue;
        let bytes: Uint8Array;
        try {
          bytes = await readBytes(storage, row.storageKey);
        } catch (error) {
          // Rows outlive their files when a dev wipes the storage directory but not the database
          // (the isolated e2e stack does); no run can use that photo, so it needs no name.
          if (error instanceof StorageNotFoundError) continue;
          throw error;
        }
        await aliases.registerPhoto(
          { bytes, width: metadata.data.width, height: metadata.data.height },
          sourceSha256,
          classificationLongEdgePx,
        );
        named.add(row.id);
      }
    }
  }

  return () => {
    const next = queue.then(sync);
    // A failed sync must not poison the queue: the next request tries again.
    queue = next.catch(() => undefined);
    return next;
  };
}
