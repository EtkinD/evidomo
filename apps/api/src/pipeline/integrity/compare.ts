import { boxIoU, type SamBox } from '../../meta/sam-output.ts';

/**
 * Structural integrity comparison of an original photo and its staged edit (architecture §5,
 * step 6; thresholds and evidence in docs/model-notes.md, P1-07). Pure: no I/O, no model calls.
 * The caller segments both images (SAM 3.1, one phrase per fixed-element class) and passes the
 * boxes here.
 *
 * Rules, per fixed-element class:
 *
 * 1. Both images are mapped to the unit square (x / width, y / height), which equals resizing
 *    both to one common frame. Muse Image renders at its own resolution and may shift the aspect
 *    ratio slightly (P1-06), so an aspect change above `maxAspectRatioChange` fails the image:
 *    positions are not comparable after a crop or a large stretch.
 * 2. The instance count must not change (the primary signal: removing a window is caught here).
 * 3. Every original instance must be matched one-to-one with an edit instance (catches a moved
 *    element, or one removed while another appears). A pair matches when its box IoU is at least
 *    `minIoU`, or, for occlusion-tolerant classes only, when one box lies inside the other
 *    (intersection over the smaller box ≥ `minContainment`) and the smaller box keeps at least
 *    `minAreaRatio` of the larger one's area. New furniture in front of a radiator shrinks or
 *    reshapes its visible box; IoU alone rejected such legitimate edits (0.52 measured).
 *
 * Matching is greedy by IoU (ties by containment, then index). It can only miss a valid
 * assignment, never invent one, so its failure mode is a false rejection, not a false pass.
 */

export class IntegrityInputError extends Error {
  override name = 'IntegrityInputError';
}

/** One segmented instance; `SamSegment` from `meta/sam.ts` satisfies this. */
export interface IntegritySegment {
  /** Half-open box in the pixels of its own image. */
  readonly box: SamBox;
}

export interface IntegrityImage {
  readonly width: number;
  readonly height: number;
  /**
   * Instances per fixed-element label (the SAM phrase). Every compared label must be present on
   * both sides; an empty array means "segmented, none found". Other labels are ignored.
   */
  readonly segments: Readonly<Record<string, readonly IntegritySegment[]>>;
}

export interface IntegrityThresholds {
  /** A pair whose box IoU (in the common frame) reaches this is the same element. */
  readonly minIoU: number;
  /** Occlusion path: intersection area over the smaller box's area. */
  readonly minContainment: number;
  /** Occlusion path: smaller box area over larger box area. */
  readonly minAreaRatio: number;
  /** Largest accepted relative change of width/height between original and edit. */
  readonly maxAspectRatioChange: number;
}

/**
 * Chosen in P1-07 from 6 synthetic pairs (docs/model-notes.md, P1-07): every benign matched pair
 * clears the rule that accepts it by at least 0.12 (worst: an occluded radiator's area ratio,
 * 0.52 vs 0.4), and the structure-altering edit fails on its count whatever the thresholds.
 * Geometrically, `minIoU` 0.75 and `minContainment` 0.85 both reject an equal-size box shifted
 * by more than about 15% of its own width.
 */
export const DEFAULT_INTEGRITY_THRESHOLDS = {
  minIoU: 0.75,
  minContainment: 0.85,
  minAreaRatio: 0.4,
  maxAspectRatioChange: 0.03,
} as const satisfies IntegrityThresholds;

export interface FixedElementRule {
  /** The SAM phrase and the key into `IntegrityImage.segments`. */
  readonly label: string;
  /** Whether staged furniture may legitimately hide part of it (enables the containment path). */
  readonly occlusionTolerant: boolean;
}

/**
 * Windows sit above furniture height and were never occluded in the measured edits (IoU ≥ 0.91),
 * so they get no containment path: a window shrunk or enlarged in place then fails on IoU.
 * Radiators (low, behind beds and chairs) and doors (sofas, beds against the wall) do.
 */
export const DEFAULT_FIXED_ELEMENTS: readonly FixedElementRule[] = [
  { label: 'window', occlusionTolerant: false },
  { label: 'door', occlusionTolerant: true },
  { label: 'radiator', occlusionTolerant: true },
];

export interface IntegrityOptions {
  readonly thresholds?: IntegrityThresholds;
  readonly elements?: readonly FixedElementRule[];
}

