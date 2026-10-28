import { imageRegionSchema } from '@evidomo/shared';
import { describe, expect, it } from 'vitest';
import { RegionError, toRegion, unionBox, WHOLE_IMAGE } from './regions.ts';
import {
  allocateEvidenceMasks,
  rankCovers,
  selectEvidenceRequests,
  type EvidenceCandidate,
} from './selection.ts';

const candidate = (
  photoIndex: number,
  priority: number,
  quality: EvidenceCandidate['quality'] = 'good',
): EvidenceCandidate => ({
  photoIndex,
  key: `other:o${priority}`,
  phrase: `object ${priority}`,
  priority,
  quality,
});

describe('selectEvidenceRequests', () => {
  it('covers every object once, in priority order, before a second photo of any object', () => {
    const picked = selectEvidenceRequests(
      [candidate(0, 5), candidate(1, 5), candidate(2, 5), candidate(0, 1), candidate(3, 9)],
      4,
    );
    expect(picked.map((c) => [c.priority, c.photoIndex])).toEqual([
      [1, 0],
      [5, 0],
      [9, 3],
      [5, 1],
    ]);
  });

  it('prefers better-quality photos within an object, then upload order', () => {
    const picked = selectEvidenceRequests(
      [candidate(0, 1, 'poor'), candidate(1, 1, 'acceptable'), candidate(2, 1, 'good')],
      2,
    );
    expect(picked.map((c) => c.photoIndex)).toEqual([2, 1]);
  });

  it('never exceeds the cap and handles a zero cap and no candidates', () => {
    const many = Array.from({ length: 40 }, (_, i) => candidate(i % 30, i % 7));
    expect(selectEvidenceRequests(many, 12)).toHaveLength(12);
    expect(selectEvidenceRequests(many, 0)).toEqual([]);
    expect(selectEvidenceRequests([], 12)).toEqual([]);
  });
});

describe('allocateEvidenceMasks', () => {
  it('gives every answered request its best instance first, then fills by request order', () => {
    const kept = allocateEvidenceMasks([[0.5, 0.9, 0.7], [], [0.6, 0.8]], 4);
    expect([...kept]).toEqual(['0:1', '2:1', '0:2', '0:0']);
    expect(allocateEvidenceMasks([[0.5, 0.9]], 0).size).toBe(0);
  });
});

describe('rankCovers', () => {
  it('orders by cover score, quality, issue count, then upload order', () => {
    const ranks = rankCovers([
      { photoIndex: 0, coverScore: 7, quality: 'good', issueCount: 0 },
      { photoIndex: 1, coverScore: 9, quality: 'acceptable', issueCount: 1 },
      { photoIndex: 2, coverScore: 7, quality: 'good', issueCount: 1 },
      { photoIndex: 3, coverScore: 7, quality: 'poor', issueCount: 0 },
      { photoIndex: 4, coverScore: 7, quality: 'good', issueCount: 0 },
    ]);
    expect([0, 1, 2, 3, 4].map((i) => ranks.get(i))).toEqual([2, 1, 4, 5, 3]);
  });
});

describe('regions', () => {
  it('normalizes half-open pixel boxes inward and inside the image', () => {
    expect(toRegion({ x0: 0, y0: 0, x1: 1024, y1: 682 }, 1024, 682)).toEqual(WHOLE_IMAGE);
    expect(toRegion({ x0: 512, y0: 341, x1: 768, y1: 682 }, 1024, 682)).toEqual({
      x: 0.5,
      y: 0.5,
      width: 0.25,
      height: 0.5,
    });
    // Every box on an awkward size stays valid (x + width <= 1 in floating point).
    for (let x0 = 0; x0 < 2047; x0 += 7) {
      const region = toRegion({ x0, y0: 0, x1: 2047, y1: 3 }, 2047, 1365);
      expect(imageRegionSchema.safeParse(region).success).toBe(true);
    }
    expect(() => toRegion({ x0: 0, y0: 0, x1: 1025, y1: 10 }, 1024, 682)).toThrow(RegionError);
    expect(() => toRegion({ x0: 5, y0: 0, x1: 5, y1: 10 }, 1024, 682)).toThrow(RegionError);
  });

  it('unions boxes', () => {
    expect(
      unionBox([
        { x0: 10, y0: 20, x1: 30, y1: 40 },
        { x0: 5, y0: 25, x1: 50, y1: 35 },
      ]),
    ).toEqual({ x0: 5, y0: 20, x1: 50, y1: 40 });
    expect(unionBox([])).toBeUndefined();
  });
});
