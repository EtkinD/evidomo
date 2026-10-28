import {
  imagesStagedPayloadSchema,
  PHOTO_INVENTORY_ARTIFACT_KIND,
  photoInventoryContentSchema,
  STAGED_IMAGE_ARTIFACT_KIND,
  STAGED_IMAGE_LABEL,
  STAGED_IMAGES_ARTIFACT_KIND,
  STAGING_OPERATION_KINDS,
  stagedImageContentSchema,
  stagedImagesContentSchema,
  type PhotoInventoryContent,
  type StagedImageContent,
  type StagedImagesContent,
  type StagingOperationKind,
  type StagingPhotoOutcome,
} from '@evidomo/shared';
import type { Executor } from '../../db/client.ts';
import { insertArtifact, listArtifacts } from '../../db/repositories/artifacts.ts';
import { listMaterials } from '../../db/repositories/materials.ts';
import { getProject } from '../../db/repositories/projects.ts';
import { appendRunEvent } from '../../db/repositories/run-events.ts';
import type { Logger } from '../../logger.ts';
import { NonRetryableStepError, type StepHandler } from '../../runs/steps.ts';
import {
  newRunArtifactStorageKey,
  type Storage,
  type StoredObject,
} from '../../storage/storage.ts';
import { readPhoto } from '../vision/handler.ts';
import { STAGING_PROMPT_VERSION } from './operations.ts';
import { planStaging, type StagingPlan, type StagingRequestPlan } from './selection.ts';
import {
  runStaging,
  stagingSettings,
  type StagedImageDraft,
  type StageOutcome,
  type StagingJob,
  type StagingPhoto,
} from './stage.ts';

// The staging step (docs/architecture.md §5): the run's photo inventory → declared-operation
// edits of the best-ranked stageable photos → one `staged_image` artifact per staged photo (the
// JPEG plus its link to the original and the operation) and one `staged_images` artifact with an
// outcome for every photo. Operations and prompts are catalog text; events carry counts only.

export interface StagingHandlerDeps {
  readonly storage: Storage;
}

const PRIVACY_SKIPS = new Set(['privacy_masked', 'privacy_review', 'privacy_failed']);

/** The run's single photo inventory; staging cannot select photos without it. */
export async function readInventory(
  db: Executor,
  runId: string,
): Promise<{ artifactId: string; content: PhotoInventoryContent }> {
  const [inventory, ...others] = await listArtifacts(db, runId, {
    kind: PHOTO_INVENTORY_ARTIFACT_KIND,
  });
  if (inventory === undefined) {
    throw new NonRetryableStepError('Staging needs the photo inventory, and the run has none');
  }
  if (others.length > 0) {
    throw new NonRetryableStepError('The run has more than one photo inventory');
  }
  const parsed = photoInventoryContentSchema.safeParse(inventory.content);
  if (!parsed.success) throw new NonRetryableStepError('The photo inventory is not valid');
  return { artifactId: inventory.id, content: parsed.data };
}

/**
 * Reads the selected originals and checks that each is still exactly the inventoried photo, so a
 * staged image is always linked to the bytes the privacy check and selection saw.
 */
export async function readOriginals(
  deps: StagingHandlerDeps,
  db: Executor,
  projectId: string,
  requests: readonly Pick<StagingRequestPlan, 'materialId' | 'sha256' | 'width' | 'height'>[],
): Promise<StagingPhoto[]> {
  if (requests.length === 0) return [];
  const materials = await listMaterials(db, projectId, { kind: 'photo' });
  const photos: StagingPhoto[] = [];
  for (const request of requests) {
    const material = materials.find((m) => m.id === request.materialId);
    if (material === undefined || material.status !== 'ready') {
      throw new NonRetryableStepError('An inventoried photo is no longer available');
    }
    const photo = await readPhoto(deps.storage, material);
    if (
      photo.sha256 !== request.sha256 ||
      photo.width !== request.width ||
      photo.height !== request.height
    ) {
      throw new NonRetryableStepError('A photo changed after it was inventoried');
    }
    photos.push(photo);
  }
  return photos;
}

export interface StoredStagedImage {
  readonly draft: StagedImageDraft;
  readonly stored: StoredObject;
}

