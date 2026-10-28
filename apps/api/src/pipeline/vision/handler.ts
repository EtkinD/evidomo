import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  PHOTO_INVENTORY_ARTIFACT_KIND,
  UPLOAD_LIMITS,
  photoInventoryContentSchema,
  photoMaterialMetadataSchema,
  photosInventoriedPayloadSchema,
  type PhotoInventoryContent,
  type ServiceDefinition,
} from '@evidomo/shared';
import { insertArtifact, listArtifacts } from '../../db/repositories/artifacts.ts';
import { insertFacts, type NewFact } from '../../db/repositories/facts.ts';
import { listMaterials, type Material } from '../../db/repositories/materials.ts';
import { getProject } from '../../db/repositories/projects.ts';
import { appendRunEvent } from '../../db/repositories/run-events.ts';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import { ImageDecodeError, imageDimensions } from '../../meta/images.ts';
import { NonRetryableStepError, type StepHandler } from '../../runs/steps.ts';
import { StorageNotFoundError, type Storage } from '../../storage/storage.ts';
import {
  runVisionInventory,
  visionSettings,
  type PhotoFactDraft,
  type PhotoMediaType,
  type VisionPhoto,
} from './inventory.ts';

// Step 3, vision inventory (docs/architecture.md §5): the project's processed photos → per-photo
// subject, quality, and cover rank (Spark), privacy masks for every photo, and capped evidence
// regions (SAM) → one `photo_inventory` artifact plus `photo_region` candidate facts. Summaries
// and observations describe the property: they go into the artifact and facts (which cascade
// with the project), never into logs or events.

const MEDIA_TYPES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

export interface VisionInventoryHandlerDeps {
  readonly storage: Storage;
  readonly markets: Pick<DefinitionRegistry, 'getMarket'>;
}

/** The `images` input of the service, whose `max` bounds the photos (and the step's cost). */
function photoInputLimit(service: ServiceDefinition): number | undefined {
  const input = service.inputs.find((candidate) => candidate.type === 'images');
  return input?.type === 'images' ? input.max : undefined;
}

/**
 * The photos uploaded and processed before the run was created, in upload order, so a retry
 * cannot pick up later uploads. The service's minimum is enforced when a run is started (P4);
 * here only "at least one" and the maximum (a cost bound) are checked.
 */
export function selectPhotos(
  materials: readonly Material[],
  runCreatedAt: Date,
  max: number | undefined,
): Material[] {
  const ready = materials.filter(
    (material) =>
      material.kind === 'photo' &&
      material.status === 'ready' &&
      material.createdAt.getTime() <= runCreatedAt.getTime(),
  );
  if (ready.length === 0) {
    throw new NonRetryableStepError('The project has no processed photos to inventory');
  }
  if (max !== undefined && ready.length > max) {
    throw new NonRetryableStepError(
      `The project has ${ready.length} processed photos; the service accepts at most ${max}`,
    );
  }
  return ready;
}

async function readAll(stream: Readable, limitBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) {
      stream.destroy();
      throw new Error('Storage returned a non-binary stream for a photo');
    }
    total += chunk.byteLength;
    if (total > limitBytes) {
      stream.destroy();
      throw new NonRetryableStepError('A stored photo exceeds the photo size limit');
    }
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

/**
 * Reads one stored photo and checks it against its material row: size, checksum, and the image
 * header against the recorded dimensions. A mismatch is a storage fault no retry can fix, so it
 * fails the run (messages carry no IDs or paths).
 */
export async function readPhoto(storage: Storage, material: Material): Promise<VisionPhoto> {
  const metadata = photoMaterialMetadataSchema.safeParse(material.metadata);
  if (!metadata.success) {
    throw new NonRetryableStepError('A photo has no valid processing metadata');
  }
  if (material.sizeBytes > UPLOAD_LIMITS.photoMaxBytes) {
    throw new NonRetryableStepError('A stored photo exceeds the photo size limit');
  }
  let stream: Readable;
  try {
    stream = await storage.get(material.storageKey);
  } catch (error) {
    if (error instanceof StorageNotFoundError) {
      throw new NonRetryableStepError('A stored photo file is missing', { cause: error });
    }
    throw error;
  }
  const bytes = await readAll(stream, UPLOAD_LIMITS.photoMaxBytes);
  if (createHash('sha256').update(bytes).digest('hex') !== material.sha256) {
    throw new NonRetryableStepError('A stored photo does not match its recorded checksum');
  }
  let header: ReturnType<typeof imageDimensions>;
  try {
    header = imageDimensions(bytes);
  } catch (error) {
    if (error instanceof ImageDecodeError) {
      throw new NonRetryableStepError('A stored photo is not a readable image', { cause: error });
    }
    throw error;
  }
  if (header.width !== metadata.data.width || header.height !== metadata.data.height) {
    throw new NonRetryableStepError('A stored photo does not match its recorded dimensions');
  }
  const mediaType: PhotoMediaType = MEDIA_TYPES[header.format];
  return {
    materialId: material.id,
    sha256: material.sha256,
    bytes,
    mediaType,
    width: header.width,
    height: header.height,
  };
}

