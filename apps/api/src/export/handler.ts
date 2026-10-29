import {
  EXPORT_HTML_ARTIFACT_KIND,
  EXPORT_IMAGE_ARTIFACT_KIND,
  EXPORT_MANIFEST_ARTIFACT_KIND,
  EXPORT_PORTAL_FIELDS_ARTIFACT_KIND,
  exportFileContentSchema,
  packExportedPayloadSchema,
  type ExportFileRole,
} from '@evidomo/shared';
import type { Executor } from '../db/client.ts';
import { insertArtifact, listArtifacts } from '../db/repositories/artifacts.ts';
import { appendRunEvent } from '../db/repositories/run-events.ts';
import type { Logger } from '../logger.ts';
import type { StepHandler } from '../runs/steps.ts';
import { newRunArtifactStorageKey, type Storage, type StoredObject } from '../storage/storage.ts';
import { buildRunExport, type BuiltExportFile, type ExportDeps } from './build.ts';

// The export step (docs/architecture.md §5 step 9, agent `exporter`): code only, after Gate 2's
// approval resumes the run. Builds the pack from stored artifacts (`build.ts`), writes every file
// to storage, and in the completion transaction stores one artifact per file (content-derived
// IDs), the `export` manifest, and a `pack_exported` event with counts only.

const KIND_BY_ROLE: Readonly<Record<ExportFileRole, string>> = {
  html: EXPORT_HTML_ARTIFACT_KIND,
  portal_fields: EXPORT_PORTAL_FIELDS_ARTIFACT_KIND,
  image: EXPORT_IMAGE_ARTIFACT_KIND,
};

const EXTENSION_BY_ROLE: Readonly<Record<ExportFileRole, string>> = {
  html: 'html',
  portal_fields: 'json',
  image: 'jpg',
};

async function deleteFiles(
  storage: Storage,
  logger: Logger,
  objects: readonly StoredObject[],
): Promise<void> {
  for (const object of objects) {
    try {
      await storage.delete(object.key);
    } catch (error) {
      logger.error({ err: error, storageKey: object.key }, 'could not delete an export file');
    }
  }
}

/** Every stored export artifact of the step, manifest first (for a repeated commit). */
async function storedArtifactIds(tx: Executor, runId: string, stepId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const kind of [
    EXPORT_MANIFEST_ARTIFACT_KIND,
    EXPORT_HTML_ARTIFACT_KIND,
    EXPORT_PORTAL_FIELDS_ARTIFACT_KIND,
    EXPORT_IMAGE_ARTIFACT_KIND,
  ]) {
    ids.push(...(await listArtifacts(tx, runId, { kind, stepId })).map((a) => a.id));
  }
  return ids;
}

export function createExportHandler(deps: ExportDeps): StepHandler<'exporter'> {
  return async (ctx) => {
    const { run, step } = ctx;
    const built = await buildRunExport(deps, ctx.db, run, { signal: ctx.signal });

    // Files are written before the completion transaction (storage is not transactional) and
    // removed again if anything fails before or inside `commit`, so no unreferenced copy of a
    // customer-derived file is left behind.
    const written: { file: BuiltExportFile; stored: StoredObject }[] = [];
    try {
      for (const file of built.files) {
        ctx.signal.throwIfAborted();
        const stored = await deps.storage.put(
          newRunArtifactStorageKey(run.projectId, run.id, EXTENSION_BY_ROLE[file.role]),
          file.bytes,
        );
        written.push({ file, stored });
        if (stored.sha256 !== file.sha256) {
          throw new Error('An export file was not stored as built');
        }
      }
    } catch (error) {
      await deleteFiles(
        deps.storage,
        ctx.logger,
        written.map((w) => w.stored),
      );
      throw error;
    }
    const writtenObjects = written.map((w) => w.stored);

    const { counts } = built.manifest;
    const checklistFailCount = built.checklist.summary.counts.fail;
    const summary = {
      imageCount: counts.images,
      originalCount: counts.originals,
      stagedCount: counts.staged,
      blurredImageCount: counts.blurredImages,
      blurredRegionCount: counts.blurredRegions,
      withheldCount: counts.withheld,
      checklistFailCount,
      readyToPublish: built.manifest.readyToPublish,
    };
    if (counts.withheld > 0 || !built.manifest.readyToPublish) {
      ctx.logger.warn(summary, 'pack exported with withheld images or failing checklist items');
    } else {
      ctx.logger.info(summary, 'pack exported');
    }

    return {
      async commit(tx) {
        try {
          // Idempotency, as in the other steps: commit runs inside the engine's completion
          // transaction (run row locked, claim re-checked). A repeated commit keeps the stored
          // export and drops this execution's files.
          const [existing] = await listArtifacts(tx, run.id, {
            kind: EXPORT_MANIFEST_ARTIFACT_KIND,
            stepId: step.id,
          });
          if (existing !== undefined) {
            ctx.logger.warn(
              { artifactId: existing.id },
              'export already stored for this step; keeping the existing one',
            );
            await deleteFiles(deps.storage, ctx.logger, writtenObjects);
            return { artifactIds: await storedArtifactIds(tx, run.id, step.id) };
          }

          for (const { file, stored } of written) {
            await insertArtifact(tx, {
              id: file.artifactId,
              runId: run.id,
              stepId: step.id,
              kind: KIND_BY_ROLE[file.role],
              content: exportFileContentSchema.parse({
                schemaVersion: 1,
                role: file.role,
                fileName: file.fileName,
                sizeBytes: file.sizeBytes,
                sha256: file.sha256,
              }),
              file: { storageKey: stored.key, mimeType: file.mimeType },
            });
          }
          const manifest = await insertArtifact(tx, {
            id: built.manifestArtifactId,
            runId: run.id,
            stepId: step.id,
            kind: EXPORT_MANIFEST_ARTIFACT_KIND,
            content: built.manifest,
          });
          await appendRunEvent(tx, run.id, {
            type: 'pack_exported',
            payload: packExportedPayloadSchema.parse({
              stepId: step.id,
              artifactId: manifest.id,
              ...summary,
            }),
          });
          return { artifactIds: [manifest.id, ...written.map((w) => w.file.artifactId)] };
        } catch (error) {
          // The transaction rolls back, so no artifact references these files.
          await deleteFiles(deps.storage, ctx.logger, writtenObjects);
          throw error;
        }
      },
    };
  };
}
