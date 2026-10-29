import { describe, expect, it } from 'vitest';
import {
  FURNISHING_NOT_APPLICABLE_SUBJECTS,
  PHOTO_SUBJECTS,
  photoInventoryContentSchema,
  type PhotoInventoryContent,
} from './vision.ts';

const MATERIAL = '0b7f2a0e-5c1d-4d6e-9a51-000000000001';

const classification = {
  status: 'ok' as const,
  subject: 'bedroom' as const,
  otherSubject: null,
  furnishing: 'empty' as const,
  summary: 'An empty bedroom with a carpet.',
  quality: 'good' as const,
  qualityIssues: [],
  coverScore: 6,
  coverRank: 1,
  repairs: [],
};

function content(photoClassification: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    promptVersion: 2,
    model: 'muse-spark-1.3',
    reasoningEffort: 'low',
    maxOutputTokens: 4000,
    segmentationModel: 'sam-3.1',
    privacyPhrases: ['person'],
    evidence: { cap: 12, candidateCount: 0, requestCount: 0, regionCount: 0, maskCount: 0 },
    counts: {
      photos: 1,
      classified: 1,
      classificationFailed: 0,
      privacy: { clear: 1, masked: 0, review: 0, failed: 0 },
      privacyRegions: 0,
      observations: 0,
      facts: 0,
      rejectedObservations: 0,
    },
    photos: [
      {
        materialId: MATERIAL,
        materialSha256: 'a'.repeat(64),
        width: 1024,
        height: 682,
        classification: photoClassification,
        privacy: {
          status: 'clear',
          phrases: [{ status: 'checked', phrase: 'person', modelSaw: false, regions: [] }],
        },
        observations: [],
      },
    ],
    rejected: [],
  };
}

function furnishingOf(parsed: PhotoInventoryContent): unknown {
  const photo = parsed.photos[0];
  return photo?.classification.status === 'ok' ? photo.classification.furnishing : 'n/a';
}

describe('photoInventoryContentSchema furnishing', () => {
  it('keeps each furnishing state and null', () => {
    for (const furnishing of ['empty', 'partly', 'furnished', null]) {
      const parsed = photoInventoryContentSchema.parse(content({ ...classification, furnishing }));
      expect(furnishingOf(parsed)).toBe(furnishing);
    }
  });

  it('reads an inventory stored before the field existed as unknown (null), never empty', () => {
    const { furnishing: _omitted, ...withoutField } = classification;
    const parsed = photoInventoryContentSchema.parse({
      ...content(withoutField),
      promptVersion: 1,
    });
    expect(furnishingOf(parsed)).toBeNull();
  });

  it('rejects a furnishing value outside the closed set', () => {
    expect(
      photoInventoryContentSchema.safeParse(content({ ...classification, furnishing: 'bare' }))
        .success,
    ).toBe(false);
  });

  it('marks only non-room subjects as not applicable', () => {
    expect([...FURNISHING_NOT_APPLICABLE_SUBJECTS].sort()).toEqual(
      ['balcony', 'document', 'exterior', 'floor_plan', 'garden', 'terrace', 'view'].sort(),
    );
    for (const subject of FURNISHING_NOT_APPLICABLE_SUBJECTS) {
      expect(PHOTO_SUBJECTS).toContain(subject);
    }
  });
});
