import type { StagingFailureReason, StagingOperation, StagingOperationKind } from '@evidomo/shared';
import { APIError } from 'openai';
import type { MetaClients } from '../../meta/clients.ts';
import {
  editMetaImageToolsOff,
  ImageDecodeError,
  MetaImageEmptyError,
  MetaImageResponseError,
  type ImageContainer,
  type MetaImageSize,
} from '../../meta/images.ts';
import type { StepConfig } from '../../runs/steps.ts';
import { mapLimited } from '../vision/concurrency.ts';
import type { Meter, PhotoMediaType } from '../vision/inventory.ts';
import { encodeStagedImage, StagedImageEncodeError, type EncodedStagedImage } from './encode.ts';
import { stagingPrompt } from './operations.ts';

// The model-facing core of the staging step: one declared-operation edit per selected photo
// through the tools-off JSON edit body (P1-08), re-encoded for storage. Independent of the
// database and storage, so the replay test drives it directly and the integrity step (P3-05)
// can reuse `stagePhoto` for its one retry.

/** Edits in flight at once (~8-16 s each, P1-06). */
export const STAGING_CONCURRENCY = 3;

export interface StagingSettings {
  readonly imageModel: string;
  readonly maxStagedImages: number;
  /** Operation kinds the step may use (`operation_kinds`). */
  readonly operationKinds: ReadonlySet<StagingOperationKind>;
}

export function stagingSettings(step: StepConfig<'stager'>): StagingSettings {
  return {
    imageModel: step.image_model,
    maxStagedImages: step.max_staged_images,
    operationKinds: new Set(step.operation_kinds),
  };
}

/** One stored original, read and checked by the caller. */
export interface StagingPhoto {
  readonly materialId: string;
  readonly bytes: Uint8Array;
  readonly mediaType: PhotoMediaType;
  readonly width: number;
  readonly height: number;
}

export interface StagedImageDraft {
  readonly materialId: string;
  readonly operation: StagingOperation;
  readonly prompt: string;
  readonly requestedSize: MetaImageSize;
  readonly modelOutput: {
    readonly format: ImageContainer;
    readonly width: number;
    readonly height: number;
  };
  readonly encoded: EncodedStagedImage;
  /** `|aspect(encoded) / aspect(original) − 1|`, the integrity check's measure. */
  readonly aspectRatioChange: number;
}

export type StageOutcome =
  | { readonly ok: true; readonly value: StagedImageDraft }
  | { readonly ok: false; readonly reason: StagingFailureReason };

export interface StagingDeps {
  readonly clients: MetaClients;
  /** `ctx.ledger.meter` in the step; tests pass a pass-through. */
  readonly meter: Meter;
  readonly signal?: AbortSignal;
}

/** Client errors that describe this request's input (an image or prompt the API refuses). */
const INPUT_REJECTION_STATUSES = new Set([400, 413, 415, 422]);

/**
 * Which errors belong to one photo. A photo failure is recorded and the step goes on: the same
 * request would fail the same way on a step retry, which would re-pay every other edit.
 * Everything else (429/5xx after the SDK's retries, timeouts, abort, budget) propagates to the
 * run engine's transient/non-retryable split. A malformed response is a photo failure too: its
 * usage entry has no image count, so the ledger fails the run with `UnpricedUsageError` anyway.
 */
export function stagingFailureReason(error: unknown): StagingFailureReason | undefined {
  if (error instanceof MetaImageEmptyError) return 'no_image';
  if (
    error instanceof ImageDecodeError ||
    error instanceof StagedImageEncodeError ||
    error instanceof MetaImageResponseError
  ) {
    return 'invalid_output';
  }
  if (error instanceof APIError) {
    // `instanceof` narrows the generic class to `APIError<any>`; read the status as unknown.
    const status: unknown = error.status;
    if (typeof status === 'number' && INPUT_REJECTION_STATUSES.has(status)) {
      return 'rejected_input';
    }
  }
  return undefined;
}

/** The original's own `WxH`: Meta reads `size` as an aspect ratio only (P1-06). */
export function requestedSizeFor(photo: Pick<StagingPhoto, 'width' | 'height'>): MetaImageSize {
  return `${photo.width}x${photo.height}`;
}

export function aspectRatioChange(
  original: { readonly width: number; readonly height: number },
  edit: { readonly width: number; readonly height: number },
): number {
  return Math.abs(edit.width / edit.height / (original.width / original.height) - 1);
}

/** One metered edit of one photo. */
export function stagePhoto(
  deps: StagingDeps,
  settings: Pick<StagingSettings, 'imageModel'>,
  photo: StagingPhoto,
  operation: StagingOperation,
): Promise<StageOutcome> {
  const prompt = stagingPrompt(operation);
  const requestedSize = requestedSizeFor(photo);
  return deps.meter(settings.imageModel, async (): Promise<StageOutcome> => {
    try {
      const result = await editMetaImageToolsOff(deps.clients, {
        modelId: settings.imageModel,
        prompt,
        image: { bytes: photo.bytes, mediaType: photo.mediaType },
        size: requestedSize,
        outputFormat: 'jpeg',
        ...(deps.signal === undefined ? {} : { abortSignal: deps.signal }),
      });
      // n = 1: exactly one image or `MetaImageEmptyError`; extra images would be billed but unused.
      const [image] = result.images;
      if (image === undefined) return { ok: false, reason: 'no_image' };
      const encoded = await encodeStagedImage(image.bytes);
      return {
        ok: true,
        value: {
          materialId: photo.materialId,
          operation,
          prompt,
          requestedSize,
          modelOutput: { format: image.format, width: image.width, height: image.height },
          encoded,
          aspectRatioChange: aspectRatioChange(photo, encoded),
        },
      };
    } catch (error) {
      const reason = stagingFailureReason(error);
      if (reason === undefined) throw error;
      return { ok: false, reason };
    }
  });
}

export interface StagingJob {
  readonly photo: StagingPhoto;
  readonly operation: StagingOperation;
}

/**
 * Runs the edits with at most {@link STAGING_CONCURRENCY} in flight. After the first error that
 * is not a photo failure no new edit starts; running ones are awaited, then it is rethrown.
 */
export function runStaging(
  deps: StagingDeps,
  settings: StagingSettings,
  jobs: readonly StagingJob[],
): Promise<StageOutcome[]> {
  return mapLimited(jobs, STAGING_CONCURRENCY, (job) =>
    stagePhoto(deps, settings, job.photo, job.operation),
  );
}
