// Test support for the integrity step, shared by the record/replay test, the unit tests, and the
// integration test so all of them send exactly the requests `fixtures/meta/p3-05/integrity.json`
// (and the P1-05 / P3-04 cassettes it includes) were recorded with. Inputs are the committed
// synthetic interiors and the recorded P3-04 edits of them (no people, plates, text, or
// third-party content). Imported only by tests.
//
// Why the staged images here are always committed files, never our re-encode: a SAM request is
// matched by the SHA-256 of its body, which contains the image. `encodeStagedImage` (sharp,
// mozjpeg) is not guaranteed to produce identical bytes on arm64 (development) and x86-64 (CI),
// so a cassette keyed on its output could stop matching in CI.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { StagedImageContent, StagingOperationId } from '@evidomo/shared';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import { imageDimensions } from '../../meta/images.ts';
import type { StepConfig } from '../../runs/steps.ts';
import { stagedImageContent } from '../staging/handler.ts';
import { stagingOperation, stagingPrompt } from '../staging/operations.ts';
import {
  aspectRatioChange,
  requestedSizeFor,
  type StagedImageDraft,
  type StagingPhoto,
} from '../staging/stage.ts';

export const INTEGRITY_CASSETTE = 'p3-05/integrity';
/**
 * Served read-only: SAM `window`/`door`/`radiator` on all twelve synthetic images (P1-05) and
 * the five recorded staging edits (P3-04). Only what they lack is recorded under P3-05.
 */
export const INTEGRITY_INCLUDED_CASSETTES = ['p1-05/sam-integrity', 'p3-04/staging'] as const;

export const SAMPLES_DIR = path.resolve(
  import.meta.dirname,
  '../../../../../fixtures/samples/synthetic-interiors',
);

/** Fixed material IDs per original (they never reach a request). */
export const ORIGINAL_IDS = {
  'living-empty': '0b7f2a0e-5c1d-4d6e-9a51-000000000001',
  'living-dining-cluttered': '0b7f2a0e-5c1d-4d6e-9a51-000000000002',
  'kitchen-cluttered': '0b7f2a0e-5c1d-4d6e-9a51-000000000003',
  'bedroom-empty': '0b7f2a0e-5c1d-4d6e-9a51-000000000004',
  hallway: '0b7f2a0e-5c1d-4d6e-9a51-000000000005',
  'dining-chairs': '0b7f2a0e-5c1d-4d6e-9a51-000000000006',
} as const;
export type SampleOriginal = keyof typeof ORIGINAL_IDS;

/** The P1-06 edits of the originals (P1-07's six pairs); the last one removes the window. */
export const SAMPLE_EDITS = {
  'living-empty.edit-add-sofa': 'living-empty',
  'living-empty.edit-remove-window': 'living-empty',
  'living-dining-cluttered.edit-declutter-table': 'living-dining-cluttered',
  'bedroom-empty.edit-add-bed': 'bedroom-empty',
  'hallway.edit-add-rug-plant': 'hallway',
  'dining-chairs.edit-replace-chairs': 'dining-chairs',
} as const satisfies Record<string, SampleOriginal>;
export type SampleEdit = keyof typeof SAMPLE_EDITS;

/** The P3-04 recorded edits, in the order of `staging.test.ts`. */
export const RECORDED_STAGING_EDITS = [
  ['living-empty', 'furnish_living_room'],
  ['dining-chairs', 'furnish_dining_room'],
  ['bedroom-empty', 'furnish_bedroom'],
  ['living-dining-cluttered', 'declutter'],
  ['kitchen-cluttered', 'declutter'],
] as const satisfies readonly (readonly [SampleOriginal, StagingOperationId])[];

export async function readSampleImage(name: SampleOriginal | SampleEdit): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(SAMPLES_DIR, `${name}.jpg`)));
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** An original as the handler hands it to the check. */
export async function sampleOriginal(name: SampleOriginal): Promise<StagingPhoto> {
  const bytes = await readSampleImage(name);
  const { width, height } = imageDimensions(bytes);
  return { materialId: ORIGINAL_IDS[name], bytes, mediaType: 'image/jpeg', width, height };
}

/**
 * A staging draft whose stored bytes are a committed image, as if `stagePhoto` had produced
 * it: lets tests and the integration test stand in for an edit without our re-encode.
 */
export function draftFromImage(
  original: Pick<StagingPhoto, 'materialId' | 'width' | 'height'>,
  operationId: StagingOperationId,
  bytes: Uint8Array,
): StagedImageDraft {
  const operation = stagingOperation(operationId);
  const { format, width, height } = imageDimensions(bytes);
  return {
    materialId: original.materialId,
    operation,
    prompt: stagingPrompt(operation),
    requestedSize: requestedSizeFor(original),
    modelOutput: { format, width, height },
    encoded: { bytes, width, height },
    aspectRatioChange: aspectRatioChange(original, { width, height }),
  };
}

/**
 * The integrity step of `listing-launch` v1 with the settings the cassette was recorded with,
 * so the fixtures keep matching if the definition's values change later.
 */
export function sampleIntegrityStep(
  registry: Pick<DefinitionRegistry, 'getService'>,
): StepConfig<'integrity_checker'> {
  const service = registry.getService('listing-launch', 1);
  const step = service.steps.find((candidate) => candidate.agent === 'integrity_checker');
  if (step?.agent !== 'integrity_checker') throw new Error('listing-launch v1 has no integrity');
  return {
    ...step,
    segmentation_model: 'sam-3.1',
    fixed_elements: [
      { phrase: 'window', occlusion_tolerant: false },
      { phrase: 'door', occlusion_tolerant: true },
      { phrase: 'radiator', occlusion_tolerant: true },
    ],
    min_iou: 0.75,
    min_containment: 0.85,
    min_area_ratio: 0.4,
    max_aspect_ratio_change: 0.03,
    edit_privacy_phrases: ['person'],
  };
}

/** The `staged_image` record of a draft, as the staging step would store it. */
export function stagedContentFor(
  original: Pick<StagingPhoto, 'materialId' | 'width' | 'height'> & { readonly sha256: string },
  draft: StagedImageDraft,
  model = 'muse-image-1.0',
): StagedImageContent {
  const bytes = draft.encoded.bytes;
  return stagedImageContent(
    original,
    {
      draft,
      stored: {
        key: 'projects/test/staged.jpg',
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
      },
    },
    model,
  );
}
