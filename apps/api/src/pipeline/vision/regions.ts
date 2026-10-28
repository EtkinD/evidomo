import { imageRegionSchema, type ImageRegion, type SamRegion } from '@evidomo/shared';
import type { SamBox } from '../../meta/sam-output.ts';
import type { SamSegment } from '../../meta/sam.ts';

// SAM boxes (pixels of the stored photo, half-open) → normalized regions for `facts.source_ref`
// (`imageRegionSchema`: 0..1, inside the image). Coordinates are rounded inward to millionths in
// integer arithmetic, so the float sum `x + width` can never exceed 1.

const SCALE = 1_000_000;

/** The whole photo: the region of a photo fact that has no segmented instance. */
export const WHOLE_IMAGE: ImageRegion = { x: 0, y: 0, width: 1, height: 1 };

function axis(start: number, end: number, size: number): { offset: number; length: number } {
  const from = Math.floor((start * SCALE) / size);
  const to = Math.min(SCALE, Math.floor((end * SCALE) / size));
  let length = Math.max(1, to - from);
  while (length > 1 && from / SCALE + length / SCALE > 1) length -= 1;
  return { offset: from / SCALE, length: length / SCALE };
}

export class RegionError extends Error {
  override name = 'RegionError';
}

/** Normalizes a pixel box; throws when the box is empty or outside the image. */
export function toRegion(box: SamBox, width: number, height: number): ImageRegion {
  if (box.x0 < 0 || box.y0 < 0 || box.x1 > width || box.y1 > height) {
    throw new RegionError('Box lies outside the image');
  }
  if (box.x1 <= box.x0 || box.y1 <= box.y0) throw new RegionError('Box is empty');
  const x = axis(box.x0, box.x1, width);
  const y = axis(box.y0, box.y1, height);
  return imageRegionSchema.parse({ x: x.offset, y: y.offset, width: x.length, height: y.length });
}

/** The smallest box containing every box; undefined for none. */
export function unionBox(boxes: readonly SamBox[]): SamBox | undefined {
  const [first, ...rest] = boxes;
  if (first === undefined) return undefined;
  return rest.reduce<SamBox>(
    (acc, box) => ({
      x0: Math.min(acc.x0, box.x0),
      y0: Math.min(acc.y0, box.y0),
      x1: Math.max(acc.x1, box.x1),
      y1: Math.max(acc.y1, box.y1),
    }),
    first,
  );
}

/** One stored instance; `keepMask: false` drops the payload (evidence beyond the mask cap). */
export function toStoredRegion(
  segment: SamSegment,
  width: number,
  height: number,
  keepMask: boolean,
): SamRegion {
  return {
    objectId: segment.objectId,
    score: segment.score ?? null,
    box: { ...segment.box },
    region: toRegion(segment.box, width, height),
    mask: keepMask
      ? {
          encoding: segment.mask.encoding,
          width: segment.mask.width,
          height: segment.mask.height,
          payload: segment.mask.payload,
        }
      : null,
  };
}
