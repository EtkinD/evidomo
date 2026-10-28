// Test support for the vision inventory step, shared by the record/replay test and the
// integration test so both send exactly the requests `fixtures/meta/p2-08/vision-inventory.json`
// was recorded with. Inputs are the committed synthetic interiors (no people, plates, text, or
// third-party content; fixtures/samples/synthetic-interiors/README.md). Imported only by tests.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServiceDefinition } from '@evidomo/shared';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import type { StepConfig } from '../../runs/steps.ts';
import type { VisionPhoto } from './inventory.ts';

export const VISION_CASSETTE = 'p2-08/vision-inventory';
/**
 * Served read-only next to the vision cassette: the P1-05 SAM recordings of the same images,
 * phrases, and settings (`person` and `license plate` on three images; `window`, `door`, and
 * `radiator` on all of them). Requests they answer are neither re-sent nor re-recorded.
 */
export const VISION_INCLUDED_CASSETTES = ['p1-05/sam-privacy', 'p1-05/sam-integrity'] as const;

export const SAMPLES_DIR = path.resolve(
  import.meta.dirname,
  '../../../../../fixtures/samples/synthetic-interiors',
);

/** The six generated originals (the edits are staging outputs, not listing photos). */
export const SAMPLE_PHOTOS = [
  'living-empty',
  'living-dining-cluttered',
  'kitchen-cluttered',
  'bedroom-empty',
  'hallway',
  'dining-chairs',
] as const;
export type SamplePhoto = (typeof SAMPLE_PHOTOS)[number];

/** Fixed material IDs (they never reach a request), so assertions can name photos. */
export const SAMPLE_MATERIAL_IDS: Readonly<Record<SamplePhoto, string>> = {
  'living-empty': '0b7f2a0e-5c1d-4d6e-9a51-000000000001',
  'living-dining-cluttered': '0b7f2a0e-5c1d-4d6e-9a51-000000000002',
  'kitchen-cluttered': '0b7f2a0e-5c1d-4d6e-9a51-000000000003',
  'bedroom-empty': '0b7f2a0e-5c1d-4d6e-9a51-000000000004',
  hallway: '0b7f2a0e-5c1d-4d6e-9a51-000000000005',
  'dining-chairs': '0b7f2a0e-5c1d-4d6e-9a51-000000000006',
};

export async function readSampleBytes(name: SamplePhoto): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(SAMPLES_DIR, `${name}.jpg`)));
}

/** The samples as the handler hands them to the inventory (all 1024×682 JPEGs). */
export async function loadSamplePhotos(): Promise<VisionPhoto[]> {
  return Promise.all(
    SAMPLE_PHOTOS.map(async (name) => {
      const bytes = await readSampleBytes(name);
      return {
        materialId: SAMPLE_MATERIAL_IDS[name],
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
        mediaType: 'image/jpeg' as const,
        width: 1024,
        height: 682,
      };
    }),
  );
}

/**
 * The vision step of `listing-launch` v1 with the settings the cassette was recorded with, so
 * the fixture keeps matching if the definition's defaults change later.
 */
export function sampleVisionStep(
  registry: Pick<DefinitionRegistry, 'getService'>,
): StepConfig<'vision'> {
  const service = registry.getService('listing-launch', 1);
  const step = service.steps.find((candidate) => candidate.agent === 'vision');
  if (step?.agent !== 'vision') throw new Error('listing-launch v1 has no vision step');
  return {
    ...step,
    model: 'muse-spark-1.3',
    reasoning_effort: 'low',
    max_output_tokens: 4000,
    segmentation_model: 'sam-3.1',
    max_evidence_masks: 12,
    privacy_phrases: ['person', 'license plate'],
    classification_long_edge_px: 1024,
  };
}

/** A copy of `listing-launch` v1 that runs only the vision inventory. */
export function visionOnlyService(
  registry: Pick<DefinitionRegistry, 'getService'>,
): ServiceDefinition {
  const service = registry.getService('listing-launch', 1);
  return { ...service, id: 'vision-only', steps: [sampleVisionStep(registry)] };
}
