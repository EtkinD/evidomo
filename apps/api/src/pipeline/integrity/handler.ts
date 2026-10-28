import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  INTEGRITY_CHECKS_ARTIFACT_KIND,
  integrityChecksContentSchema,
  integrityCheckedPayloadSchema,
  STAGED_IMAGE_ARTIFACT_KIND,
  STAGED_IMAGES_ARTIFACT_KIND,
  stagedImageContentSchema,
  stagedImagesContentSchema,
  UPLOAD_LIMITS,
  type IntegrityAttempt,
  type IntegrityChecksContent,
  type ServiceDefinition,
  type StagedImagesContent,
} from '@evidomo/shared';
import type { Executor } from '../../db/client.ts';
import { getArtifact, insertArtifact, listArtifacts } from '../../db/repositories/artifacts.ts';
import { getProject } from '../../db/repositories/projects.ts';
import { appendRunEvent } from '../../db/repositories/run-events.ts';
import { NonRetryableStepError, type StepConfig, type StepHandler } from '../../runs/steps.ts';
import {
  newRunArtifactStorageKey,
  StorageNotFoundError,
  type Storage,
  type StoredObject,
} from '../../storage/storage.ts';
import { deleteFiles, readOriginals, stagedImageContent } from '../staging/handler.ts';
import { stagingSettings } from '../staging/stage.ts';
import { readAll } from '../vision/handler.ts';
import {
  integritySettings,
  PENDING_RETRY_ARTIFACT_ID,
  restageSameOperation,
  runIntegrityChecks,
  type IntegrityJob,
  type IntegrityPhotoResult,
  type IntegritySettings,
  type Restage,
} from './check.ts';

// The integrity step (docs/architecture.md §5, step 7): the staging step's manifest → for every
// staged photo, the original and the staged image compared on fixed elements (SAM + code), one
// retry of the same declared operation on failure, and the original only after a second failure.
// Output: one `integrity_checks` artifact naming the final staged image per photo (or none),
// the retry images as `staged_image` artifacts of this step, and an event with counts only.

export interface IntegrityHandlerDeps {
  readonly storage: Storage;
  /** The retry edit; `restageSameOperation` unless a test substitutes recorded images. */
  readonly restage?: Restage;
}

/** The run's single staging manifest; without it there is nothing to check. */
async function readStagingManifest(
  db: Executor,
  runId: string,
): Promise<{ artifactId: string; content: StagedImagesContent }> {
  const [manifest, ...others] = await listArtifacts(db, runId, {
    kind: STAGED_IMAGES_ARTIFACT_KIND,
  });
  if (manifest === undefined) {
    throw new NonRetryableStepError(
      'The integrity check needs the staging manifest, and the run has none',
    );
  }
  if (others.length > 0) {
    throw new NonRetryableStepError('The run has more than one staging manifest');
  }
  const parsed = stagedImagesContentSchema.safeParse(manifest.content);
  if (!parsed.success) throw new NonRetryableStepError('The staging manifest is not valid');
  return { artifactId: manifest.id, content: parsed.data };
}

function stagerStep(service: ServiceDefinition): StepConfig<'stager'> {
  const step = service.steps.find((candidate) => candidate.agent === 'stager');
  if (step?.agent !== 'stager') {
    throw new NonRetryableStepError('The integrity check needs a staging step in the service');
  }
  return step;
}

async function readStagedFile(storage: Storage, key: string, sha256: string): Promise<Uint8Array> {
  let stream: Readable;
  try {
    stream = await storage.get(key);
  } catch (error) {
    if (error instanceof StorageNotFoundError) {
      throw new NonRetryableStepError('A staged image file is missing', { cause: error });
    }
    throw error;
  }
  const bytes = await readAll(stream, UPLOAD_LIMITS.photoMaxBytes);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new NonRetryableStepError('A staged image does not match its recorded checksum');
  }
  return bytes;
}

/**
 * Loads every staged photo of the manifest: the `staged_image` record and file, and the original
 * re-read and checked against the record, so the comparison sees exactly the linked bytes.
 */
