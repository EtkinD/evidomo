import type { EvidenceObject } from '@evidomo/shared';
import { describe, expect, it } from 'vitest';
import { ClassificationValueError, normalizeClassification, toSlug } from './normalize.ts';
import type { RawPhotoClassification } from './schema.ts';
import { VISION_LIMITS } from './schema.ts';

const OBJECTS: EvidenceObject[] = [
  { id: 'balcony', label: 'Balcony (balkon)', phrase: 'balcony', supports: [] },
  { id: 'energy_label', label: 'Energy label', phrase: 'energy label', supports: ['energy_label'] },
];
const PRIVACY = ['person', 'license plate'];

function raw(overrides: Partial<RawPhotoClassification> = {}): RawPhotoClassification {
  return {
    subject: 'living_room',
    otherSubject: null,
    furnishing: 'furnished',
    summary: 'A bright living room.',
    quality: 'good',
    qualityIssues: [],
    coverScore: 8,
    observations: [],
    privacySubjects: [],
    ...overrides,
  };
}

const obs = (object: string, count = 1, otherObject: string | null = null, detail = 'x') => ({
  object,
  otherObject,
  count,
  detail,
});

describe('normalizeClassification', () => {
  it('maps configured objects to other:<id> keys with their label, phrase, priority, and supports', () => {
    const result = normalizeClassification(
      raw({ observations: [obs('energy_label', 1, null, 'sticker on the meter cupboard')] }),
      OBJECTS,
      PRIVACY,
    );
    expect(result.observations).toEqual([
      {
        key: 'other:energy_label',
        object: 'energy_label',
        label: 'Energy label',
        detail: 'sticker on the meter cupboard',
        modelCount: 1,
        supports: ['energy_label'],
        phrase: 'energy label',
        priority: 1,
      },
    ]);
    expect(result.repairs).toEqual([]);
  });

  it('slugs other objects, promotes a slug that names a configured object, and rejects bad names', () => {
    const result = normalizeClassification(
      raw({
        observations: [
          obs('other', 1, 'Built-in Wardrobe'),
          obs('other', 1, 'Balcony'),
          obs('other', 1, '!!!'),
          obs('other', 1, null),
          obs('sauna', 1),
        ],
      }),
      OBJECTS,
      PRIVACY,
    );
    expect(result.observations.map((o) => [o.key, o.object, o.phrase])).toEqual([
      ['other:built_in_wardrobe', 'other', null],
      ['other:balcony', 'balcony', 'balcony'],
    ]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'invalid_other_name',
      'invalid_other_name',
      'invalid_other_name',
    ]);
  });

  it('rounds and clamps counts and the cover score, rejecting zero counts and duplicates', () => {
    const result = normalizeClassification(
      raw({
        coverScore: 14.4,
        observations: [obs('balcony', 1.6), obs('balcony', 1), obs('other', 0, 'skylight')],
      }),
      OBJECTS,
      PRIVACY,
    );
    expect(result.coverScore).toBe(10);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.modelCount).toBe(2);
    expect(result.rejected.map((r) => r.reason)).toEqual(['duplicate', 'invalid_count']);
    expect(result.repairs).toEqual(['cover_score', 'observation_count']);
  });

  it('keeps at most the per-photo observation limit', () => {
    const many = Array.from({ length: VISION_LIMITS.maxObservationsPerPhoto + 2 }, (_, i) =>
      obs('other', 1, `feature_${i}`),
    );
    const result = normalizeClassification(raw({ observations: many }), OBJECTS, PRIVACY);
    expect(result.observations).toHaveLength(VISION_LIMITS.maxObservationsPerPhoto);
    expect(result.rejected.map((r) => r.reason)).toEqual(['too_many', 'too_many']);
  });

  it('drops otherSubject unless the subject is other, and fills an empty summary', () => {
    const result = normalizeClassification(
      raw({ otherSubject: 'sunroom', summary: '  ' }),
      OBJECTS,
      PRIVACY,
    );
    expect(result.otherSubject).toBeNull();
    expect(result.summary).toBe('Living room');
    expect(result.repairs).toEqual(['other_subject', 'summary']);
    expect(
      normalizeClassification(
        raw({ subject: 'other', otherSubject: ' Sunroom ' }),
        OBJECTS,
        PRIVACY,
      ).otherSubject,
    ).toBe('Sunroom');
  });

  it('keeps the furnishing state of interior rooms, including other subjects', () => {
    for (const state of ['empty', 'partly', 'furnished'] as const) {
      const result = normalizeClassification(raw({ furnishing: state }), OBJECTS, PRIVACY);
      expect(result.furnishing).toBe(state);
      expect(result.repairs).toEqual([]);
    }
    expect(
      normalizeClassification(
        raw({ subject: 'other', otherSubject: 'Lower-level room', furnishing: 'empty' }),
        OBJECTS,
        PRIVACY,
      ).furnishing,
    ).toBe('empty');
  });

  it('stores furnishing as unknown when it is absent, invalid, or not applicable', () => {
    const none = normalizeClassification(raw({ furnishing: null }), OBJECTS, PRIVACY);
    expect(none.furnishing).toBeNull();
    expect(none.repairs).toEqual([]);

    // Never mapped to `empty`, and the photo still classifies.
    const invalid = normalizeClassification(raw({ furnishing: 'bare' }), OBJECTS, PRIVACY);
    expect(invalid.furnishing).toBeNull();
    expect(invalid.repairs).toEqual(['furnishing']);

    for (const subject of ['exterior', 'garden', 'balcony', 'floor_plan', 'document', 'view']) {
      const result = normalizeClassification(
        raw({ subject, furnishing: 'empty' }),
        OBJECTS,
        PRIVACY,
      );
      expect(result.furnishing).toBeNull();
      expect(result.repairs).toEqual(['furnishing']);
    }
  });

  it('keeps only configured privacy phrases and known quality issues', () => {
    const result = normalizeClassification(
      raw({ privacySubjects: ['person', 'pet', 'person'], qualityIssues: ['blurry', 'grainy'] }),
      OBJECTS,
      PRIVACY,
    );
    expect([...result.privacySubjects]).toEqual(['person']);
    expect(result.qualityIssues).toEqual(['blurry']);
    expect(result.repairs).toContain('quality_issues');
  });

  it('rejects values outside the closed sets and a non-numeric cover score', () => {
    expect(() =>
      normalizeClassification(raw({ subject: 'garage_sale' }), OBJECTS, PRIVACY),
    ).toThrow(ClassificationValueError);
    expect(() => normalizeClassification(raw({ quality: 'great' }), OBJECTS, PRIVACY)).toThrow(
      ClassificationValueError,
    );
    expect(() =>
      normalizeClassification(raw({ coverScore: Number.NaN }), OBJECTS, PRIVACY),
    ).toThrow(ClassificationValueError);
  });
});

describe('toSlug', () => {
  it('produces fact-key slugs or nothing', () => {
    expect(toSlug('Wooden floor')).toBe('wooden_floor');
    expect(toSlug('  open-plan kitchen ')).toBe('open_plan_kitchen');
    expect(toSlug('2nd floor')).toBeUndefined();
    expect(toSlug('')).toBeUndefined();
  });
});
