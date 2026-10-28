import { describe, expect, it } from 'vitest';
import type { SamBox } from '../../meta/sam-output.ts';
import {
  compareFixedElements,
  DEFAULT_INTEGRITY_THRESHOLDS,
  IntegrityInputError,
  type IntegrityImage,
} from './compare.ts';

// Hand-built cases. The recorded SAM pairs are in `recorded-pairs.test.ts`.

const box = (x0: number, y0: number, x1: number, y1: number): { box: SamBox } => ({
  box: { x0, y0, x1, y1 },
});

const WINDOW = box(300, 100, 600, 400);
const DOOR = box(800, 150, 950, 650);
const RADIATOR = box(320, 420, 580, 500);

function image(
  segments: Partial<Record<'window' | 'door' | 'radiator', { box: SamBox }[]>> = {},
  width = 1536,
  height = 1024,
): IntegrityImage {
  return {
    width,
    height,
    segments: {
      window: [WINDOW],
      door: [DOOR],
      radiator: [RADIATOR],
      ...segments,
    },
  };
}

function shiftX({ box: b }: { box: SamBox }, fraction: number): { box: SamBox } {
  const dx = Math.round((b.x1 - b.x0) * fraction);
  return box(b.x0 + dx, b.y0, b.x1 + dx, b.y1);
}

function scale({ box: b }: { box: SamBox }, sx: number, sy: number): { box: SamBox } {
  return box(b.x0 * sx, b.y0 * sy, b.x1 * sx, b.y1 * sy);
}

function classReport(verdict: ReturnType<typeof compareFixedElements>, label: string) {
  const report = verdict.classes.find((c) => c.label === label);
  if (report === undefined) throw new Error(`no report for ${label}`);
  return report;
}