async function readJobs(
  deps: IntegrityHandlerDeps,
  db: Executor,
  runId: string,
  projectId: string,
  manifest: StagedImagesContent,
): Promise<IntegrityJob[]> {
  const staged = manifest.photos.flatMap((p) => (p.status === 'staged' ? [p] : []));
  if (new Set(staged.map((p) => p.materialId)).size !== staged.length) {
    throw new NonRetryableStepError('The staging manifest stages one photo twice');
  }
  const records = [];
  for (const entry of staged) {
    const artifact = await getArtifact(db, entry.stagedArtifactId);
    const content = stagedImageContentSchema.safeParse(artifact?.content);
    if (
      artifact === undefined ||
      artifact.runId !== runId ||
      artifact.kind !== STAGED_IMAGE_ARTIFACT_KIND ||
      artifact.storageKey === null ||
      !content.success ||
      content.data.original.materialId !== entry.materialId ||
      content.data.operation.id !== entry.operationId
    ) {
      throw new NonRetryableStepError('A staged image record is missing or not valid');
    }
    const bytes = await readStagedFile(
      deps.storage,
      artifact.storageKey,
      content.data.stored.sha256,
    );
    records.push({ artifactId: artifact.id, content: content.data, bytes });
  }
  const originals = await readOriginals(
    deps,
    db,
    projectId,
    records.map((r) => r.content.original),
  );
  return records.map((record, i) => {
    const original = originals[i];
    if (original === undefined) throw new Error('A staged photo original was not read');
    return {
      original,
      stagedArtifactId: record.artifactId,
      staged: record.content,
      stagedBytes: record.bytes,
    };
  });
}

/** Replaces the pending retry ID with the stored artifact's. */
function withRetryId(
  attempt: IntegrityAttempt,
  retryArtifactId: string | undefined,
): IntegrityAttempt {
  if (attempt.status === 'edit_failed' || attempt.stagedArtifactId !== PENDING_RETRY_ARTIFACT_ID) {
    return attempt;
  }
  if (retryArtifactId === undefined) throw new Error('A retry image has no artifact');
  return { ...attempt, stagedArtifactId: retryArtifactId };
}

export function integrityChecksContent(
  results: readonly IntegrityPhotoResult[],
  retryArtifactIds: ReadonlyMap<string, string>,
  settings: IntegritySettings & { stagedImagesArtifactId: string },
): IntegrityChecksContent {
  const photos = results.map((result) => {
    const attempts = result.attempts.map((a) =>
      withRetryId(a, retryArtifactIds.get(result.materialId)),
    );
    const last = attempts.at(-1);
    const finalStagedArtifactId =
      result.outcome !== 'fallback_original' && last?.status === 'checked'
        ? last.stagedArtifactId
        : null;
    return {
      materialId: result.materialId,
      operationId: result.operationId,
      original: result.original,
      attempts,
      outcome: result.outcome,
      finalStagedArtifactId,
    };
  });
  return integrityChecksContentSchema.parse({
    schemaVersion: 1,
    segmentationModel: settings.segmentationModel,
    stagedImagesArtifactId: settings.stagedImagesArtifactId,
    fixedElements: settings.elements.map((e) => ({
      phrase: e.label,
      occlusionTolerant: e.occlusionTolerant,
    })),
    thresholds: settings.thresholds,
    editPrivacyPhrases: [...settings.editPrivacyPhrases],
    counts: integrityCounts(results),
    photos,
  } satisfies IntegrityChecksContent);
}

function integrityCounts(
  results: readonly IntegrityPhotoResult[],
): IntegrityChecksContent['counts'] {
  return {
    photos: results.length,
    passed: results.filter((r) => r.outcome === 'passed').length,
    passedOnRetry: results.filter((r) => r.outcome === 'passed_on_retry').length,
    fallbackOriginal: results.filter((r) => r.outcome === 'fallback_original').length,
    retries: results.filter((r) => r.attempts.length > 1).length,
    unchecked: results.filter((r) => r.attempts.some((a) => a.status === 'unchecked')).length,
  };
}

