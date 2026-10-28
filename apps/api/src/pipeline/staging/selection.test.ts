import { describe, expect, it } from 'vitest';
import { stagingOperation, stagingPrompt } from './operations.ts';
import { operationFor, planStaging } from './selection.ts';
import { inventoryPhoto } from './testing.ts';

// Photo selection and operation choice of the staging step (pure; no model, no storage).

describe('operationFor', () => {
  it('declutters cluttered or personal interiors and furnishes the four furnishable rooms', () => {
    expect(operationFor('kitchen', ['cluttered'])?.id).toBe('declutter');
    expect(operationFor('living_room', ['personal_items'])?.id).toBe('declutter');
    expect(operationFor('living_room', [])?.id).toBe('furnish_living_room');
    expect(operationFor('dining_room', ['tilted'])?.id).toBe('furnish_dining_room');
    expect(operationFor('bedroom', [])?.id).toBe('furnish_bedroom');
    expect(operationFor('study', [])?.id).toBe('furnish_study');
  });

  it('has no operation for built-in rooms without clutter, exteriors, plans, and documents', () => {
    expect(operationFor('kitchen', [])).toBeUndefined();
    expect(operationFor('bathroom', [])).toBeUndefined();
    expect(operationFor('hallway', [])).toBeUndefined();
    expect(operationFor('garden', ['cluttered'])).toBeUndefined();
    expect(operationFor('exterior', ['cluttered'])).toBeUndefined();
    expect(operationFor('floor_plan', [])).toBeUndefined();
    expect(operationFor('document', ['cluttered'])).toBeUndefined();
  });
});

describe('stagingPrompt', () => {
  it('wraps the catalog text verbatim in the preservation instructions', () => {
    const operation = stagingOperation('declutter');
    const prompt = stagingPrompt(operation);
    expect(prompt.startsWith(`Edit this photo: ${operation.text}. Change nothing else:`)).toBe(
      true,
    );
    expect(prompt).toContain('windows, doors, radiators');
    expect(prompt).toContain('Do not add people');
  });
});

describe('planStaging', () => {
  it('stages the best-ranked eligible photos up to the cap and records every other photo', () => {
    const living = inventoryPhoto({ subject: 'living_room', coverRank: 2 });
    const bedroom = inventoryPhoto({ subject: 'bedroom', coverRank: 1 });
    const kitchen = inventoryPhoto({
      subject: 'kitchen',
      qualityIssues: ['cluttered'],
      coverRank: 3,
    });
    const study = inventoryPhoto({ subject: 'study', coverRank: 4 });
    const hallway = inventoryPhoto({ subject: 'hallway', coverRank: 5 });

    const plan = planStaging({ photos: [living, bedroom, kitchen, study, hallway] }, 3);

    expect(plan.requests.map((r) => [r.materialId, r.operation.id])).toEqual([
      [bedroom.materialId, 'furnish_bedroom'],
      [living.materialId, 'furnish_living_room'],
      [kitchen.materialId, 'declutter'],
    ]);
    expect(plan.eligibleCount).toBe(4);
    // Inventory order, one entry per photo.
    expect(
      plan.photos.map((p) =>
        p.status === 'selected' ? 'selected' : `${p.reason}:${p.operation?.id ?? '-'}`,
      ),
    ).toEqual(['selected', 'selected', 'selected', 'cap_reached:furnish_study', 'not_stageable:-']);
    expect(plan.requests[0]).toMatchObject({
      sha256: bedroom.materialSha256,
      width: 1024,
      height: 682,
    });
  });

  it('never selects a photo whose privacy check is not clear', () => {
    const plan = planStaging(
      {
        photos: [
          inventoryPhoto({ privacy: 'review', coverRank: 1 }),
          inventoryPhoto({ privacy: 'failed', coverRank: 2 }),
          inventoryPhoto({ privacy: 'masked', coverRank: 3 }),
        ],
      },
      10,
    );
    expect(plan.requests).toEqual([]);
    expect(plan.eligibleCount).toBe(0);
    expect(plan.photos.map((p) => (p.status === 'skipped' ? p.reason : p.status))).toEqual([
      'privacy_review',
      'privacy_failed',
      'privacy_masked',
    ]);
  });

  it('checks privacy before the classification, then skips failed and poor photos', () => {
    const plan = planStaging(
      {
        photos: [
          inventoryPhoto({ classificationFailed: true, privacy: 'failed' }),
          inventoryPhoto({ classificationFailed: true }),
          inventoryPhoto({ quality: 'poor' }),
        ],
      },
      10,
    );
    expect(plan.photos.map((p) => (p.status === 'skipped' ? p.reason : p.status))).toEqual([
      'privacy_failed',
      'classification_failed',
      'poor_quality',
    ]);
  });

  it('furnishes one photo per subject but declutters any number', () => {
    const first = inventoryPhoto({ subject: 'living_room', coverRank: 1 });
    const second = inventoryPhoto({ subject: 'living_room', coverRank: 2 });
    const cluttered = inventoryPhoto({
      subject: 'living_room',
      qualityIssues: ['cluttered'],
      coverRank: 3,
    });
    const clutteredToo = inventoryPhoto({
      subject: 'living_room',
      qualityIssues: ['cluttered'],
      coverRank: 4,
    });
    const plan = planStaging({ photos: [second, first, cluttered, clutteredToo] }, 10);
    expect(plan.requests.map((r) => r.materialId)).toEqual([
      first.materialId,
      cluttered.materialId,
      clutteredToo.materialId,
    ]);
    expect(plan.photos[0]).toMatchObject({
      status: 'skipped',
      reason: 'subject_already_furnished',
      operation: { id: 'furnish_living_room' },
    });
  });

  it('plans nothing when the cap is 0', () => {
    const plan = planStaging({ photos: [inventoryPhoto(), inventoryPhoto()] }, 0);
    expect(plan.requests).toEqual([]);
    expect(plan.eligibleCount).toBe(2);
    expect(plan.photos.every((p) => p.status === 'skipped' && p.reason === 'cap_reached')).toBe(
      true,
    );
  });
});