/** Deletes files no artifact will reference. Failures are logged: the step's outcome stands. */
export async function deleteFiles(
  storage: Storage,
  logger: Logger,
  objects: readonly StoredObject[],
): Promise<void> {
  for (const object of objects) {
    try {
      await storage.delete(object.key);
    } catch (error) {
      logger.error({ err: error, storageKey: object.key }, 'could not delete a staged image file');
    }
  }
}

export function stagedImageContent(
  request: Pick<StagingRequestPlan, 'materialId' | 'sha256' | 'width' | 'height'>,
  item: StoredStagedImage,
  model: string,
): StagedImageContent {
  const { draft, stored } = item;
  return stagedImageContentSchema.parse({
    schemaVersion: 1,
    promptVersion: STAGING_PROMPT_VERSION,
    original: {
      materialId: request.materialId,
      sha256: request.sha256,
      width: request.width,
      height: request.height,
    },
    operation: draft.operation,
    prompt: draft.prompt,
    model,
    requestedSize: draft.requestedSize,
    toolsDisabled: true,
    modelOutput: draft.modelOutput,
    stored: {
      mimeType: 'image/jpeg',
      width: draft.encoded.width,
      height: draft.encoded.height,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
    },
    aspectRatioChange: draft.aspectRatioChange,
    disclosure: { label: STAGED_IMAGE_LABEL, visibleLabelRequired: true },
  } satisfies StagedImageContent);
}

/** Outcomes per photo in inventory order; `stagedArtifactIds` maps material → artifact. */
export function stagingManifest(
  plan: StagingPlan,
  outcomes: ReadonlyMap<string, StageOutcome>,
  stagedArtifactIds: ReadonlyMap<string, string>,
  settings: {
    model: string;
    maxStagedImages: number;
    operationKinds: ReadonlySet<StagingOperationKind>;
    inventoryArtifactId: string;
  },
): StagedImagesContent {
  const photos = plan.photos.map((planned): StagingPhotoOutcome => {
    if (planned.status === 'skipped') {
      return {
        status: 'skipped',
        materialId: planned.materialId,
        operationId: planned.operation?.id ?? null,
        reason: planned.reason,
      };
    }
    const { materialId, operation } = planned.request;
    const outcome = outcomes.get(materialId);
    if (outcome === undefined) throw new Error('stagingManifest: a selected photo has no outcome');
    if (!outcome.ok) {
      return { status: 'failed', materialId, operationId: operation.id, reason: outcome.reason };
    }
    const stagedArtifactId = stagedArtifactIds.get(materialId);
    if (stagedArtifactId === undefined) {
      throw new Error('stagingManifest: a staged photo has no artifact');
    }
    return { status: 'staged', materialId, operationId: operation.id, stagedArtifactId };
  });
  return stagedImagesContentSchema.parse({
    schemaVersion: 1,
    promptVersion: STAGING_PROMPT_VERSION,
    model: settings.model,
    maxStagedImages: settings.maxStagedImages,
    // Catalog order, so the manifest does not depend on the definition's list order.
    operationKinds: STAGING_OPERATION_KINDS.filter((kind) => settings.operationKinds.has(kind)),
    inventoryArtifactId: settings.inventoryArtifactId,
    counts: {
      photos: photos.length,
      eligible: plan.eligibleCount,
      requested: plan.requests.length,
      staged: photos.filter((p) => p.status === 'staged').length,
      failed: photos.filter((p) => p.status === 'failed').length,
      skipped: photos.filter((p) => p.status === 'skipped').length,
    },
    photos,
  } satisfies StagedImagesContent);
}