export function createIntegrityHandler(
  deps: IntegrityHandlerDeps,
): StepHandler<'integrity_checker'> {
  const restage = deps.restage ?? restageSameOperation;
  return async (ctx) => {
    const { run, step } = ctx;
    const project = await getProject(ctx.db, run.projectId);
    if (project === undefined) throw new NonRetryableStepError('The run has no project');
    const settings = integritySettings(step);
    const staging = stagingSettings(stagerStep(ctx.service));
    const manifest = await readStagingManifest(ctx.db, run.id);
    const jobs = await readJobs(deps, ctx.db, run.id, project.id, manifest.content);

    const results =
      jobs.length === 0
        ? []
        : await runIntegrityChecks(
            {
              clients: ctx.metaClients(),
              meter: ctx.ledger.meter.bind(ctx.ledger),
              signal: ctx.signal,
              restage,
              staging,
            },
            settings,
            jobs,
          );

    // Retry images are stored whatever their verdict, so every verdict points at an image Gate 2
    // can show; only `finalStagedArtifactId` may be offered. Files are written before the
    // completion transaction and removed again if anything fails before or inside `commit`.
    const written: { result: IntegrityPhotoResult; job: IntegrityJob; stored: StoredObject }[] = [];
    try {
      for (const [i, result] of results.entries()) {
        const job = jobs[i];
        if (result.retry === undefined || job === undefined) continue;
        const stored = await deps.storage.put(
          newRunArtifactStorageKey(project.id, run.id, 'jpg'),
          result.retry.encoded.bytes,
        );
        written.push({ result, job, stored });
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

    const counts = integrityCounts(results);
    const summary = {
      photoCount: counts.photos,
      passedCount: counts.passed,
      passedOnRetryCount: counts.passedOnRetry,
      fallbackCount: counts.fallbackOriginal,
      retryCount: counts.retries,
      uncheckedCount: counts.unchecked,
    };
    if (counts.fallbackOriginal > 0) ctx.logger.warn(summary, 'some staged images fell back');
    else ctx.logger.info(summary, 'integrity check done');

    return {
      async commit(tx) {
        try {
          // Idempotency, as in staging: a repeated commit keeps the stored record and drops this
          // execution's retry files.
          const [existing] = await listArtifacts(tx, run.id, {
            kind: INTEGRITY_CHECKS_ARTIFACT_KIND,
            stepId: step.id,
          });
          if (existing !== undefined) {
            ctx.logger.warn(
              { artifactId: existing.id },
              'integrity checks already stored for this step; keeping the existing ones',
            );
            await deleteFiles(deps.storage, ctx.logger, writtenObjects);
            const retries = await listArtifacts(tx, run.id, {
              kind: STAGED_IMAGE_ARTIFACT_KIND,
              stepId: step.id,
            });
            return { artifactIds: [existing.id, ...retries.map((a) => a.id)] };
          }

          const retryArtifactIds = new Map<string, string>();
          for (const { result, job, stored } of written) {
            if (result.retry === undefined) continue;
            const artifact = await insertArtifact(tx, {
              runId: run.id,
              stepId: step.id,
              kind: STAGED_IMAGE_ARTIFACT_KIND,
              content: stagedImageContent(
                job.staged.original,
                { draft: result.retry, stored },
                staging.imageModel,
              ),
              file: { storageKey: stored.key, mimeType: 'image/jpeg' },
            });
            retryArtifactIds.set(result.materialId, artifact.id);
          }
          const report = await insertArtifact(tx, {
            runId: run.id,
            stepId: step.id,
            kind: INTEGRITY_CHECKS_ARTIFACT_KIND,
            content: integrityChecksContent(results, retryArtifactIds, {
              ...settings,
              stagedImagesArtifactId: manifest.artifactId,
            }),
          });
          await appendRunEvent(tx, run.id, {
            type: 'integrity_checked',
            payload: integrityCheckedPayloadSchema.parse({
              stepId: step.id,
              artifactId: report.id,
              ...summary,
            }),
          });
          return { artifactIds: [report.id, ...retryArtifactIds.values()] };
        } catch (error) {
          await deleteFiles(deps.storage, ctx.logger, writtenObjects);
          throw error;
        }
      },
    };
  };
}
