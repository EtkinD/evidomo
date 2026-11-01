import sharp from 'sharp';
import { isEnvironmentError } from '../media/upload-error.ts';

// Print-sized derivatives of the exported images, embedded in the HTML pack only (the exported
// image files and `portal-fields.json` keep the full-size bytes). Why: a browser that prints the
// pack decodes every embedded JPEG; Firefox (and likely Safari) then writes raw Flate pixels into
// the PDF, so the PDF grows with pixel count, not JPEG bytes (a 21-photo pack printed to ~100 MB).
//
// Size: every pack photo prints in one grid column, `(180 mm - 4 mm gap) / 2 = 88 mm` wide
// whatever its orientation (`img{width:100%}`), also the staged/original pairs. The width is
// capped at 800 px (about 230 dpi at 88 mm), not 1040 px (300 dpi): measured on a real 21-photo
// pack, Firefox's PDF image data is 101 MB at 2048 px, 33 MB at 1040 px, and 20 MB at 800 px, and
// a pack that stays under common 25 MB mail limits matters more than print sharpness past 230 dpi.
// A taller portrait photo just gets taller. A photo that is not wider is embedded unchanged.
//
// The derivative is made from the already blurred and labelled export bytes, so the privacy blur
// and the burned-in "Virtually staged" badge survive by construction. Output is deterministic
// for one sharp/libvips build, like the other exported images.

/** 88 mm print column at about 230 dpi. */
export const PACK_IMAGE_MAX_WIDTH_PX = 800;

/** Print-sized JPEG quality: q80 mozjpeg is visually transparent for 88 mm prints. */
export const PACK_IMAGE_QUALITY = 80;

/** The exported image could not be re-encoded for the pack. */
export class PackImageError extends Error {
  override name = 'PackImageError';
}

/**
 * The HTML pack's copy of an exported JPEG. An image at most `maxWidthPx` wide (the constant
 * above; only tests pass another) is returned as is (re-encoding it would only lose quality). A wider one is scaled down to that
 * width and re-encoded (sRGB JPEG, mozjpeg, q80, no metadata). The input has no EXIF orientation
 * (the upload and export pipelines strip it), so its pixels are used as stored.
 */
export async function packImage(
  jpeg: Uint8Array,
  maxWidthPx: number = PACK_IMAGE_MAX_WIDTH_PX,
): Promise<Uint8Array> {
  try {
    const { width } = await sharp(jpeg, { failOn: 'error' }).metadata();
    if (width === undefined) throw new PackImageError('An exported image has no width');
    if (width <= maxWidthPx) return jpeg;
    const encoded = await sharp(jpeg, { failOn: 'error' })
      .resize({ width: maxWidthPx, fit: 'inside' })
      .toColourspace('srgb')
      .removeAlpha()
      .jpeg({ quality: PACK_IMAGE_QUALITY, mozjpeg: true })
      .toBuffer();
    return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  } catch (error) {
    if (error instanceof PackImageError) throw error;
    if (isEnvironmentError(error)) throw error;
    throw new PackImageError('An exported image could not be re-encoded for the pack', {
      cause: error,
    });
  }
}
