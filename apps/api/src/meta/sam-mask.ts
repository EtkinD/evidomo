import { decodeMaskToRaster, InvalidSegmentationMaskError } from '@meta-sam/parser';

/**
 * SAM 3.1 mask decoding (docs/model-notes.md, P1-05).
 *
 * Meta's docs specify the mask token (`data=<H>,<W>,<enc><payload>`, base85, `!` = one_bit,
 * `~` = lossless) but not the payload codec. Decoding is delegated to Meta's official parser,
 * `@meta-sam/parser` (SAM License), installed as a dependency. This module only adapts types and
 * errors; it contains no codec logic of its own.
 */

export class SamMaskError extends Error {
  override name = 'SamMaskError';
}

export type SamMaskEncoding = 'one_bit' | 'lossless';

/** One mask as it appears on the wire. The raster covers the instance's box, 1:1 in pixels. */
export interface SamEncodedMask {
  readonly encoding: SamMaskEncoding;
  /** Raster columns (equals the box width). */
  readonly width: number;
  /** Raster rows (equals the box height). */
  readonly height: number;
  /**
   * The payload **including** its encoding marker (`!` or `~`). `@meta-sam/parser@0.1.0`
   * expects the same despite its type comment ("text after the encoding marker"): its decoder
   * checks the marker, and a marker-less payload fails (verified on all recorded masks).
   */
  readonly payload: string;
}

/**
 * Decodes a mask to a row-major `Uint8Array` of 0/1 values, `width * height` long, covering the
 * instance's box (pixel (0, 0) is the box's top-left corner). The parser validates the payload
 * strictly (marker, base85 shape, decoder finalization); any rejection surfaces as
 * `SamMaskError` with the parser's error as `cause`.
 */
export function decodeSamMask(mask: SamEncodedMask): Uint8Array {
  let raster: Uint8Array;
  try {
    raster = decodeMaskToRaster(mask);
  } catch (error) {
    if (error instanceof InvalidSegmentationMaskError) {
      throw new SamMaskError(`Invalid SAM mask: ${error.message}`, { cause: error });
    }
    throw error;
  }
  // The parser guarantees this; checked anyway because callers index the raster by width.
  if (raster.length !== mask.width * mask.height) {
    throw new SamMaskError(
      `Decoded mask has ${raster.length} pixels, expected ${mask.width * mask.height}`,
    );
  }
  return raster;
}

/** Number of foreground pixels in a decoded raster. */
export function maskArea(raster: Uint8Array): number {
  let area = 0;
  for (const value of raster) area += value;
  return area;
}