describe('compareFixedElements', () => {
  it('passes an unchanged image with IoU 1 for every class', () => {
    const verdict = compareFixedElements(image(), image());
    expect(verdict.passed).toBe(true);
    expect(verdict.failures).toEqual([]);
    expect(verdict.failedClasses).toEqual([]);
    expect(verdict.thresholds).toEqual(DEFAULT_INTEGRITY_THRESHOLDS);
    for (const report of verdict.classes) {
      expect(report).toMatchObject({ countDelta: 0, worstMatchedIoU: 1, failures: [] });
      expect(report.matches[0]?.rule).toBe('iou');
    }
  });

  it('compares in a common frame when the edit comes back at another resolution', () => {
    // Muse Image renders 1.25x the requested size (P1-06).
    const edit = image(
      {
        window: [scale(WINDOW, 1.25, 1.25)],
        door: [scale(DOOR, 1.25, 1.25)],
        radiator: [scale(RADIATOR, 1.25, 1.25)],
      },
      1920,
      1280,
    );
    const verdict = compareFixedElements(image(), edit);
    expect(verdict.passed).toBe(true);
    expect(verdict.aspectRatioChange).toBe(0);
    for (const report of verdict.classes) expect(report.worstMatchedIoU).toBeCloseTo(1, 10);
  });

  it('accepts the small aspect change measured without `size` and stretches to compare', () => {
    // 1024x682 → 1024x672 (the hallway edit): 1.49% change, content stretched vertically.
    const sy = 672 / 682;
    const original = image({}, 1024, 682);
    const edit = image(
      {
        window: [box(300, Math.round(100 * sy), 600, Math.round(400 * sy))],
        door: [box(800, Math.round(150 * sy), 950, Math.round(650 * sy))],
        radiator: [box(320, Math.round(420 * sy), 580, Math.round(500 * sy))],
      },
      1024,
      672,
    );
    const verdict = compareFixedElements(original, edit);
    expect(verdict.aspectRatioChange).toBeCloseTo(682 / 672 - 1, 10);
    expect(verdict.passed).toBe(true);
    for (const report of verdict.classes) {
      expect(report.worstMatchedIoU).toBeGreaterThan(0.97);
    }
  });

  it('fails an aspect-ratio change above the tolerance even when every element matches', () => {
    const verdict = compareFixedElements(image(), image({}, 1536, 1536));
    expect(verdict.failures).toEqual(['aspect_ratio_changed']);
    expect(verdict.passed).toBe(false);
    expect(verdict.aspectRatioChange).toBeCloseTo(1 / 3, 10);
  });

  it('passes a small shift and fails a moved element with an unchanged count', () => {
    expect(compareFixedElements(image(), image({ window: [shiftX(WINDOW, 0.05)] })).passed).toBe(
      true,
    );

    const moved = compareFixedElements(image(), image({ window: [shiftX(WINDOW, 0.3)] }));
    expect(moved.passed).toBe(false);
    expect(moved.failedClasses).toEqual(['window']);
    const window = classReport(moved, 'window');
    expect(window.countDelta).toBe(0);
    expect(window.failures).toEqual(['unmatched_original', 'unmatched_edit']);
    expect(window.matches).toEqual([]);
    expect(window.worstMatchedIoU).toBeNull();
    // (1 - 0.3) / (1 + 0.3)
    expect(window.unmatchedOriginal[0]?.bestIoU).toBeCloseTo(0.7 / 1.3, 2);
  });

  it('rejects a moved radiator too: containment does not excuse a shift', () => {
    const verdict = compareFixedElements(image(), image({ radiator: [shiftX(RADIATOR, 0.3)] }));
    expect(verdict.failedClasses).toEqual(['radiator']);
  });

  it('accepts a partly occluded radiator or door through containment, but not a window', () => {
    // New furniture hides the lower 55% of each element: the visible box keeps the top.
    const hideLower = ({ box: b }: { box: SamBox }) =>
      box(b.x0, b.y0, b.x1, b.y0 + Math.round((b.y1 - b.y0) * 0.45));
    const verdict = compareFixedElements(
      image(),
      image({
        window: [hideLower(WINDOW)],
        door: [hideLower(DOOR)],
        radiator: [hideLower(RADIATOR)],
      }),
    );
    expect(classReport(verdict, 'radiator')).toMatchObject({ passed: true, failures: [] });
    expect(classReport(verdict, 'radiator').matches[0]).toMatchObject({
      rule: 'containment',
      containment: 1,
    });
    expect(classReport(verdict, 'door').passed).toBe(true);
    expect(classReport(verdict, 'window').failures).toEqual([
      'unmatched_original',
      'unmatched_edit',
    ]);
    expect(verdict.failedClasses).toEqual(['window']);
  });

  it('accepts an occluded radiator whose visible box grew, within the area ratio', () => {
    // The P1-05 dining-chairs case: the edit's box extends right and down (IoU ~0.52).
    const grown = box(320, 420, 580 + 120, 500 + 40);
    const verdict = compareFixedElements(image(), image({ radiator: [grown] }));
    const radiator = classReport(verdict, 'radiator');
    expect(radiator.passed).toBe(true);
    expect(radiator.matches[0]?.rule).toBe('containment');
    expect(radiator.worstMatchedIoU).toBeLessThan(DEFAULT_INTEGRITY_THRESHOLDS.minIoU);
  });

  it('rejects a radiator reduced to a sliver inside its old box (area ratio)', () => {
    const sliver = box(320, 420, 400, 500); // 31% of the original area
    const verdict = compareFixedElements(image(), image({ radiator: [sliver] }));
    expect(verdict.failedClasses).toEqual(['radiator']);
  });

  it('rejects a window resized in place (no containment path for windows)', () => {
    const smaller = box(340, 140, 560, 360); // 54% of the area, centred
    expect(compareFixedElements(image(), image({ window: [smaller] })).failedClasses).toEqual([
      'window',
    ]);
  });

  it('fails an extra element and a missing element on count and matching', () => {
    const extra = compareFixedElements(
      image(),
      image({ window: [WINDOW, box(900, 80, 1100, 380)] }),
    );
    expect(classReport(extra, 'window')).toMatchObject({
      countDelta: 1,
      failures: ['count_changed', 'unmatched_edit'],
    });
    expect(classReport(extra, 'window').unmatchedEdit).toEqual([{ index: 1, bestIoU: 0 }]);

    const twoDoors = image({ door: [DOOR, box(100, 150, 250, 650)] });
    const missing = compareFixedElements(twoDoors, image());
    expect(classReport(missing, 'door')).toMatchObject({
      originalCount: 2,
      editCount: 1,
      countDelta: -1,
      failures: ['count_changed', 'unmatched_original'],
    });
    expect(missing.failedClasses).toEqual(['door']);
  });

  it('fails a removal hidden by an addition elsewhere (same count, no match)', () => {
    const verdict = compareFixedElements(image(), image({ window: [box(900, 80, 1200, 380)] }));
    expect(classReport(verdict, 'window')).toMatchObject({
      countDelta: 0,
      failures: ['unmatched_original', 'unmatched_edit'],
    });
  });

  it('passes a class that is empty on both sides', () => {
    const verdict = compareFixedElements(image({ radiator: [] }), image({ radiator: [] }));
    expect(verdict.passed).toBe(true);
    expect(classReport(verdict, 'radiator')).toMatchObject({
      originalCount: 0,
      editCount: 0,
      matches: [],
      worstMatchedIoU: null,
      passed: true,
    });
  });

  it('pairs instances by overlap, not by output order', () => {
    const left = box(100, 100, 300, 400);
    const right = box(700, 100, 900, 400);
    const verdict = compareFixedElements(
      image({ window: [left, right] }),
      image({ window: [shiftX(right, 0.02), shiftX(left, 0.02)] }),
    );
    expect(classReport(verdict, 'window').matches.map((m) => [m.original, m.edit])).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(verdict.passed).toBe(true);
  });

  it('compares only the configured elements and uses custom thresholds', () => {
    const edit = image({ door: [], radiator: [shiftX(RADIATOR, 0.1)] });
    const verdict = compareFixedElements(image(), edit, {
      elements: [{ label: 'radiator', occlusionTolerant: false }],
      thresholds: { ...DEFAULT_INTEGRITY_THRESHOLDS, minIoU: 0.9 },
    });
    expect(verdict.classes.map((c) => c.label)).toEqual(['radiator']);
    // IoU of a 10% shift is 0.9 / 1.1 ≈ 0.82 < 0.9.
    expect(verdict.failedClasses).toEqual(['radiator']);
  });

  it('throws on invalid input instead of guessing', () => {
    const noRadiator: IntegrityImage = {
      width: 1536,
      height: 1024,
      segments: { window: [], door: [] },
    };
    expect(() => compareFixedElements(image(), noRadiator)).toThrow(IntegrityInputError);
    expect(() => compareFixedElements(image(), noRadiator)).toThrow(
      /edit has no segmentation for "radiator"/,
    );
    expect(() => compareFixedElements(image({ window: [box(10, 10, 10, 50)] }), image())).toThrow(
      /empty or outside/,
    );
    expect(() =>
      compareFixedElements(image({ window: [box(1500, 10, 1600, 50)] }), image()),
    ).toThrow(/empty or outside/);
    expect(() => compareFixedElements(image({}, 0, 1024), image())).toThrow(
      /not positive integers/,
    );
    expect(() =>
      compareFixedElements(image(), image(), {
        thresholds: { ...DEFAULT_INTEGRITY_THRESHOLDS, minIoU: 0 },
      }),
    ).toThrow(/minIoU/);
    expect(() =>
      compareFixedElements(image(), image(), {
        elements: [
          { label: 'window', occlusionTolerant: false },
          { label: 'window', occlusionTolerant: true },
        ],
      }),
    ).toThrow(/unique/);
    expect(() => compareFixedElements(image(), image(), { elements: [] })).toThrow(
      /no fixed elements/,
    );
  });
});
