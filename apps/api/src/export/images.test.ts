import { randomUUID } from 'node:crypto';
import {
  STAGED_IMAGE_LABEL,
  type IntegrityChecksContent,
  type IntegrityPhoto,
  type StagedImageContent,
} from '@evidomo/shared';
import { describe, expect, it } from 'vitest';
import { exportPhotoOrder, imageFileName, isPublishableStaged } from './images.ts';
import { FRAME, inventoryContent, inventoryEntry, type PrivacySpec } from './testing.ts';

// Image order and the rules that decide whether an approved staged image may be exported.

const SHA = 'a'.repeat(64);

describe('exportPhotoOrder', () => {
  it('orders by cover rank, then unclassified photos in upload order', () => {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const [a, b, c, d] = ids;
    if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error();
    const inventory = inventoryContent([
      inventoryEntry({
        materialId: a,
        sha256: SHA,
        subject: null,
        coverRank: 1,
        privacy: { status: 'clear' },
      }),
      inventoryEntry({
        materialId: b,
        sha256: SHA,
        subject: 'kitchen',
        coverRank: 2,
        privacy: { status: 'clear' },
      }),
      inventoryEntry({
        materialId: c,
        sha256: SHA,
        subject: null,
        coverRank: 1,
        privacy: { status: 'clear' },
      }),
      inventoryEntry({
        materialId: d,
        sha256: SHA,
        subject: 'bedroom',
        coverRank: 1,
        privacy: { status: 'clear' },
      }),
    ]);
    expect(exportPhotoOrder(inventory).map((o) => [o.photo.materialId, o.uploadPosition])).toEqual([
      [d, 4],
      [b, 2],
      [a, 1],
      [c, 3],
    ]);
  });
});

describe('imageFileName', () => {
  it('numbers photos with two digits and marks staged versions', () => {
    expect(imageFileName(1, 'original')).toBe('photo-01.jpg');
    expect(imageFileName(12, 'staged')).toBe('photo-12-staged.jpg');
  });
});

describe('isPublishableStaged', () => {
  const materialId = randomUUID();
  const stagedId = randomUUID();

  const photo = (privacy: PrivacySpec = { status: 'clear' }) =>
    inventoryEntry({ materialId, sha256: SHA, subject: 'living_room', coverRank: 1, privacy });

  const record: StagedImageContent = {
    schemaVersion: 1,
    promptVersion: 1,
    original: { materialId, sha256: SHA, ...FRAME },
    operation: { id: 'furnish_living_room', kind: 'furnish', text: 'Add a sofa.' },
    prompt: 'Edit: add a sofa.',
    model: 'muse-image-1.0',
    requestedSize: '1024x682',
    toolsDisabled: true,
    modelOutput: { format: 'jpeg', ...FRAME },
    stored: { mimeType: 'image/jpeg', ...FRAME, sizeBytes: 1000, sha256: 'b'.repeat(64) },
    aspectRatioChange: 0,
    disclosure: { label: STAGED_IMAGE_LABEL, visibleLabelRequired: true },
  };

  function integrity(
    overrides: {
      personCount?: number;
      phrases?: { phrase: string; count: number }[];
      final?: string | null;
    } = {},
  ): IntegrityChecksContent {
    const segmentation = { ...FRAME, segments: {} };
    const phrases = overrides.phrases ?? [{ phrase: 'person', count: overrides.personCount ?? 0 }];
    const privacyPassed = phrases.every((p) => p.count === 0);
    const entry: IntegrityPhoto = {
      materialId,
      operationId: 'furnish_living_room',
      original: segmentation,
      attempts: [
        {
          status: 'checked',
          attempt: 1,
          stagedArtifactId: stagedId,
          passed: true,
          edit: segmentation,
          verdict: {
            passed: true,
            aspectRatioChange: 0,
            failures: [],
            failedClasses: [],
            classes: [],
            thresholds: {
              minIoU: 0.75,
              minContainment: 0.85,
              minAreaRatio: 0.4,
              maxAspectRatioChange: 0.03,
            },
          },
          privacy: { passed: privacyPassed, phrases },
        },
      ],
      outcome: 'passed',
      finalStagedArtifactId: overrides.final === undefined ? stagedId : overrides.final,
    };
    return {
      schemaVersion: 1,
      segmentationModel: 'sam-3.1',
      stagedImagesArtifactId: randomUUID(),
      fixedElements: [],
      thresholds: {
        minIoU: 0.75,
        minContainment: 0.85,
        minAreaRatio: 0.4,
        maxAspectRatioChange: 0.03,
      },
      editPrivacyPhrases: phrases.map((p) => p.phrase),
      counts: {
        photos: 1,
        passed: 1,
        passedOnRetry: 0,
        fallbackOriginal: 0,
        retries: 0,
        unchecked: 0,
      },
      photos: [entry],
    };
  }

  const check = (overrides: Partial<Parameters<typeof isPublishableStaged>[0]> = {}) =>
    isPublishableStaged({
      publishedArtifactId: stagedId,
      photo: photo(),
      integrity: integrity(),
      record,
      ...overrides,
    });

  it('accepts the final, person-checked image of a clear original', () => {
    expect(check()).toBe(true);
  });

  it('withholds it when the integrity record does not confirm zero people', () => {
    expect(check({ integrity: integrity({ personCount: 1 }) })).toBe(false);
    expect(check({ integrity: integrity({ phrases: [] }) })).toBe(false);
    expect(check({ integrity: integrity({ phrases: [{ phrase: 'animal', count: 0 }] }) })).toBe(
      false,
    );
    expect(check({ integrity: null })).toBe(false);
  });

  it('withholds an image that is not the final one of its photo', () => {
    expect(check({ publishedArtifactId: randomUUID() })).toBe(false);
  });

  it('withholds it when the record does not link it to exactly the inventoried original', () => {
    expect(check({ record: null })).toBe(false);
    expect(
      check({ record: { ...record, original: { ...record.original, sha256: 'c'.repeat(64) } } }),
    ).toBe(false);
    expect(
      check({ record: { ...record, original: { ...record.original, materialId: randomUUID() } } }),
    ).toBe(false);
  });

  it('withholds it when the original is not privacy-clear', () => {
    expect(check({ photo: photo({ status: 'masked', person: [], plate: [] }) })).toBe(false);
    expect(check({ photo: photo({ status: 'review' }) })).toBe(false);
  });
});