export function createStagingHandler(deps: StagingHandlerDeps): StepHandler<'stager'> {
  return async (ctx) => {
    const { run, step } = ctx;
    const project = await getProject(ctx.db, run.projectId);
    if (project === undefined) throw new NonRetryableStepError('The run has no project');
    const settings = stagingSettings(step);
    const inventory = await readInventory(ctx.db, run.id);
    const plan = planStaging(inventory.content, settings.maxStagedImages, settings.operationKinds);

    const originals = await readOriginals(deps, ctx.db, project.id, plan.requests);
    const jobs: StagingJob[] = plan.requests.map((request, i) => {
      const photo = originals[i];
      if (photo === undefined) throw new Error('A selected photo was not read');
      return { photo, operation: request.operation };
    });
    const results =
      jobs.length === 0
        ? []
        : await runStaging(
            {
              clients: ctx.metaClients(),
              meter: ctx.ledger.meter.bind(ctx.ledger),
              signal: ctx.signal,
            },
            settings,
            jobs,
          );

    const outcomes = new Map<string, StageOutcome>();
    plan.requests.forEach((request, i) => {
      const result = results[i];
      if (result === undefined) throw new Error('An edit has no outcome');
      outcomes.set(request.materialId, result);
    });

    // Files are written before the completion transaction (storage is not transactional).
    // Anything that fails from here on removes them again, so no unreferenced copy of a
    // customer-derived image is left behind.
    const written: { request: StagingRequestPlan; item: StoredStagedImage }[] = [];
    try {
      for (const request of plan.requests) {
        const outcome = outcomes.get(request.materialId);
        if (outcome?.ok !== true) continue;
        const stored = await deps.storage.put(
          newRunArtifactStorageKey(project.id, run.id, 'jpg'),
          outcome.value.encoded.bytes,
        );
        written.push({ request, item: { draft: outcome.value, stored } });
      }
    } catch (error) {
      await deleteFiles(
        deps.storage,
        ctx.logger,
        written.map((w) => w.item.stored),
      );
      throw error;
    }
    const writtenObjects = written.map((w) => w.item.stored);

    const failedCount = [...outcomes.values()].filter((o) => !o.ok).length;
    const summary = {
      cap: settings.maxStagedImages,
      photoCount: plan.photos.length,
      eligibleCount: plan.eligibleCount,
      requestedCount: plan.requests.length,
      stagedCount: written.length,
      failedCount,
      skippedCount: plan.photos.filter((p) => p.status === 'skipped').length,
      privacySkippedCount: plan.photos.filter(
        (p) => p.status === 'skipped' && PRIVACY_SKIPS.has(p.reason),
      ).length,
    };
    if (failedCount > 0) ctx.logger.warn(summary, 'some staging edits failed');
    else ctx.logger.info(summary, 'staging done');

    return {
      async commit(tx) {
        try {
          // Idempotency, as in vision: commit runs inside the engine's completion transaction
          // (run row locked, claim re-checked, one completed attempt per step). A repeated
          // commit keeps the stored set and drops this execution's files.
          const [existing] = await listArtifacts(tx, run.id, {
            kind: STAGED_IMAGES_ARTIFACT_KIND,
            stepId: step.id,
          });
          if (existing !== undefined) {
            ctx.logger.warn(
              { artifactId: existing.id },
              'staged images already stored for this step; keeping the existing ones',
            );
            await deleteFiles(deps.storage, ctx.logger, writtenObjects);
            const staged = await listArtifacts(tx, run.id, {
              kind: STAGED_IMAGE_ARTIFACT_KIND,
              stepId: step.id,
            });
            return { artifactIds: [existing.id, ...staged.map((a) => a.id)] };
          }

          const stagedArtifactIds = new Map<string, string>();
          for (const { request, item } of written) {
            const artifact = await insertArtifact(tx, {
              runId: run.id,
              stepId: step.id,
              kind: STAGED_IMAGE_ARTIFACT_KIND,
              content: stagedImageContent(request, item, settings.imageModel),
              file: { storageKey: item.stored.key, mimeType: 'image/jpeg' },
            });
            stagedArtifactIds.set(request.materialId, artifact.id);
          }
          const manifest = await insertArtifact(tx, {
            runId: run.id,
            stepId: step.id,
            kind: STAGED_IMAGES_ARTIFACT_KIND,
            content: stagingManifest(plan, outcomes, stagedArtifactIds, {
              model: settings.imageModel,
              maxStagedImages: settings.maxStagedImages,
              operationKinds: settings.operationKinds,
              inventoryArtifactId: inventory.artifactId,
            }),
          });
          await appendRunEvent(tx, run.id, {
            type: 'images_staged',
            payload: imagesStagedPayloadSchema.parse({
              stepId: step.id,
              artifactId: manifest.id,
              ...summary,
            }),
          });
          return { artifactIds: [manifest.id, ...stagedArtifactIds.values()] };
        } catch (error) {
          // The transaction rolls back, so no artifact references these files.
          await deleteFiles(deps.storage, ctx.logger, writtenObjects);
          throw error;
        }
      },
    };
  };
}