export function toPhotoFact(stepId: string, artifactId: string, draft: PhotoFactDraft): NewFact {
  return {
    stepId,
    key: draft.key,
    value: draft.value,
    unit: null,
    basis: null,
    source: {
      kind: 'photo_region',
      materialId: draft.materialId,
      region: draft.region,
      ...(draft.hasMask ? { maskArtifactId: artifactId } : {}),
    },
    assertion: 'stated',
  };
}

export function inventorySummary(content: PhotoInventoryContent) {
  return {
    photoCount: content.counts.photos,
    classifiedCount: content.counts.classified,
    classificationFailedCount: content.counts.classificationFailed,
    privacyClearCount: content.counts.privacy.clear,
    privacyMaskedCount: content.counts.privacy.masked,
    privacyReviewCount: content.counts.privacy.review,
    privacyFailedCount: content.counts.privacy.failed,
    privacyRegionCount: content.counts.privacyRegions,
    observationCount: content.counts.observations,
    evidenceRequestCount: content.evidence.requestCount,
    evidenceMaskCount: content.evidence.maskCount,
    factCount: content.counts.facts,
  };
}

export function createVisionInventoryHandler(
  deps: VisionInventoryHandlerDeps,
): StepHandler<'vision'> {
  return async (ctx) => {
    const { run, step, service } = ctx;
    const project = await getProject(ctx.db, run.projectId);
    if (project === undefined) throw new NonRetryableStepError('The run has no project');
    const market = deps.markets.getMarket(run.marketProfileId, run.marketProfileVersion);

    const materials = selectPhotos(
      await listMaterials(ctx.db, project.id, { kind: 'photo' }),
      run.createdAt,
      photoInputLimit(service),
    );
    const photos: VisionPhoto[] = [];
    for (const material of materials) photos.push(await readPhoto(deps.storage, material));

    const result = await runVisionInventory(
      { clients: ctx.metaClients(), meter: ctx.ledger.meter.bind(ctx.ledger), signal: ctx.signal },
      visionSettings(step, market),
      photos,
    );
    const content = photoInventoryContentSchema.parse(result.content);
    const summary = inventorySummary(content);
    ctx.logger.info(summary, 'photo inventory ready');

    return {
      async commit(tx) {
        // Idempotency: the engine runs commit in the completion transaction, which holds the run
        // row lock and re-checks the claim, and at most one attempt per step can complete
        // (`run_steps_one_completion_key`). The check below keeps a repeated commit from adding
        // a second inventory and fact set even if that contract changes.
        const [existing] = await listArtifacts(tx, run.id, {
          kind: PHOTO_INVENTORY_ARTIFACT_KIND,
          stepId: step.id,
        });
        if (existing !== undefined) {
          ctx.logger.warn(
            { artifactId: existing.id },
            'photo inventory already stored for this step; keeping the existing one',
          );
          return { artifactIds: [existing.id] };
        }
        const artifact = await insertArtifact(tx, {
          runId: run.id,
          stepId: step.id,
          kind: PHOTO_INVENTORY_ARTIFACT_KIND,
          content,
        });
        await insertFacts(
          tx,
          run.id,
          result.facts.map((draft) => toPhotoFact(step.id, artifact.id, draft)),
        );
        await appendRunEvent(tx, run.id, {
          type: 'photos_inventoried',
          payload: photosInventoriedPayloadSchema.parse({
            stepId: step.id,
            artifactId: artifact.id,
            ...summary,
          }),
        });
        return { artifactIds: [artifact.id] };
      },
    };
  };
}
