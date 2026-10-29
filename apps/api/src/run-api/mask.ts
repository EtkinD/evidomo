import { RUN_FACT_MASK_PNG, type InventoryPhoto, type SamRegion } from '@evidomo/shared';
import sharp from 'sharp';
import { decodeSamMask, SamMaskError } from '../meta/sam-mask.ts';

// The mask overlay of a `photo_region` fact (docs/architecture.md §5 "Run API"): SAM masks are
// box-local one-bit rasters (`decodeSamMask`); the overlay places each at its box in the stored
// photo's frame, so the PNG lines up with the photo file pixel for pixel.

export type MaskLayerResult =
  | {
      readonly kind: 'rendered';
      readonly width: number;
      readonly height: number;
      /** RGBA, `width * height * 4` bytes. */
      readonly rgba: Uint8Array;
      /** Regions drawn, and regions skipped because their mask was unusable. */
      readonly drawn: number;
      readonly skipped: number;
    }
  | { readonly kind: 'empty'; readonly skipped: number };

function usableRaster(region: SamRegion, width: number, height: number): Uint8Array | undefined {
  const { box, mask } = region;
  if (mask === null) return undefined;
  const fits =
    box.x1 <= width &&
    box.y1 <= height &&
    mask.width === box.x1 - box.x0 &&
    mask.height === box.y1 - box.y0;
  if (!fits) return undefined;
  try {
    return decodeSamMask(mask);
  } catch (error) {
    if (error instanceof SamMaskError) return undefined;
    throw error;
  }
}

/**
 * The union of the regions' masks in a `width × height` frame. A region without a mask (beyond
 * the run's mask cap), with a box outside the frame, a raster that is not its box's size, or a
 * payload that does not decode is skipped, as the export treats such regions as unreadable;
 * `empty` when nothing could be drawn.
 */
export function renderMaskLayer(
  width: number,
  height: number,
  regions: readonly SamRegion[],
): MaskLayerResult {
  const rgba = new Uint8Array(width * height * 4);
  const [r, g, b, a] = RUN_FACT_MASK_PNG.maskRgba;
  let drawn = 0;
  let skipped = 0;
  for (const region of regions) {
    const raster = usableRaster(region, width, height);
    if (raster === undefined) {
      skipped += 1;
      continue;
    }
    const { box } = region;
    const boxWidth = box.x1 - box.x0;
    for (let y = 0; y < box.y1 - box.y0; y += 1) {
      for (let x = 0; x < boxWidth; x += 1) {
        if (raster[y * boxWidth + x] !== 1) continue;
        const i = ((box.y0 + y) * width + box.x0 + x) * 4;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = a;
      }
    }
    drawn += 1;
  }
  return drawn === 0
    ? { kind: 'empty', skipped }
    : { kind: 'rendered', width, height, rgba, drawn, skipped };
}

/** The regions of the observation a photo fact came from (`fact.key` = observation key). */
export function observationRegions(photo: InventoryPhoto, factKey: string): readonly SamRegion[] {
  return (
    photo.observations.find((observation) => observation.key === factKey)?.evidence.regions ?? []
  );
}

/** PNG-encodes a rendered layer (sharp, off the event loop). */
export async function encodeMaskPng(
  layer: Extract<MaskLayerResult, { kind: 'rendered' }>,
): Promise<Buffer> {
  return sharp(layer.rgba, { raw: { width: layer.width, height: layer.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
