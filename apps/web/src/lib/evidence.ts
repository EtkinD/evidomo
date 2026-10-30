import { withDisplayUnit, type ImageRegion, type JsonValue } from '@evidomo/shared';
import { humanize } from './project-view';

/** `mm:ss` of a position in the recording; minutes keep counting past 59. */
export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** The label of a fact key: `other:station_distance` reads "Station distance". */
export function keyLabel(key: string): string {
  return humanize(key.startsWith('other:') ? key.slice('other:'.length) : key);
}

/** A stored fact value as a person reads it: units and basis follow the number. */
export function formatFactValue(
  value: JsonValue,
  unit: string | null,
  basis: string | null,
  basisLabel?: (basisId: string) => string | undefined,
): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // The same unit display as the exported pack (`withDisplayUnit` in @evidomo/shared).
  const withUnit = withDisplayUnit(text, unit);
  if (basis === null) return withUnit;
  return `${withUnit} (${basisLabel?.(basis) ?? basis})`;
}

/** The aspect ratio of the photo frame. The API does not send photo dimensions, so it is fixed. */
export const PHOTO_FRAME_ASPECT = 4 / 3;

export interface FrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a region sits inside a frame that shows the photo with `object-fit: contain`, as
 * percentages of the frame. A photo with another aspect ratio than the frame leaves bars; the
 * region is relative to the photo, not the frame.
 */
export function regionInFrame(
  region: ImageRegion,
  imageAspect: number,
  frameAspect: number = PHOTO_FRAME_ASPECT,
): FrameBox {
  const widthShare = imageAspect > frameAspect ? 1 : imageAspect / frameAspect;
  const heightShare = imageAspect > frameAspect ? frameAspect / imageAspect : 1;
  const offsetX = (1 - widthShare) / 2;
  const offsetY = (1 - heightShare) / 2;
  return {
    left: (offsetX + region.x * widthShare) * 100,
    top: (offsetY + region.y * heightShare) * 100,
    width: region.width * widthShare * 100,
    height: region.height * heightShare * 100,
  };
}