export interface IntegrityMatch {
  /** Index into the original's `segments[label]`. */
  readonly original: number;
  /** Index into the edit's `segments[label]`. */
  readonly edit: number;
  readonly iou: number;
  readonly containment: number;
  readonly areaRatio: number;
  /** Which rule accepted the pair. */
  readonly rule: 'iou' | 'containment';
}

export interface IntegrityUnmatched {
  readonly index: number;
  /** Highest IoU with any instance on the other side (0 when that side is empty). */
  readonly bestIoU: number;
}

export type IntegrityClassFailure = 'count_changed' | 'unmatched_original' | 'unmatched_edit';

export interface IntegrityClassReport {
  readonly label: string;
  readonly occlusionTolerant: boolean;
  readonly originalCount: number;
  readonly editCount: number;
  /** `editCount - originalCount`. */
  readonly countDelta: number;
  readonly matches: readonly IntegrityMatch[];
  readonly unmatchedOriginal: readonly IntegrityUnmatched[];
  readonly unmatchedEdit: readonly IntegrityUnmatched[];
  /** Lowest IoU among accepted pairs; `null` without matches. */
  readonly worstMatchedIoU: number | null;
  readonly passed: boolean;
  readonly failures: readonly IntegrityClassFailure[];
}

export type IntegrityImageFailure = 'aspect_ratio_changed';

export interface IntegrityVerdict {
  readonly passed: boolean;
  /** `|aspect(edit) / aspect(original) - 1|`. */
  readonly aspectRatioChange: number;
  readonly failures: readonly IntegrityImageFailure[];
  /** Labels whose class report failed, in element order. */
  readonly failedClasses: readonly string[];
  readonly classes: readonly IntegrityClassReport[];
  readonly thresholds: IntegrityThresholds;
}

interface UnitBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

function isPositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function assertThresholds(t: IntegrityThresholds): void {
  for (const key of ['minIoU', 'minContainment', 'minAreaRatio'] as const) {
    const value = t[key];
    if (!(value > 0 && value <= 1)) {
      throw new IntegrityInputError(`threshold ${key} must be in (0, 1], got ${value}`);
    }
  }
  if (!(t.maxAspectRatioChange >= 0 && Number.isFinite(t.maxAspectRatioChange))) {
    throw new IntegrityInputError(
      `threshold maxAspectRatioChange must be a finite number ≥ 0, got ${t.maxAspectRatioChange}`,
    );
  }
}

function toUnitBoxes(
  image: IntegrityImage,
  label: string,
  side: 'original' | 'edit',
): readonly UnitBox[] {
  const segments = image.segments[label];
  if (segments === undefined) {
    throw new IntegrityInputError(`${side} has no segmentation for "${label}"`);
  }
  return segments.map(({ box }, index) => {
    const { x0, y0, x1, y1 } = box;
    const valid =
      [x0, y0, x1, y1].every(Number.isFinite) &&
      x0 >= 0 &&
      y0 >= 0 &&
      x0 < x1 &&
      y0 < y1 &&
      x1 <= image.width &&
      y1 <= image.height;
    if (!valid) {
      throw new IntegrityInputError(
        `${side} "${label}" #${index}: box (${x0},${y0})-(${x1},${y1}) is empty or outside ${image.width}x${image.height}`,
      );
    }
    return {
      x0: x0 / image.width,
      y0: y0 / image.height,
      x1: x1 / image.width,
      y1: y1 / image.height,
    };
  });
}

function area(box: UnitBox): number {
  return (box.x1 - box.x0) * (box.y1 - box.y0);
}

function intersection(a: UnitBox, b: UnitBox): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

