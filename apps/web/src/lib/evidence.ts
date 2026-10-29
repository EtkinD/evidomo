import type { ImageRegion, JsonValue } from '@evidomo/shared';
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

// The same mapping as the pack's HTML export (apps/api/src/export/html.ts `UNIT_DISPLAY`); the
// API owns that copy, so a shared home for both is a follow-up for the backend.
const UNIT_DISPLAY: Readonly<Record<string, string>> = {
  m2: 'm²',
  sq_ft: 'sq ft',
  m3: 'm³',
  cu_ft: 'cu ft',
};

/** A stored unit as a person reads it: `m2` is `m²`. */
export function displayUnit(unit: string): string {
  return UNIT_DISPLAY[unit] ?? unit;
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
  const withUnit =
    unit === null ? text : unit === 'EUR' ? `€ ${text}` : `${text} ${displayUnit(unit)}`;
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
