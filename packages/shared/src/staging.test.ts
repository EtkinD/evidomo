import { describe, expect, it } from 'vitest';
import {
  STAGED_IMAGE_LABEL,
  stagedImageContentSchema,
  stagedImagesContentSchema,
  type StagedImageContent,
} from './staging.ts';

const MATERIAL = '0b7f2a0e-5c1d-4d6e-9a51-000000000001';
const ARTIFACT = '3bfcf0bb-5581-4e10-8691-6cc7a8e66dcf';

const staged: StagedImageContent = {
  schemaVersion: 1,
  promptVersion: 1,
  original: { materialId: MATERIAL, sha256: 'a'.repeat(64), width: 1024, height: 682 },
  operation: { id: 'declutter', kind: 'declutter', text: 'remove all clutter' },
  prompt: 'Edit this photo: remove all clutter. Change nothing else.',
  model: 'muse-image-1.0',
  requestedSize: '1024x682',
  toolsDisabled: true,
  modelOutput: { format: 'jpeg', width: 1920, height: 1280 },
  stored: {
    mimeType: 'image/jpeg',
    width: 1920,
    height: 1280,
    sizeBytes: 200_000,
    sha256: 'b'.repeat(64),
  },
  aspectRatioChange: 0.001,
  disclosure: { label: STAGED_IMAGE_LABEL, visibleLabelRequired: true },
};

describe('stagedImageContentSchema', () => {
  it('requires the link to the original, the declared operation, and the visible label', () => {
    expect(stagedImageContentSchema.parse(staged)).toEqual(staged);
    expect(stagedImageContentSchema.safeParse({ ...staged, original: undefined }).success).toBe(
      false,
    );
    expect(
      stagedImageContentSchema.safeParse({
        ...staged,
        disclosure: { label: 'AI enhanced', visibleLabelRequired: true },
      }).success,
    ).toBe(false);
    expect(
      stagedImageContentSchema.safeParse({
        ...staged,
        disclosure: { ...staged.disclosure, visibleLabelRequired: false },
      }).success,
    ).toBe(false);
    expect(stagedImageContentSchema.safeParse({ ...staged, toolsDisabled: false }).success).toBe(
      false,
    );
    expect(
      stagedImageContentSchema.safeParse({
        ...staged,
        operation: { ...staged.operation, id: 'paint_walls' },
      }).success,
    ).toBe(false);
  });
});

describe('stagedImagesContentSchema', () => {
  it('records one outcome per photo with closed-set reasons', () => {
    const manifest = {
      schemaVersion: 1,
      promptVersion: 1,
      model: 'muse-image-1.0',
      maxStagedImages: 3,
      operationKinds: ['furnish'],
      inventoryArtifactId: ARTIFACT,
      counts: { photos: 3, eligible: 2, requested: 2, staged: 1, failed: 1, skipped: 1 },
      photos: [
        {
          status: 'staged',
          materialId: MATERIAL,
          operationId: 'furnish_bedroom',
          stagedArtifactId: ARTIFACT,
        },
        { status: 'failed', materialId: MATERIAL, operationId: 'declutter', reason: 'no_image' },
        { status: 'skipped', materialId: MATERIAL, operationId: null, reason: 'privacy_review' },
      ],
    };
    expect(stagedImagesContentSchema.parse(manifest)).toEqual(manifest);
    expect(
      stagedImagesContentSchema.safeParse({
        ...manifest,
        photos: [
          { status: 'skipped', materialId: MATERIAL, operationId: null, reason: 'model said so' },
        ],
      }).success,
    ).toBe(false);
  });
});
