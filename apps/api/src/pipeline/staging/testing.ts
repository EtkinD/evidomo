// Test support for the staging step, shared by the record/replay test and the integration test
// so both send exactly the edits `fixtures/meta/p3-04/staging.json` was recorded with. Inputs
// are the committed synthetic interiors and their P2-08 inventory (no people, plates, text, or
// third-party content). Imported only by tests.
import type { InventoryPhoto, ServiceDefinition } from '@evidomo/shared';
import type { DefinitionRegistry } from '../../definitions/loader.ts';
import type { StepConfig } from '../../runs/steps.ts';
import { sampleVisionStep, VISION_CASSETTE, VISION_INCLUDED_CASSETTES } from '../vision/testing.ts';

export const STAGING_CASSETTE = 'p3-04/staging';
/** The vision inventory of the same samples replays from its own recordings, never re-sent. */
export const STAGING_INCLUDED_CASSETTES = [VISION_CASSETTE, ...VISION_INCLUDED_CASSETTES] as const;

/**
 * The staging step of `listing-launch` v1 with the settings the cassette was recorded with.
 * The replay test raises the cap to cover both operation kinds; the integration test keeps 3.
 */
export function sampleStagingStep(
  registry: Pick<DefinitionRegistry, 'getService'>,
  maxStagedImages = 3,
): StepConfig<'stager'> {
  const service = registry.getService('listing-launch', 1);
  const step = service.steps.find((candidate) => candidate.agent === 'stager');
  if (step?.agent !== 'stager') throw new Error('listing-launch v1 has no staging step');
  return { ...step, image_model: 'muse-image-1.0', max_staged_images: maxStagedImages };
}

/** A copy of `listing-launch` v1 that runs the vision inventory, then staging. */
export function visionAndStagingService(
  registry: Pick<DefinitionRegistry, 'getService'>,
  maxStagedImages = 3,
): ServiceDefinition {
  const service = registry.getService('listing-launch', 1);
  return {
    ...service,
    id: 'vision-and-staging',
    steps: [sampleVisionStep(registry), sampleStagingStep(registry, maxStagedImages)],
  };
}

let counter = 0;

/** A synthetic inventory entry for selection tests: a clear, good, classified photo. */
export function inventoryPhoto(
  overrides: {
    readonly subject?: Extract<InventoryPhoto['classification'], { status: 'ok' }>['subject'];
    readonly quality?: 'good' | 'acceptable' | 'poor';
    readonly qualityIssues?: Extract<
      InventoryPhoto['classification'],
      { status: 'ok' }
    >['qualityIssues'];
    readonly coverRank?: number;
    readonly privacy?: InventoryPhoto['privacy']['status'];
    readonly classificationFailed?: boolean;
  } = {},
): InventoryPhoto {
  counter += 1;
  const id = `0b7f2a0e-5c1d-4d6e-9a51-${String(counter).padStart(12, '0')}`;
  return {
    materialId: id,
    materialSha256: 'a'.repeat(64),
    width: 1024,
    height: 682,
    classification:
      overrides.classificationFailed === true
        ? { status: 'failed', reason: 'invalid_output' }
        : {
            status: 'ok',
            subject: overrides.subject ?? 'living_room',
            otherSubject: null,
            summary: 'A synthetic room.',
            quality: overrides.quality ?? 'good',
            qualityIssues: overrides.qualityIssues ?? [],
            coverScore: 5,
            coverRank: overrides.coverRank ?? counter,
            repairs: [],
          },
    privacy: {
      status: overrides.privacy ?? 'clear',
      phrases: [{ status: 'checked', phrase: 'person', modelSaw: false, regions: [] }],
    },
    observations: [],
  };
}
