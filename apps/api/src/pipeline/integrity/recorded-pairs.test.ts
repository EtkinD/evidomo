import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMetaClients } from '../../meta/clients.ts';
import { createMetaReplay } from '../../meta/replay.ts';
import type { SamBox } from '../../meta/sam-output.ts';
import { readSample, SAM, SAM_EFFORT, samCostEstimator } from '../../meta/sam-test-support.ts';
import { segmentImage, type SamSegment } from '../../meta/sam.ts';
import { createInMemoryUsageRecorder } from '../../meta/usage.ts';
import {
  compareFixedElements,
  DEFAULT_FIXED_ELEMENTS,
  DEFAULT_INTEGRITY_THRESHOLDS,
  type IntegrityImage,
  type IntegrityThresholds,
  type IntegrityVerdict,
} from './compare.ts';

// P1-07: the integrity comparison over the six recorded original/edit pairs from P1-05
// (fixtures/meta/p1-05/sam-integrity.json, replay only: this file never records). The numbers
// asserted here are the ones tabulated in docs/model-notes.md, P1-07.

const CASSETTE = 'p1-05/sam-integrity';
const PHRASES = DEFAULT_FIXED_ELEMENTS.map((e) => e.label);

const BENIGN_PAIRS = [
  ['living-empty', 'living-empty.edit-add-sofa'],
  ['living-dining-cluttered', 'living-dining-cluttered.edit-declutter-table'],
  ['bedroom-empty', 'bedroom-empty.edit-add-bed'],
  ['hallway', 'hallway.edit-add-rug-plant'],
  ['dining-chairs', 'dining-chairs.edit-replace-chairs'],
] as const;
const STRUCTURAL_PAIR = ['living-empty', 'living-empty.edit-remove-window'] as const;

/** Lowest acceptable slack of any benign matched pair against the rule that accepts it. */
const MIN_MARGIN = 0.1;

const replay = createMetaReplay({ cassette: CASSETTE, mode: 'replay' });
const images = new Map<string, IntegrityImage>();

beforeAll(async () => {
  await replay.start();
  const clients = createMetaClients({
    apiKey: replay.apiKey,
    usage: createInMemoryUsageRecorder(),
    estimateCost: samCostEstimator,
  });
  const names = new Set([...BENIGN_PAIRS.flat(), ...STRUCTURAL_PAIR]);
  for (const name of names) {
    const bytes = await readSample(name);
    const results = await Promise.all(
      PHRASES.map((phrase) =>
        segmentImage(clients, { modelId: SAM, phrase, image: bytes, reasoningEffort: SAM_EFFORT }),
      ),
    );
    const [first] = results;
    if (first === undefined) throw new Error('no phrases');
    const segments: Record<string, readonly SamSegment[]> = {};
    for (const result of results) segments[result.phrase] = result.segments;
    images.set(name, { width: first.image.width, height: first.image.height, segments });
  }
  replay.assertAllMatched();
});

afterAll(async () => {
  await replay.stop();
});

function recorded(name: string): IntegrityImage {
  const image = images.get(name);
  if (image === undefined) throw new Error(`${name} was not segmented`);
  return image;
}

function compare(
  [original, edit]: readonly [string, string],
  thresholds: IntegrityThresholds = DEFAULT_INTEGRITY_THRESHOLDS,
): IntegrityVerdict {
  return compareFixedElements(recorded(original), recorded(edit), { thresholds });
}

/** Per matched pair: how far it clears the rule that accepts it (the best of the two paths). */
function slacks(verdict: IntegrityVerdict): number[] {
  const t = verdict.thresholds;
  return verdict.classes.flatMap((report) =>
    report.matches.map((m) => {
      const iouSlack = m.iou - t.minIoU;
      const containmentSlack = Math.min(
        m.containment - t.minContainment,
        m.areaRatio - t.minAreaRatio,
      );
      return report.occlusionTolerant ? Math.max(iouSlack, containmentSlack) : iouSlack;
    }),
  );
}

function shiftedImage(image: IntegrityImage, label: string, dxFraction: number): IntegrityImage {
  const moved = (image.segments[label] ?? []).map(({ box }): { box: SamBox } => {
    const dx = Math.round((box.x1 - box.x0) * dxFraction);
    return { box: { ...box, x0: box.x0 + dx, x1: box.x1 + dx } };
  });
  return { ...image, segments: { ...image.segments, [label]: moved } };
}