function compareClass(
  rule: FixedElementRule,
  original: readonly UnitBox[],
  edit: readonly UnitBox[],
  t: IntegrityThresholds,
): IntegrityClassReport {
  const candidates: IntegrityMatch[] = [];
  const bestOriginal = original.map(() => 0);
  const bestEdit = edit.map(() => 0);
  original.forEach((a, i) => {
    edit.forEach((b, j) => {
      const iou = boxIoU(a, b);
      bestOriginal[i] = Math.max(bestOriginal[i] ?? 0, iou);
      bestEdit[j] = Math.max(bestEdit[j] ?? 0, iou);
      const areaA = area(a);
      const areaB = area(b);
      const containment = intersection(a, b) / Math.min(areaA, areaB);
      const areaRatio = Math.min(areaA, areaB) / Math.max(areaA, areaB);
      if (iou >= t.minIoU) {
        candidates.push({ original: i, edit: j, iou, containment, areaRatio, rule: 'iou' });
      } else if (
        rule.occlusionTolerant &&
        containment >= t.minContainment &&
        areaRatio >= t.minAreaRatio
      ) {
        candidates.push({ original: i, edit: j, iou, containment, areaRatio, rule: 'containment' });
      }
    });
  });

  candidates.sort(
    (p, q) =>
      q.iou - p.iou || q.containment - p.containment || p.original - q.original || p.edit - q.edit,
  );
  const usedOriginal = new Set<number>();
  const usedEdit = new Set<number>();
  const matches: IntegrityMatch[] = [];
  for (const pair of candidates) {
    if (usedOriginal.has(pair.original) || usedEdit.has(pair.edit)) continue;
    usedOriginal.add(pair.original);
    usedEdit.add(pair.edit);
    matches.push(pair);
  }
  matches.sort((p, q) => p.original - q.original);

  const unmatchedOriginal = original
    .map((_, index) => ({ index, bestIoU: bestOriginal[index] ?? 0 }))
    .filter(({ index }) => !usedOriginal.has(index));
  const unmatchedEdit = edit
    .map((_, index) => ({ index, bestIoU: bestEdit[index] ?? 0 }))
    .filter(({ index }) => !usedEdit.has(index));

  const failures: IntegrityClassFailure[] = [];
  const countDelta = edit.length - original.length;
  if (countDelta !== 0) failures.push('count_changed');
  if (unmatchedOriginal.length > 0) failures.push('unmatched_original');
  if (unmatchedEdit.length > 0) failures.push('unmatched_edit');

  return {
    label: rule.label,
    occlusionTolerant: rule.occlusionTolerant,
    originalCount: original.length,
    editCount: edit.length,
    countDelta,
    matches,
    unmatchedOriginal,
    unmatchedEdit,
    worstMatchedIoU: matches.length === 0 ? null : Math.min(...matches.map((m) => m.iou)),
    passed: failures.length === 0,
    failures,
  };
}

/**
 * Compares the fixed elements of an original and its edit. Throws `IntegrityInputError` for
 * invalid input (bad dimensions or boxes, a compared label missing on either side, duplicate
 * labels, thresholds out of range); a structural difference is a failed verdict, not an error.
 */
export function compareFixedElements(
  original: IntegrityImage,
  edit: IntegrityImage,
  options: IntegrityOptions = {},
): IntegrityVerdict {
  const thresholds = options.thresholds ?? DEFAULT_INTEGRITY_THRESHOLDS;
  const elements = options.elements ?? DEFAULT_FIXED_ELEMENTS;
  assertThresholds(thresholds);
  for (const [side, image] of [
    ['original', original],
    ['edit', edit],
  ] as const) {
    if (!isPositiveInt(image.width) || !isPositiveInt(image.height)) {
      throw new IntegrityInputError(
        `${side} dimensions ${image.width}x${image.height} are not positive integers`,
      );
    }
  }
  if (elements.length === 0) throw new IntegrityInputError('no fixed elements to compare');
  const labels = new Set(elements.map((e) => e.label));
  if (labels.size !== elements.length) {
    throw new IntegrityInputError('fixed element labels must be unique');
  }

  const aspectRatioChange = Math.abs(
    edit.width / edit.height / (original.width / original.height) - 1,
  );
  const failures: IntegrityImageFailure[] =
    aspectRatioChange > thresholds.maxAspectRatioChange ? ['aspect_ratio_changed'] : [];

  const classes = elements.map((rule) =>
    compareClass(
      rule,
      toUnitBoxes(original, rule.label, 'original'),
      toUnitBoxes(edit, rule.label, 'edit'),
      thresholds,
    ),
  );
  const failedClasses = classes.filter((c) => !c.passed).map((c) => c.label);

  return {
    passed: failures.length === 0 && failedClasses.length === 0,
    aspectRatioChange,
    failures,
    failedClasses,
    classes,
    thresholds,
  };
}