describe('integrity check on the recorded P1-05 pairs', () => {
  it.each(BENIGN_PAIRS)('passes the harmless edit %s → %s', (original, edit) => {
    const verdict = compare([original, edit]);
    expect(verdict.failedClasses).toEqual([]);
    expect(verdict.failures).toEqual([]);
    expect(verdict.passed).toBe(true);
    for (const report of verdict.classes) expect(report.countDelta).toBe(0);
  });

  it('fails the window-removal edit on window only, by count', () => {
    const verdict = compare(STRUCTURAL_PAIR);
    expect(verdict.passed).toBe(false);
    expect(verdict.failedClasses).toEqual(['window']);
    const window = verdict.classes.find((c) => c.label === 'window');
    expect(window).toMatchObject({
      originalCount: 1,
      editCount: 0,
      countDelta: -1,
      failures: ['count_changed', 'unmatched_original'],
      unmatchedOriginal: [{ index: 0, bestIoU: 0 }],
    });
  });

  it('records the measured IoUs, including the two occluded radiators', () => {
    const rows = Object.fromEntries(
      BENIGN_PAIRS.map((pair) => [
        pair[1],
        Object.fromEntries(
          compare(pair).classes.map((c) => [c.label, c.worstMatchedIoU?.toFixed(2)]),
        ),
      ]),
    );
    expect(rows).toEqual({
      'living-empty.edit-add-sofa': { window: '0.96', door: '0.97', radiator: '0.94' },
      'living-dining-cluttered.edit-declutter-table': {
        window: '0.96',
        door: '0.97',
        radiator: '0.88',
      },
      'bedroom-empty.edit-add-bed': { window: '0.96', door: '0.96', radiator: '0.81' },
      'hallway.edit-add-rug-plant': { window: '0.91', door: '0.95', radiator: '0.98' },
      'dining-chairs.edit-replace-chairs': { window: '0.99', door: '0.97', radiator: '0.52' },
    });
    // The chairs radiator is the one pair only the containment path accepts.
    const chairs = compare(BENIGN_PAIRS[4]).classes.find((c) => c.label === 'radiator');
    expect(chairs?.matches[0]?.rule).toBe('containment');
    expect(chairs?.matches[0]?.containment).toBeGreaterThan(0.99);
    expect(chairs?.matches[0]?.areaRatio).toBeCloseTo(0.52, 2);
  });

  describe('sensitivity', () => {
    it(`leaves at least ${MIN_MARGIN} between every benign pair and the defaults`, () => {
      const all = BENIGN_PAIRS.flatMap((pair) => slacks(compare(pair)));
      expect(all).toHaveLength(22);
      // Worst: the chairs radiator's area ratio (0.520 vs 0.4).
      expect(Math.min(...all)).toBeCloseTo(0.12, 2);
      expect(Math.min(...all)).toBeGreaterThanOrEqual(MIN_MARGIN);
    });

    it('finds the threshold at which the first benign pair would fail', () => {
      const passesAll = (t: IntegrityThresholds) => BENIGN_PAIRS.every((p) => compare(p, t).passed);
      const highestPassing = (key: 'minIoU' | 'minContainment' | 'minAreaRatio'): number => {
        let best = 0;
        for (let value = 0.01; value <= 1.0001; value += 0.01) {
          const v = Math.round(value * 100) / 100;
          if (passesAll({ ...DEFAULT_INTEGRITY_THRESHOLDS, [key]: v })) best = v;
        }
        return best;
      };
      // minIoU breaks first on the hallway window (0.909), which has no containment path.
      expect(highestPassing('minIoU')).toBe(0.9);
      // minContainment breaks on the chairs radiator (containment 0.995).
      expect(highestPassing('minContainment')).toBe(0.99);
      // minAreaRatio breaks on the chairs radiator (area ratio 0.5199).
      expect(highestPassing('minAreaRatio')).toBe(0.51);
      // Hallway edit without `size`: 1.49% aspect change.
      expect(compare(BENIGN_PAIRS[3]).aspectRatioChange).toBeCloseTo(0.0149, 4);
    });

    it('fails the structural edit for every threshold setting (the count decides)', () => {
      for (let v = 0.05; v <= 1.0001; v += 0.05) {
        const value = Math.round(v * 100) / 100;
        const t: IntegrityThresholds = {
          minIoU: value,
          minContainment: value,
          minAreaRatio: value,
          maxAspectRatioChange: 1,
        };
        const verdict = compare(STRUCTURAL_PAIR, t);
        expect(verdict.passed).toBe(false);
        expect(verdict.failedClasses).toContain('window');
      }
    });

    it.each(PHRASES)(
      'detects a recorded %s moved sideways by 20% of its width, not by 5%',
      (label) => {
        const [original, edit] = BENIGN_PAIRS[0];
        const passesAt = (dx: number) =>
          compareFixedElements(recorded(original), shiftedImage(recorded(edit), label, dx)).passed;
        expect(passesAt(0.05)).toBe(true);
        expect(passesAt(0.2)).toBe(false);
        expect(passesAt(-0.2)).toBe(false);
      },
    );
  });
});
